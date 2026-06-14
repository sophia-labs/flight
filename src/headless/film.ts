// Pilot-cam film exporter. Flies a match (scripted or a live model via pi-ai/OpenRouter), then
// renders an mp4 of what the pilot's nose-camera "sees".
//
// Two looks:
//   default   — the camera-ascii viewport + subtitles on black (cheap, no WebGL).
//   --cinema  — split screen: LEFT = the real 3D world from the TRUE mounted-camera pose with the
//               ascii viewport overlaid as a translucent HUD; RIGHT = an orbiting chase view.
// In both, the camera is re-sensed from the INTERPOLATED replay frames (the sensor is pure), so the
// view animates smoothly at the render fps, and the model's per-turn rationale is the subtitle.
//
//   npm run film -- --scripted                          # free dev pass (ascii), no API key
//   npm run film -- --scripted --cinema                 # free dev pass (3D), no API key
//   npm run film -- deepseek/deepseek-v4-flash --cinema  # live; writes film.mp4
//   npm run film -- <model> --cinema --out clips/run.mp4
//   env: FILM_TURNS (16), FILM_FPS (30), FILM_MODE (raw-stick|setpoint, default setpoint)
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { chromium } from "@playwright/test";
import { actionSpecs, type ActionMode } from "../agent/actionSpec";
import { FLIGHT_RULES, piController, resolveOpenRouterModel } from "../agent/controllers/pi";
import { defensiveController, pursuitController, pursuitFallback } from "../agent/controllers/scripted";
import { perfectSensor } from "../agent/observation";
import { senseAndEncode } from "../agent/perception";
import { competenceEvaluator } from "../eval/outcome";
import type { AircraftSnapshot, MatchReplay, Quaternion } from "../protocol/schema";
import type { MatchConfig } from "../runtime/config";
import { runMatch } from "../runtime/match";
import { FRAME_DT, TURN_DURATION, createInitialAircraft, noseCamera } from "../runtime/scenario";
import { DEFAULT_MODEL } from "../sim/flight";
import { add, basisFromQuat, lerp, quatMultiply, quatNormalize, rotateVec } from "../sim/math";
import type { AircraftState } from "../sim/types";

const PILOT_ID = "blue-1";
const RAD2DEG = 180 / Math.PI;

// Cinema canvas layout (kept in sync with the page below).
const H = 640;
const WL = 720; // pilot viewport (left)
const WR = 560; // orbit viewport (right)
const PILOT_ASPECT = WL / H;

// ---- args ----
const argv = process.argv.slice(2);
const scripted = argv.includes("--scripted");
const cinema = argv.includes("--cinema");
const outIdx = argv.indexOf("--out");
const out = outIdx >= 0 ? argv[outIdx + 1] : "film.mp4";
const model =
  argv.find((a, i) => !a.startsWith("--") && (outIdx < 0 || i !== outIdx + 1)) ??
  "deepseek/deepseek-chat-v3.1";
const turns = Number(process.env.FILM_TURNS ?? 16);
const fps = Number(process.env.FILM_FPS ?? 30);
const mode = (process.env.FILM_MODE ?? "setpoint") as ActionMode;
const label = scripted ? "Pursuit" : (model.split("/").pop() ?? model);

function buildConfig(): MatchConfig {
  const blue = scripted
    ? pursuitController(0.82)
    : piController({ slug: model, spec: actionSpecs[mode], rules: FLIGHT_RULES });
  return {
    id: `film|${scripted ? "scripted" : model}|${mode}`,
    turnDuration: TURN_DURATION,
    frameDt: FRAME_DT,
    maxTurns: turns,
    decisionTimeoutMs: 30_000,
    initialAircraft: createInitialAircraft(),
    sensor: perfectSensor,
    evaluator: competenceEvaluator,
    fallback: pursuitFallback,
    agents: {
      "blue-1": {
        meta: { id: "blue-1", kind: scripted ? "scripted" : "llm", label: scripted ? "pursuit" : `${model}/${mode}` },
        controller: blue,
      },
      "red-1": { meta: { id: "red-1", kind: "scripted", label: "defensive" }, controller: defensiveController(0.64) },
    },
  };
}

