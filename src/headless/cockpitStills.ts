// Aligned (engine PNG, ASCII) still-COLLAGE generator for tuning the camera-ascii@2 encoder BY FEEL.
//
//   npm run stills:pairs
//   STILLS_OUT=stills-tuning npm run stills:pairs
//   STILLS_BATCH=my-tweak npm run stills:pairs        # name the batch folder
//   npm run stills:pairs -- --batch=my-tweak          # same, via arg
//
// Each run writes into its OWN batch subfolder, stills-tuning/<batch>/ (<batch> from STILLS_BATCH or
// --batch=, default batch-YYYYMMDD-HHMMSS). For each hand-authored navigation scene it emits there:
//   <scene>.collage.png   — the primary artifact: a 3-panel collage (see makeCollagePage) showing the
//                           camera-ascii@2 ASCII, the ground-truth Three.js engine render, and the
//                           engine render with the ASCII projection grid overlaid at EXACT per-cell
//                           pixel registration (each cell at its frustum pixel rect).
//   <scene>.ascii.txt     — the camera-ascii@2 viewport text (for diffing/reading)
// plus two acuity variants of one scene (33x15 default vs the SAME projection at 81x37) to show range.
//
// WHY self-contained (not the live React viewer): we need to place objects at KNOWN positions so the
// question "can you tell WHERE it is from the ASCII?" is answerable. Both halves of every pair are
// derived from ONE mountedSensorPose(device, self) and ONE world, so they are pose-consistent with
// EACH OTHER. (The live viewer applies the cockpit mount offset at a different scale — see
// render-capture grounding — so it would NOT register with an independently-placed marker.)
//
// The engine render uses the film.ts cinema convention: world metres * S, camera eye = pose.eye * S,
// camera looks down pose.boresight with pose.basis.up as up, fov = pose.vFovRad. A bright marker
// sphere is drawn at each contact's world position so the contact is visible in the PNG.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { chromium } from "@playwright/test";
import { cameraAsciiEncoderV2, cameraAsciiEncoderV2Hi } from "../agent/encoders/cameraAscii";
import { cameraSensor } from "../agent/perception";
import type { Quaternion, Vec3 } from "../protocol/schema";
import { cockpitCamera, noseCamera } from "../sim/airframe";
import { DEFAULT_MODEL } from "../sim/flight";
import {
  add,
  basisFromQuat,
  quatFromAxisAngle,
  quatIdentity,
  quatMultiply,
  rotateVec,
  vec3,
} from "../sim/math";
import { mountedSensorPose } from "../sim/mountedSensor";
import type { SensorDevice } from "../sim/parts";
import type { AircraftState } from "../sim/types";
import { glyphFieldOverlay, letterboxRect } from "./glyphFieldOverlay";

const RAD2DEG = 180 / Math.PI;
const DEG2RAD = Math.PI / 180;
const OUT = process.env.STILLS_OUT ?? "stills-tuning";
const PX_W = Number(process.env.STILLS_WIDTH ?? 960);
const PX_H = Number(process.env.STILLS_HEIGHT ?? 600);
const S = 0.01; // world-metre -> scene scale, matching FlightScene/film cinema

