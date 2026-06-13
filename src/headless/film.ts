// Pilot-cam film exporter. Flies a match (scripted or a live model via pi-ai/OpenRouter), then
// renders an mp4 of what the pilot's nose-camera "sees" — the camera-ascii viewport — with the
// model's per-turn rationale burned in as subtitles.
//
// The camera is re-sensed from the INTERPOLATED replay frames (the sensor is a pure function of
// world state), so the viewport animates smoothly at the render fps rather than stepping once per
// turn. Frames are rasterized with Playwright (Chromium) and piped to ffmpeg.
//
//   npm run film -- --scripted                       # free dev pass, no API key
//   npm run film -- deepseek/deepseek-chat-v3.1       # live; writes film.mp4
//   npm run film -- <model> --out clips/run.mp4
//   env: FILM_TURNS (default 16), FILM_FPS (default 30), FILM_MODE (raw-stick|setpoint, default setpoint)
import { spawn } from "node:child_process";
import { once } from "node:events";
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
import { lerp, quatNormalize } from "../sim/math";
import type { AircraftState } from "../sim/types";

const PILOT_ID = "blue-1";

// ---- args ----
const argv = process.argv.slice(2);
const scripted = argv.includes("--scripted");
const outIdx = argv.indexOf("--out");
const out = outIdx >= 0 ? argv[outIdx + 1] : "film.mp4";
const model =
  argv.find((a, i) => !a.startsWith("--") && (outIdx < 0 || i !== outIdx + 1)) ??
  "deepseek/deepseek-chat-v3.1";
const turns = Number(process.env.FILM_TURNS ?? 16);
const fps = Number(process.env.FILM_FPS ?? 30);
const mode = (process.env.FILM_MODE ?? "setpoint") as ActionMode;

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
  const dotp = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
  const s = dotp < 0 ? -1 : 1; // shortest arc
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

interface FilmFrame {
  cam: string;
  sub: string;
  hud: string;
}

function buildFrames(replay: MatchReplay): FilmFrame[] {
  const frames = replay.frames;
  const duration = frames[frames.length - 1].time;
  const total = Math.max(1, Math.floor(duration * fps));

  const rationaleByTurn = new Map<number, string>();
  for (const d of replay.decisions ?? []) {
    if (d.agentId === PILOT_ID && d.rationale) rationaleByTurn.set(d.turn, d.rationale);
  }

  const label = scripted ? "pursuit" : model.split("/").pop()!;
  const result: FilmFrame[] = [];
  let seg = 0;
  for (let k = 0; k <= total; k += 1) {
    const t = (k / fps);
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

    const percept = senseAndEncode(noseCamera(), world, self);
    const sub = rationaleByTurn.get(fa.turn) ?? "";
    const hud = `${label}   turn ${fa.turn}/${turns}   t=${t.toFixed(1)}s`;
    result.push({ cam: percept.text ?? "", sub, hud });
  }
  return result;
}

const HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;height:100%;background:#05070a;}
  #wrap{display:flex;flex-direction:column;align-items:center;height:100vh;padding:16px 0;box-sizing:border-box;
        font-family:'SFMono-Regular',Menlo,Consolas,'Liberation Mono',monospace;}
  #hud{color:#5f7d8c;font-size:13px;letter-spacing:1px;margin-bottom:10px;text-transform:uppercase;}
  #cam{color:#7CFC9A;font-size:16px;line-height:1.15;white-space:pre;margin:0;
       text-shadow:0 0 6px rgba(124,252,154,.35);}
  #subwrap{margin-top:16px;max-width:640px;text-align:center;}
  #sub{color:#e8f0f2;font-size:15px;line-height:1.45;background:rgba(10,16,20,.74);
       border:1px solid rgba(255,255,255,.12);border-radius:10px;padding:9px 14px;display:inline-block;}
  #speaker{color:#4da3ff;font-weight:700;margin-right:8px;}
</style></head><body><div id="wrap">
  <div id="hud"></div><pre id="cam"></pre>
  <div id="subwrap"><span id="sub"><span id="speaker"></span><span id="subtext"></span></span></div>
</div></body></html>`;

async function render(frames: FilmFrame[]): Promise<void> {
  const ff = spawn(
    "ffmpeg",
    ["-y", "-f", "image2pipe", "-framerate", String(fps), "-i", "-",
     "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out],
    { stdio: ["pipe", "ignore", "ignore"] },
  );
  const ffDone = once(ff, "close");

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 880, height: 620 }, deviceScaleFactor: 1 });
  await page.setContent(HTML);
  await page.evaluate((name) => {
    document.getElementById("speaker")!.textContent = `${name}  `;
  }, scripted ? "Pursuit" : (model.split("/").pop() ?? model));

  for (let i = 0; i < frames.length; i += 1) {
    const f = frames[i];
    await page.evaluate((fr) => {
      document.getElementById("cam")!.textContent = fr.cam;
      document.getElementById("hud")!.textContent = fr.hud;
      document.getElementById("subtext")!.textContent = fr.sub;
      (document.getElementById("subwrap") as HTMLElement).style.visibility = fr.sub ? "visible" : "hidden";
    }, f);
    const png = await page.screenshot({ type: "png" });
    if (!ff.stdin.write(png)) await once(ff.stdin, "drain");
    if (i % 60 === 0) console.error(`  frame ${i}/${frames.length}`);
  }

  ff.stdin.end();
  await browser.close();
  const [code] = (await ffDone) as [number];
  if (code !== 0) throw new Error(`ffmpeg exited ${code}`);
}

async function main(): Promise<void> {
  if (!scripted) resolveOpenRouterModel(model); // fail fast if the slug isn't in the registry
  console.error(`film: ${scripted ? "scripted" : model} (${mode}) — ${turns} turns @ ${fps}fps -> ${out}`);

  const replay = await runMatch(buildConfig());
  const pilotDecisions = (replay.decisions ?? []).filter((d) => d.agentId === PILOT_ID);
  const fallbacks = pilotDecisions.filter((d) => d.source === "fallback").length;
  const cost = pilotDecisions.reduce((s, d) => s + (d.usage?.costUsd ?? 0), 0);
  console.error(
    `flew: winner=${replay.outcome?.winnerTeam ?? "draw"} fallbacks=${fallbacks}/${pilotDecisions.length}` +
      ` cost=$${cost.toFixed(4)}`,
  );

  const frames = buildFrames(replay);
  console.error(`rendering ${frames.length} frames...`);
  await render(frames);
  console.error(`\ndone -> ${out}  (${(frames.length / fps).toFixed(1)}s @ ${fps}fps)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