// ---- interpolation: rebuild a sense-able AircraftState world at an arbitrary time ----
function fromSnapshot(s: AircraftSnapshot): AircraftState {
  return {
    id: s.id,
    callsign: s.callsign,
    team: s.team,
    color: s.color,
    position: s.position,
    velocity: s.velocity,
    orientation: s.orientation,
    controls: s.controls,
    health: s.health,
    weaponCooldown: s.weaponCooldown,
    model: DEFAULT_MODEL,
    metrics: { airspeed: s.airspeed, altitude: s.altitude, aoaDeg: s.aoaDeg, gLoad: s.gLoad, stalled: s.stalled },
    devices: [noseCamera()],
  };
}

function nlerpQuat(a: Quaternion, b: Quaternion, t: number): Quaternion {
  const s = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w < 0 ? -1 : 1; // shortest arc
  return quatNormalize({
    x: a.x + (b.x * s - a.x) * t,
    y: a.y + (b.y * s - a.y) * t,
    z: a.z + (b.z * s - a.z) * t,
    w: a.w + (b.w * s - a.w) * t,
  });
}

function interpAircraft(a: AircraftState, b: AircraftState, t: number): AircraftState {
  return {
    ...a,
    position: { x: lerp(a.position.x, b.position.x, t), y: lerp(a.position.y, b.position.y, t), z: lerp(a.position.z, b.position.z, t) },
    velocity: { x: lerp(a.velocity.x, b.velocity.x, t), y: lerp(a.velocity.y, b.velocity.y, t), z: lerp(a.velocity.z, b.velocity.z, t) },
    orientation: nlerpQuat(a.orientation, b.orientation, t),
    health: lerp(a.health, b.health, t),
  };
}

interface ShipView {
  id: string;
  color: string;
  x: number; y: number; z: number;
  qx: number; qy: number; qz: number; qw: number;
  stalled: boolean;
  alive: boolean;
}

interface FilmFrame {
  cam: string;
  sub: string;
  hud: string;
  // cinema-only payload (ignored by the ascii renderer):
  selfId: string;
  aircraft: ShipView[];
  eye: { x: number; y: number; z: number };
  fwd: { x: number; y: number; z: number };
  up: { x: number; y: number; z: number };
  fovDeg: number;
  angle: number;
}

function buildFrames(replay: MatchReplay): FilmFrame[] {
  const frames = replay.frames;
  const duration = frames[frames.length - 1].time;
  const total = Math.max(1, Math.floor(duration * fps));
  const device = noseCamera();
  const hFovRad = device.optics?.hFovRad ?? Math.PI / 3;
  const fovDeg = 2 * Math.atan(Math.tan(hFovRad / 2) / PILOT_ASPECT) * RAD2DEG; // pilot vertical fov

  const rationaleByTurn = new Map<number, string>();
  for (const d of replay.decisions ?? []) {
    if (d.agentId === PILOT_ID && d.rationale) rationaleByTurn.set(d.turn, d.rationale);
  }

  const result: FilmFrame[] = [];
  let seg = 0;
  for (let k = 0; k <= total; k += 1) {
    const t = k / fps;
    while (seg < frames.length - 2 && frames[seg + 1].time <= t) seg += 1;
    const fa = frames[seg];
    const fb = frames[Math.min(seg + 1, frames.length - 1)];
    const span = fb.time - fa.time;
    const alpha = span > 1e-9 ? Math.max(0, Math.min(1, (t - fa.time) / span)) : 0;

    const world = fa.aircraft.map((sa) => {
      const sb = fb.aircraft.find((s) => s.id === sa.id) ?? sa;
      return interpAircraft(fromSnapshot(sa), fromSnapshot(sb), alpha);
    });
    const self = world.find((s) => s.id === PILOT_ID) ?? world[0];

    // True mounted-camera pose (matches what the sensor projects from).
    const camOrient = quatMultiply(self.orientation, device.pose.rotation);
    const b = basisFromQuat(camOrient);
    const eye = add(self.position, rotateVec(self.orientation, device.pose.offset));

    const percept = senseAndEncode(device, world, self);
    result.push({
      cam: percept.text ?? "",
      sub: rationaleByTurn.get(fa.turn) ?? "",
      hud: `NOSE-CAM   turn ${fa.turn}/${turns}   t=${t.toFixed(1)}s`,
      selfId: self.id,
      aircraft: world.map((s) => ({
        id: s.id,
        color: s.color,
        x: s.position.x, y: s.position.y, z: s.position.z,
        qx: s.orientation.x, qy: s.orientation.y, qz: s.orientation.z, qw: s.orientation.w,
        stalled: s.metrics.stalled,
        alive: s.health > 0,
      })),
      eye,
      fwd: b.forward,
      up: b.up,
      fovDeg,
      angle: t * 0.22, // slow orbit
    });
  }
  return result;
}