// --- batch folder: each run writes into stills-tuning/<batch>/ ----------------------------------
// <batch> from STILLS_BATCH env or `--batch=<name>` / `--batch <name>` arg, else a timestamp.
function resolveBatch(): string {
  const env = process.env.STILLS_BATCH?.trim();
  if (env) return env;
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith("--batch=")) {
      const v = a.slice("--batch=".length).trim();
      if (v) return v;
    } else if (a === "--batch" && argv[i + 1]) {
      const v = argv[i + 1].trim();
      if (v) return v;
    }
  }
  const d = new Date();
  const p2 = (n: number): string => String(n).padStart(2, "0");
  return `batch-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
}
const BATCH = resolveBatch();
const BATCH_DIR = `${OUT}/${BATCH}`;

// Collage panel sizes (px). Engine render is PX_W x PX_H; panels keep that aspect ratio. Each engine
// panel is displayed at PANEL_W x PANEL_H; the ASCII-alone panel matches so the grid registers.
const PANEL_W = 560;
const PANEL_H = Math.round((PANEL_W * PX_H) / PX_W); // preserve engine aspect (960x600 -> 350)

// ---------------------------------------------------------------------------------------------------
// Attitude helpers. Body frame: forward = -Z, up = +Y, right = +X (see basisFromQuat in math.ts).
// We compose heading (about world +Y) then pitch (about body +X, + = nose up) then bank (about body
// forward, + = roll right) so the resulting basis matches what mountedSensorPose reads.
// ---------------------------------------------------------------------------------------------------
function attitude(headingDeg: number, pitchDeg: number, bankDeg: number): Quaternion {
  let q = quatIdentity();
  q = quatMultiply(quatFromAxisAngle(vec3(0, 1, 0), headingDeg * DEG2RAD), q); // yaw about world up
  q = quatMultiply(q, quatFromAxisAngle(vec3(1, 0, 0), pitchDeg * DEG2RAD)); // pitch about body right
  q = quatMultiply(q, quatFromAxisAngle(vec3(0, 0, -1), bankDeg * DEG2RAD)); // bank about body forward
  return q;
}

interface Marker {
  id: string;
  // position relative to self, expressed in SELF BODY axes (right, up, forward-metres): forward is
  // +fwd metres ahead. We convert to world using the self orientation so "ahead" tracks the nose.
  right: number;
  up: number;
  fwd: number;
  color: string;
}

interface Scene {
  name: string;
  note: string;
  // self attitude/altitude
  headingDeg: number;
  pitchDeg: number;
  bankDeg: number;
  altitudeM: number;
  speedMps: number;
  markers: Marker[];
  // optional: a ground ridge bump drawn in the engine render only (a terrain feature the ASCII can't see)
  ridge?: boolean;
  sensor?: "cockpit-cam" | "nose-cam";
}

function makeAircraft(
  id: string,
  position: Vec3,
  orientation: Quaternion,
  color: string,
  team: "blue" | "red",
  speedMps = 180,
): AircraftState {
  const fwd = basisFromQuat(orientation).forward;
  return {
    id,
    callsign: id,
    team,
    color,
    position,
    velocity: { x: fwd.x * speedMps, y: fwd.y * speedMps, z: fwd.z * speedMps },
    orientation,
    controls: { pitch: 0, roll: 0, yaw: 0, throttle: 0.8, trigger: false },
    health: 100,
    weaponCooldown: 0,
    model: DEFAULT_MODEL,
    metrics: { airspeed: speedMps, altitude: position.y, aoaDeg: 0, gLoad: 1, stalled: false },
    angularVelocity: { x: 0, y: 0, z: 0 },
    fuelKg: DEFAULT_MODEL.fuelCapacityKg,
    devices: [cockpitCamera(), noseCamera()],
  };
}

// Build the self + marker world for a scene, plus the chosen device.
function buildWorld(scene: Scene): {
  self: AircraftState;
  world: AircraftState[];
  device: SensorDevice;
} {
  const selfQ = attitude(scene.headingDeg, scene.pitchDeg, scene.bankDeg);
  const selfPos = vec3(0, scene.altitudeM, 0);
  const self = makeAircraft("self", selfPos, selfQ, "#4da3ff", "blue", scene.speedMps);

  const basis = basisFromQuat(selfQ);
  const world: AircraftState[] = [self];
  for (const m of scene.markers) {
    const offset = add(
      add(rotateVec(selfQ, vec3(0, 0, 0)), scale3(basis.right, m.right)),
      add(scale3(basis.up, m.up), scale3(basis.forward, m.fwd)),
    );
    const pos = add(selfPos, offset);
    // markers point roughly back at us so their aspect reads as "nose"/"beam" sensibly
    const toSelf = vec3(selfPos.x - pos.x, selfPos.y - pos.y, selfPos.z - pos.z);
    const mq = quatFromAxisAngle(vec3(0, 1, 0), Math.atan2(toSelf.x, -toSelf.z));
    world.push(makeAircraft(m.id, pos, mq, m.color, "red", 160));
  }
  const device =
    scene.sensor === "nose-cam" ? noseCamera() : cockpitCamera();
  return { self, world, device };
}

function scale3(v: Vec3, s: number): Vec3 {
  return vec3(v.x * s, v.y * s, v.z * s);
}

// ---------------------------------------------------------------------------------------------------
// High-resolution ASCII acuity variant: the SAME true-projection camera-ascii@2 encoder at a finer
// grid (81x37 — see cameraAsciiEncoderV2Hi in cameraAscii.ts). Resolution IS the acuity knob; the
// hi-res still is just a resolution change of the identical projection, so we reuse the shipped
// encoder rather than re-implementing it here.
// ---------------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------------
// Scene catalogue — navigation-relevant poses. A bright orange marker (#ff7a1a) is the "distinct
// high-contrast object"; distances/positions are exact so WHERE-IT-IS is judgeable.
// ---------------------------------------------------------------------------------------------------
const scenes: Scene[] = [
  {
    name: "01-horizon-level-empty",
    note: "Straight-and-level, nothing in view. Baseline: can you even tell up from down?",
    headingDeg: 0, pitchDeg: 0, bankDeg: 0, altitudeM: 1200, speedMps: 180, markers: [], ridge: true,
  },
  {
    name: "02-ridge-ahead",
    note: "Level, terrain ridge dead ahead. The ASCII has no terrain channel — the engine shows the ridge.",
    headingDeg: 0, pitchDeg: -6, bankDeg: 0, altitudeM: 240, speedMps: 170, markers: [], ridge: true,
  },
  {
    name: "03-target-center-near",
    note: "Bright object dead-center, NEAR (350 m). Should read as a big glyph in the middle.",
    headingDeg: 0, pitchDeg: 0, bankDeg: 0, altitudeM: 1200, speedMps: 180, ridge: true,
    markers: [{ id: "mk", right: 0, up: 0, fwd: 350, color: "#ff7a1a" }],
  },
  {
    name: "04-target-center-mid",
    note: "Same object, MID (1100 m), dead-center. Tests the size-glyph range ladder.",
    headingDeg: 0, pitchDeg: 0, bankDeg: 0, altitudeM: 1200, speedMps: 180, ridge: true,
    markers: [{ id: "mk", right: 0, up: 0, fwd: 1100, color: "#ff7a1a" }],
  },
  {
    name: "05-target-center-far",
    note: "Same object, FAR (3200 m), dead-center. Near the acuity floor — does it still register?",
    headingDeg: 0, pitchDeg: 0, bankDeg: 0, altitudeM: 1200, speedMps: 180, ridge: true,
    markers: [{ id: "mk", right: 0, up: 0, fwd: 3200, color: "#ff7a1a" }],
  },
  {
    name: "06-target-edge-right-mid",
    note: "Object MID range but pushed to the RIGHT edge of FOV (and slightly high). Tests edge localisation.",
    headingDeg: 0, pitchDeg: 0, bankDeg: 0, altitudeM: 1200, speedMps: 180, ridge: true,
    markers: [{ id: "mk", right: 620, up: 120, fwd: 700, color: "#ff7a1a" }],
  },
  {
    name: "07-two-targets-stacked",
    note: "Two objects at the same screen cell, different ranges. Last-writer-wins collapses them to one glyph.",
    headingDeg: 0, pitchDeg: 0, bankDeg: 0, altitudeM: 1200, speedMps: 180, ridge: true,
    markers: [
      { id: "near", right: 40, up: 0, fwd: 500, color: "#ff7a1a" },
      { id: "far", right: 90, up: 0, fwd: 1300, color: "#ffd23a" },
    ],
  },
  {
    name: "08-steep-bank-target",
    note: "60deg right bank, object low-left. Tests whether bank + target position read correctly together.",
    headingDeg: 0, pitchDeg: 4, bankDeg: 60, altitudeM: 1200, speedMps: 200, ridge: true,
    markers: [{ id: "mk", right: -300, up: -80, fwd: 800, color: "#ff7a1a" }],
  },
  {
    name: "09-nose-high-climb",
    note: "20deg nose-up climb, level wings. Horizon should drop low; tells climb from dive?",
    headingDeg: 0, pitchDeg: 20, bankDeg: 0, altitudeM: 1500, speedMps: 160, markers: [], ridge: true,
  },
];

// ---------------------------------------------------------------------------------------------------
// Engine render page. Renders ONE pose; a bright marker sphere is placed per contact world-position.
// ---------------------------------------------------------------------------------------------------
function enginePage(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;background:#0b1116;}#gl{display:block;}
  </style></head><body>
  <canvas id="gl" width="${PX_W}" height="${PX_H}"></canvas>
  <script type="importmap">{"imports":{"three":"/three.module.js"}}</script>
  <script type="module">
    import * as THREE from 'three';
    const S=${S}, W=${PX_W}, H=${PX_H};
    const canvas=document.getElementById('gl');
    const renderer=new THREE.WebGLRenderer({canvas,antialias:true,preserveDrawingBuffer:true});
    renderer.setSize(W,H,false); renderer.setPixelRatio(1);
    const scene=new THREE.Scene();
    scene.background=new THREE.Color('#aacbe6');
    scene.fog=new THREE.Fog('#c4dcef', 60, 520);
    scene.add(new THREE.AmbientLight(0xffffff,0.6));
    scene.add(new THREE.HemisphereLight(0xdff0ff,0x5a6b4a,1.4));
    const dir=new THREE.DirectionalLight(0xffffff,2.4); dir.position.set(12,22,8); scene.add(dir);

    // ground + grid (scene units = metres*S)
    const ground=new THREE.Mesh(new THREE.PlaneGeometry(4000*S,4000*S),
      new THREE.MeshStandardMaterial({color:'#4b6b48',roughness:0.95,metalness:0.02}));
    ground.rotation.x=-Math.PI/2; ground.position.y=0; scene.add(ground);
    scene.add(new THREE.GridHelper(4000*S,160,0x6f8f74,0x3f5a42));

    // a ridge: a long raised box across the path, added/removed per frame
    let ridge=null;
    function setRidge(on, aheadM, altM){
      if(ridge){ scene.remove(ridge); ridge=null; }
      if(!on) return;
      ridge=new THREE.Mesh(new THREE.BoxGeometry(2400*S, 220*S, 160*S),
        new THREE.MeshStandardMaterial({color:'#3c5a3a',roughness:0.96}));
      // place it ahead of self (self flies down -Z by default heading 0), partly above ground
      ridge.position.set(0, 90*S, (-aheadM)*S);
      scene.add(ridge);
    }

    // bright markers
    const markers={};
    function setMarkers(list){
      for(const k in markers){ markers[k].visible=false; }
      for(const m of list){
        let s=markers[m.id];
        if(!s){
          s=new THREE.Mesh(new THREE.SphereGeometry(8*S,24,24),
            new THREE.MeshStandardMaterial({color:m.color, emissive:m.color, emissiveIntensity:0.7, roughness:0.4}));
          markers[m.id]=s; scene.add(s);
        }
        s.material.color.set(m.color); s.material.emissive.set(m.color);
        s.position.set(m.x*S, m.y*S, m.z*S); s.visible=true;
      }
    }

    const cam=new THREE.PerspectiveCamera(54, W/H, 0.01, 5000);
    window.renderPose=(f)=>{
      setRidge(f.ridge, f.ridgeAheadM, f.altM);
      setMarkers(f.markers);
      cam.fov=f.fovDeg; cam.aspect=W/H; cam.updateProjectionMatrix();
      cam.position.set(f.eye.x*S, f.eye.y*S, f.eye.z*S);
      cam.up.set(f.up.x, f.up.y, f.up.z);
      cam.lookAt(f.eye.x*S+f.fwd.x, f.eye.y*S+f.fwd.y, f.eye.z*S+f.fwd.z);
      renderer.render(scene, cam);
    };
    window.__ready=true;
  </script></body></html>`;
}