function ffmpeg(): ReturnType<typeof spawn> {
  return spawn(
    "ffmpeg",
    ["-y", "-f", "image2pipe", "-framerate", String(fps), "-i", "-",
     "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out],
    { stdio: ["pipe", "ignore", "ignore"] },
  );
}

// ---------- ascii-only renderer ----------
const ASCII_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;height:100%;background:#05070a;}
  #wrap{display:flex;flex-direction:column;align-items:center;height:100vh;padding:16px 0;box-sizing:border-box;
        font-family:'SFMono-Regular',Menlo,Consolas,'Liberation Mono',monospace;}
  #hud{color:#5f7d8c;font-size:13px;letter-spacing:1px;margin-bottom:10px;text-transform:uppercase;}
  #cam{color:#7CFC9A;font-size:16px;line-height:1.15;white-space:pre;margin:0;text-shadow:0 0 6px rgba(124,252,154,.35);}
  #subwrap{margin-top:16px;max-width:640px;text-align:center;}
  #sub{color:#e8f0f2;font-size:15px;line-height:1.45;background:rgba(10,16,20,.74);border:1px solid rgba(255,255,255,.12);
       border-radius:10px;padding:9px 14px;display:inline-block;}
  #speaker{color:#4da3ff;font-weight:700;margin-right:8px;}
</style></head><body><div id="wrap">
  <div id="hud"></div><pre id="cam"></pre>
  <div id="subwrap"><span id="sub"><span id="speaker"></span><span id="subtext"></span></span></div>
</div></body></html>`;

async function renderAscii(frames: FilmFrame[]): Promise<void> {
  const ff = ffmpeg();
  const ffDone = once(ff, "close");
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 880, height: 620 }, deviceScaleFactor: 1 });
  await page.setContent(ASCII_HTML);
  await page.evaluate((name) => { document.getElementById("speaker")!.textContent = `${name}  `; }, label);

  for (let i = 0; i < frames.length; i += 1) {
    const f = frames[i];
    await page.evaluate((fr) => {
      document.getElementById("cam")!.textContent = fr.cam;
      document.getElementById("hud")!.textContent = fr.hud;
      document.getElementById("subtext")!.textContent = fr.sub;
      (document.getElementById("subwrap") as HTMLElement).style.visibility = fr.sub ? "visible" : "hidden";
    }, f);
    const png = await page.screenshot({ type: "png" });
    if (!ff.stdin!.write(png)) await once(ff.stdin!, "drain");
    if (i % 60 === 0) console.error(`  frame ${i}/${frames.length}`);
  }
  ff.stdin!.end();
  await browser.close();
  const [code] = (await ffDone) as [number];
  if (code !== 0) throw new Error(`ffmpeg exited ${code}`);
}

// ---------- cinema (3D split-screen) renderer ----------
const CINEMA_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;height:100%;background:#0b1116;overflow:hidden;
            font-family:'SFMono-Regular',Menlo,Consolas,'Liberation Mono',monospace;}
  #gl{position:absolute;left:0;top:0;}
  #divider{position:absolute;left:${WL}px;top:0;width:2px;height:${H}px;background:rgba(124,252,154,.25);}
  /* ascii HUD over the LEFT (pilot) viewport, the 3D world showing through the spaces */
  #camwrap{position:absolute;left:0;top:0;width:${WL}px;height:${H}px;display:flex;align-items:center;justify-content:center;pointer-events:none;}
  #cam{color:#7CFC9A;font-size:21px;line-height:1.12;white-space:pre;margin:0;opacity:.92;
       text-shadow:0 0 2px #0b1116,0 0 7px rgba(124,252,154,.5);}
  .label{position:absolute;top:12px;color:#9fb6bd;font-size:12px;letter-spacing:2px;text-transform:uppercase;text-shadow:0 0 4px #000;}
  #hud{left:16px;} #orbitlabel{left:${WL + 16}px;}
  #subwrap{position:absolute;bottom:18px;left:0;width:${WL + WR}px;text-align:center;pointer-events:none;}
  #sub{color:#eef4f6;font-size:16px;line-height:1.45;background:rgba(6,10,13,.78);border:1px solid rgba(255,255,255,.14);
       border-radius:10px;padding:9px 15px;display:inline-block;max-width:900px;text-shadow:0 0 3px #000;}
  #speaker{color:#4da3ff;font-weight:700;margin-right:8px;}
</style></head><body>
  <canvas id="gl" width="${WL + WR}" height="${H}"></canvas>
  <div id="divider"></div>
  <div id="camwrap"><pre id="cam"></pre></div>
  <div class="label" id="hud"></div>
  <div class="label" id="orbitlabel">orbit</div>
  <div id="subwrap"><span id="sub"><span id="speaker"></span><span id="subtext"></span></span></div>
  <script type="importmap">{"imports":{"three":"/three.module.js"}}</script>
  <script type="module">
    import * as THREE from 'three';
    const S = 0.01, WL = ${WL}, WR = ${WR}, H = ${H};
    const canvas = document.getElementById('gl');
    const renderer = new THREE.WebGLRenderer({ canvas, antialias:true, preserveDrawingBuffer:true });
    renderer.setSize(WL+WR, H, false);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#0b1116');
    scene.fog = new THREE.Fog('#0b1116', 28, 150);
    scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    scene.add(new THREE.HemisphereLight(0xc8eefb, 0x2a2216, 1.6));
    const dir = new THREE.DirectionalLight(0xffffff, 2.4); dir.position.set(12,22,8); scene.add(dir);

    const ground = new THREE.Mesh(new THREE.PlaneGeometry(96,96),
      new THREE.MeshStandardMaterial({color:'#18221f', roughness:0.92, metalness:0.04}));
    ground.rotation.x = -Math.PI/2; ground.position.y = -0.02; scene.add(ground);
    scene.add(new THREE.GridHelper(96,48, 0x526b70, 0x223238));

    const pilotCam = new THREE.PerspectiveCamera(54, WL/H, 0.03, 4000);
    const orbitCam = new THREE.PerspectiveCamera(50, WR/H, 0.03, 4000);

    const ships = {};
    function makeShip(color){
      const g = new THREE.Group(); g.scale.setScalar(1.42);
      const m = (geo, c, opts={}) => new THREE.Mesh(geo, new THREE.MeshStandardMaterial({color:c, roughness:0.45, metalness:0.22, ...opts}));
      g.add(m(new THREE.BoxGeometry(0.12,0.12,0.86), color));
      const nose = m(new THREE.ConeGeometry(0.12,0.26,16), '#f4fbff'); nose.position.set(0,0,-0.52); nose.rotation.x = Math.PI/2; g.add(nose);
      const wing = m(new THREE.BoxGeometry(1.06,0.035,0.18), color); wing.position.z = 0.03; g.add(wing);
      const th = m(new THREE.BoxGeometry(0.42,0.04,0.16), '#dce6e9'); th.position.set(0,0.06,0.38); g.add(th);
      const tv = m(new THREE.BoxGeometry(0.08,0.36,0.17), color); tv.position.set(0,0.12,0.3); g.add(tv);
      const glow = new THREE.Mesh(new THREE.SphereGeometry(0.12,16,16), new THREE.MeshBasicMaterial({color, transparent:true, opacity:0.7}));
      g.add(glow); scene.add(g);
      return { group:g, glow };
    }

    window.renderFrame = (f) => {
      let cx=0, cy=0, cz=0, n=0;
      for (const a of f.aircraft){
        let s = ships[a.id]; if(!s){ s = makeShip(a.color); ships[a.id]=s; }
        s.group.position.set(a.x*S, a.y*S, a.z*S);
        s.group.quaternion.set(a.qx, a.qy, a.qz, a.qw);
        s.group.scale.setScalar(a.alive ? 1.42 : 1.05);
        s.glow.material.color.set(a.stalled ? '#f2c94c' : a.color);
        cx+=a.x*S; cy+=a.y*S; cz+=a.z*S; n++;
      }
      pilotCam.fov = f.fovDeg; pilotCam.updateProjectionMatrix();
      pilotCam.position.set(f.eye.x*S, f.eye.y*S, f.eye.z*S);
      pilotCam.up.set(f.up.x, f.up.y, f.up.z);
      pilotCam.lookAt(f.eye.x*S + f.fwd.x, f.eye.y*S + f.fwd.y, f.eye.z*S + f.fwd.z);

      const ccx=cx/n, ccy=cy/n, ccz=cz/n, R=34;
      orbitCam.position.set(ccx + Math.sin(f.angle)*R, ccy + 11, ccz + Math.cos(f.angle)*R);
      orbitCam.up.set(0,1,0); orbitCam.lookAt(ccx, ccy, ccz);

      renderer.setScissorTest(true);
      // LEFT: pilot eye — hide our own (gamey, oversized) airframe so the nose-cam isn't inside it.
      const own = ships[f.selfId];
      if (own) own.group.visible = false;
      renderer.setViewport(0,0,WL,H); renderer.setScissor(0,0,WL,H); renderer.render(scene, pilotCam);
      if (own) own.group.visible = true;
      // RIGHT: orbit chase — show everything.
      renderer.setViewport(WL,0,WR,H); renderer.setScissor(WL,0,WR,H); renderer.render(scene, orbitCam);

      document.getElementById('cam').textContent = f.cam;
      document.getElementById('hud').textContent = f.hud;
      document.getElementById('subtext').textContent = f.sub;
      document.getElementById('subwrap').style.visibility = f.sub ? 'visible' : 'hidden';
    };
    window.__ready = true;
  </script>
</body></html>`;