// Pull the W x H projection grid out of the camera-ascii@2 text. The text is: header line, top border
// "+---+", H grid rows "|...|", bottom border, then footer/legend lines. We return the grid cells (the
// content between the "|" borders) plus W/H so the overlay can place each cell at its exact pixel rect.
function parseAsciiGrid(asciiText: string): { rows: string[]; W: number; H: number } {
  const lines = asciiText.split("\n");
  const rows: string[] = [];
  for (const line of lines) {
    // grid rows are bordered with "|"; the border lines start with "+". Skip "+---+".
    if (line.startsWith("|") && line.endsWith("|") && line.length > 2) {
      rows.push(line.slice(1, -1));
    }
  }
  const W = rows.length > 0 ? rows[0].length : 0;
  return { rows, W, H: rows.length };
}

// ---------------------------------------------------------------------------------------------------
// Collage page — one PNG per scene. Vertical split down the middle (CSS grid, 2 cols x 2 rows):
//   LEFT col, row 1 = ASCII alone ("ASCII @2"); LEFT col, row 2 = engine alone ("3D").
//   RIGHT col spans both rows = engine render with the projection grid placed on top, registered to it
//                               EXACTLY ("3D + ASCII overlay").
//
// EXACT REGISTRATION + LETTERBOX (Part B). The overlay image is drawn at its NATIVE aspect ratio,
// centred in the tall panel with neutral bars above/below (letterboxRect) — the camera render is NEVER
// stretched, so a round marker sphere reads round. The camera-ascii@2 grid IS a uniform raster of the
// same view frustum the render draws (see cameraAscii.ts), so we map each grid cell to its exact pixel
// rect WITHIN the letterboxed IMAGE rect {x0,y0,w,h} (not the panel) via glyphFieldOverlay:
//     pixelX = x0 + (col/W)*w .. x0 + ((col+1)/W)*w ,  pixelY = y0 + (row/H)*h .. y0 + ((row+1)/H)*h
// Each grid cell is an absolutely-positioned span at that exact rect (centred glyph), so registration is
// pixel-exact, DOES NOT depend on monospace font-advance metrics, and sits on the undistorted image. The
// overlay renders ONLY the projected glyph content — no decorative frame border (viewer chrome). The
// ASCII-alone panel still shows the full text (header + grid + frame + legend) as a plain <pre>.
// Green-on-black monospace matches film.ts; the overlay uses higher opacity + a dark halo so glyphs read
// over bright sky and dark ground (#3 feedback).
// ---------------------------------------------------------------------------------------------------
function makeCollagePage(engineDataUri: string, asciiText: string): string {
  const ascii = asciiText
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const { rows, W, H } = parseAsciiGrid(asciiText);
  const pw = PANEL_W;
  const ph = PANEL_H;
  const tallH = ph * 2 + 8; // tall panel = two stacked panel heights + the row gap

  // Letterbox the engine render inside the tall (pw x tallH) overlay panel: draw it at NATIVE aspect
  // (PX_W x PX_H), centred, neutral bars on the long axis — NEVER stretched. Then place each glyph at
  // its exact pixel rect WITHIN that letterboxed image rect via the reusable registration primitive.
  const imgRect = letterboxRect(PX_W, PX_H, pw, tallH);
  const overlayCells = glyphFieldOverlay({ rows, W, H }, imgRect);

  return `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;background:#000;
            font-family:'SFMono-Regular',Menlo,Consolas,'Liberation Mono',monospace;}
  #grid{display:grid;grid-template-columns:${pw}px ${pw}px;grid-template-rows:${ph}px ${ph}px;gap:8px;
        width:${pw * 2 + 8}px;background:#000;padding:8px;box-sizing:content-box;}
  .panel{position:relative;background:#000;overflow:hidden;border:1px solid #16321f;}
  .ascii-only{grid-column:1;grid-row:1;}
  .engine-only{grid-column:1;grid-row:2;}
  /* Overlay panel: neutral #0b1116 background (matches the render's clear color) shows as letterbox bars. */
  .overlay{grid-column:2;grid-row:1 / span 2;background:#0b1116;}
  .panel img{display:block;width:${pw}px;height:${ph}px;}
  /* Overlay: engine render at NATIVE aspect, centred (letterboxed) inside the tall panel — not stretched. */
  .overlay img{position:absolute;left:${imgRect.x0.toFixed(3)}px;top:${imgRect.y0.toFixed(3)}px;
         width:${imgRect.w.toFixed(3)}px;height:${imgRect.h.toFixed(3)}px;}
  /* ASCII-alone panel: full text, scaled to fill its frame (informational, not registered). */
  .ascii{position:absolute;left:0;top:0;width:${pw}px;height:${ph}px;margin:0;
         color:#7CFC9A;background:#000;white-space:pre;line-height:1.0;
         transform-origin:top left;text-shadow:0 0 4px rgba(124,252,154,.35);}
  /* Overlay grid: absolutely-placed cells at exact pixel rects WITHIN the letterboxed engine image. */
  .cellgrid{position:absolute;left:0;top:0;width:${pw}px;height:${tallH}px;pointer-events:none;}
  .cellgrid .cell{position:absolute;display:flex;align-items:center;justify-content:center;
         text-align:center;color:#7CFC9A;opacity:0.65;font-weight:700;
         text-shadow:0 0 2px #000,0 0 3px #000,1px 1px 1px #000;}
  .cap{position:absolute;left:8px;bottom:8px;z-index:3;color:#cfe6dd;font-size:13px;
       letter-spacing:1px;text-transform:uppercase;padding:2px 7px;border-radius:4px;
       background:rgba(0,0,0,.62);text-shadow:0 0 4px #000;}
</style></head><body>
  <div id="grid">
    <div class="panel ascii-only">
      <pre class="ascii fit">${ascii}</pre>
      <div class="cap">ASCII @2</div>
    </div>
    <div class="panel engine-only">
      <img src="${engineDataUri}" alt="3D">
      <div class="cap">3D</div>
    </div>
    <div class="panel overlay">
      <img src="${engineDataUri}" alt="3D + ASCII overlay">
      <div class="cellgrid">${overlayCells}</div>
      <div class="cap">3D + ASCII overlay</div>
    </div>
  </div>
  <script>
    // The ASCII-alone <pre> is purely informational; fit it to its panel (uniform-ish scale). The
    // OVERLAY does NOT use this — its cells are placed at exact pixel rects (see makeCollagePage).
    function fit(pre){
      var panel = pre.parentElement;
      var fw = panel.clientWidth, fh = panel.clientHeight;
      pre.style.transform = 'none';
      pre.style.fontSize = '16px';
      var nw = pre.scrollWidth || 1, nh = pre.scrollHeight || 1;
      var sx = fw / nw, sy = fh / nh;
      pre.style.transform = 'scale(' + sx + ',' + sy + ')';
    }
    var pres = document.querySelectorAll('.ascii.fit');
    for (var i = 0; i < pres.length; i++) fit(pres[i]);
    window.__collageReady = true;
  </script>
</body></html>`;
}