async function renderCinema(frames: FilmFrame[]): Promise<void> {
  const threeDir = "node_modules/three/build";
  const server = http.createServer((req, res) => {
    const url = (req.url ?? "/").split("?")[0];
    if (url === "/") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(CINEMA_HTML);
      return;
    }
    const name = url.replace(/^\//, "");
    if (/^[\w.-]+\.js$/.test(name)) {
      try {
        res.writeHead(200, { "content-type": "application/javascript" });
        res.end(readFileSync(`${threeDir}/${name}`));
        return;
      } catch {
        /* fall through */
      }
    }
    res.writeHead(404);
    res.end("not found");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;

  const ff = ffmpeg();
  const ffDone = once(ff, "close");
  const browser = await chromium.launch({
    args: ["--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--use-gl=angle", "--use-angle=swiftshader"],
  });
  const page = await browser.newPage({ viewport: { width: WL + WR, height: H }, deviceScaleFactor: 1 });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(url);
  try {
    await page.waitForFunction("window.__ready === true", undefined, { timeout: 20_000 });
  } catch {
    throw new Error(`cinema page failed to initialize WebGL/three${errors.length ? `: ${errors[0]}` : ""}`);
  }
  await page.evaluate((name) => { document.getElementById("speaker")!.textContent = `${name}  `; }, label);

  for (let i = 0; i < frames.length; i += 1) {
    await page.evaluate((f) => (window as unknown as { renderFrame: (x: unknown) => void }).renderFrame(f), frames[i]);
    const png = await page.screenshot({ type: "png" });
    if (!ff.stdin!.write(png)) await once(ff.stdin!, "drain");
    if (i % 60 === 0) console.error(`  frame ${i}/${frames.length}`);
  }
  ff.stdin!.end();
  await browser.close();
  server.close();
  const [code] = (await ffDone) as [number];
  if (code !== 0) throw new Error(`ffmpeg exited ${code}`);
}

async function main(): Promise<void> {
  if (!scripted) resolveOpenRouterModel(model); // fail fast if the slug isn't in the registry
  console.error(
    `film${cinema ? " [cinema]" : ""}: ${scripted ? "scripted" : model} (${mode}) — ${turns} turns @ ${fps}fps -> ${out}`,
  );

  const replay = await runMatch(buildConfig());
  const pilotDecisions = (replay.decisions ?? []).filter((d) => d.agentId === PILOT_ID);
  const fallbacks = pilotDecisions.filter((d) => d.source === "fallback").length;
  const cost = pilotDecisions.reduce((s, d) => s + (d.usage?.costUsd ?? 0), 0);
  console.error(
    `flew: winner=${replay.outcome?.winnerTeam ?? "draw"} fallbacks=${fallbacks}/${pilotDecisions.length} cost=$${cost.toFixed(4)}`,
  );

  const frames = buildFrames(replay);
  console.error(`rendering ${frames.length} frames...`);
  await (cinema ? renderCinema(frames) : renderAscii(frames));
  console.error(`\ndone -> ${out}  (${(frames.length / fps).toFixed(1)}s @ ${fps}fps)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