async function main(): Promise<void> {
  mkdirSync(BATCH_DIR, { recursive: true });
  const threeDir = "node_modules/three/build";
  const server = http.createServer((req, res) => {
    const url = (req.url ?? "/").split("?")[0];
    if (url === "/") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(enginePage());
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

  const browser = await chromium.launch({
    args: ["--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--use-gl=angle", "--use-angle=swiftshader"],
  });

  // engine render page
  const enginePg = await browser.newPage({ viewport: { width: PX_W, height: PX_H }, deviceScaleFactor: 1 });
  const engineErrors: string[] = [];
  enginePg.on("pageerror", (e) => engineErrors.push(String(e)));
  await enginePg.goto(url);
  try {
    await enginePg.waitForFunction("window.__ready === true", undefined, { timeout: 20_000 });
  } catch {
    throw new Error(`engine page failed WebGL init${engineErrors.length ? `: ${engineErrors[0]}` : ""}`);
  }

  // collage page — sized to the full 2x2 grid (left two stacked panels + right tall panel + gaps).
  const collageW = PANEL_W * 2 + 8 + 16; // two columns + col gap + outer padding
  const collageH = PANEL_H * 2 + 8 + 16; // two rows + row gap + outer padding
  const collagePg = await browser.newPage({
    viewport: { width: collageW, height: collageH },
    deviceScaleFactor: 2,
  });

  const manifest: { scene: string; ascii: string; notes: string }[] = [];

  for (const scene of scenes) {
    const { self, world, device } = buildWorld(scene);
    const pose = mountedSensorPose(device, self);
    const frame = cameraSensor.sense(device, world, self);
    // camera-ascii@2 is the encoder we are tuning — used for all three collage panels and the .txt.
    const percept = cameraAsciiEncoderV2.encode(frame);

    // marker world positions for the engine render
    const markerPayload = world
      .filter((a) => a.id !== "self")
      .map((a) => {
        const m = scene.markers.find((mm) => mm.id === a.id)!;
        return { id: a.id, color: m.color, x: a.position.x, y: a.position.y, z: a.position.z };
      });

    await enginePg.evaluate(
      (f) => (window as unknown as { renderPose: (x: unknown) => void }).renderPose(f),
      {
        eye: pose.eye,
        fwd: pose.boresight,
        up: pose.basis.up,
        fovDeg: pose.vFovRad * RAD2DEG,
        ridge: Boolean(scene.ridge),
        ridgeAheadM: 900,
        altM: scene.altitudeM,
        markers: markerPayload,
      },
    );
    const enginePng = await enginePg.screenshot({ type: "png" });
    const engineDataUri = `data:image/png;base64,${enginePng.toString("base64")}`;

    // per-scene @2 text into the batch folder, for diffing/reading
    writeFileSync(`${BATCH_DIR}/${scene.name}.ascii.txt`, `# [camera-ascii@2] ${scene.note}\n${percept.text}\n`);

    // compose the 3-panel collage and screenshot it
    await collagePg.setContent(makeCollagePage(engineDataUri, percept.text ?? ""));
    await collagePg.waitForFunction("window.__collageReady === true", undefined, { timeout: 10_000 });
    const collagePng = await collagePg.screenshot({ type: "png" });
    writeFileSync(`${BATCH_DIR}/${scene.name}.collage.png`, collagePng);

    manifest.push({ scene: scene.name, ascii: percept.text ?? "", notes: scene.note });
    console.error(`collage: ${scene.name}  (${markerPayload.length} marker(s))`);
  }

  // --- acuity variants (text, into the batch folder): the busy edge scene at 33x15 (default @2 grid)
  // vs an 81x37 hi-res grid, to show how much acuity a bigger grid buys. ---
  const acuityScene = scenes.find((s) => s.name === "06-target-edge-right-mid")!;
  {
    const { self, world, device } = buildWorld(acuityScene);
    const frame = cameraSensor.sense(device, world, self);
    const lo = cameraAsciiEncoderV2.encode(frame);
    const hi = cameraAsciiEncoderV2Hi.encode(frame);
    writeFileSync(`${BATCH_DIR}/acuity-lo-33x15.ascii.txt`, `# camera-ascii@2 (33x15), ${acuityScene.note}\n${lo.text}\n`);
    writeFileSync(`${BATCH_DIR}/acuity-hi-81x37.ascii.txt`, `# hi-res encoder (81x37), ${acuityScene.note}\n${hi.text}\n`);
    console.error("acuity variants (text): 33x15 vs 81x37");
  }

  await browser.close();
  server.close();
  writeFileSync(`${BATCH_DIR}/manifest.json`, JSON.stringify(manifest, null, 2));
  console.error(`done -> ${BATCH_DIR}/  (${scenes.length} collages + acuity text variants)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
