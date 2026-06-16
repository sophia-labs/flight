// Scripted physics montage exporter.
//
//   npm run demo:physics -- --out clips/more-physics-demo.mp4
//
// Produces an mp4 that demonstrates the live flight model: surface forces, stall drag/lift loss,
// mass/inertia effects, finite fuel, and thrust moment arms.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import http from "node:http";
import { dirname } from "node:path";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { chromium } from "@playwright/test";
import type { Airframe, ControlInput, Part, Quaternion, SurfaceControlSnapshot, Vec3 } from "../protocol/schema";
import { compileAirframe, defaultAirframe } from "../sim/airframe";
import { stepSimulation } from "../sim/flight";
import { basisFromQuat, length, quatLookRotation, rotateAroundWorldAxis, sub, vec3 } from "../sim/math";
import type { AircraftState, FlightMetrics, Inertia } from "../sim/types";

const argv = process.argv.slice(2);
const outIdx = argv.indexOf("--out");
const out = outIdx >= 0 ? argv[outIdx + 1] : "clips/more-physics-demo.mp4";
const fps = Number(process.env.DEMO_FPS ?? 30);
const dt = 1 / fps;
const width = 1280;
const height = 720;

interface Scenario {
  id: string;
  title: string;
  subtitle: string;
  airframe: Airframe;
  controls?: ControlInput;
  plan?: FlightPlanStep[];
  seconds: number;
  speedMps?: number;
  altitudeM?: number;
  initialPitchDeg?: number;
  initialAngularVelocity?: Vec3;
}

interface FlightPlanStep {
  at: number;
  label: string;
  controls: ControlInput;
}

interface DemoStats {
  downrangeM: number;
  verticalSpeedMps: number;
  effectiveMassKg: number;
  fuelFraction: number;
  stallSeverity: number;
  maxSurfaceAoADeg: number;
  maxSurfaceLoadN: number;
}

interface DemoAircraft {
  position: Vec3;
  velocity: Vec3;
  orientation: Quaternion;
  controls: ControlInput;
  metrics: FlightMetrics;
  angularVelocity: Vec3;
  fuelKg: number;
  fuelCapacityKg: number;
  com: Vec3;
  inertia: Inertia;
  surfaceControls: SurfaceControlSnapshot[];
  stats: DemoStats;
}

interface DemoFrame {
  scenarioId: string;
  title: string;
  subtitle: string;
  phase: string;
  t: number;
  sceneT: number;
  parts: Part[];
  aircraft: DemoAircraft;
}

const baseControls: ControlInput = {
  pitch: 0,
  roll: 0,
  yaw: 0,
  throttle: 0.82,
  trigger: false,
};

const initialMetrics: FlightMetrics = {
  airspeed: 0,
  altitude: 0,
  aoaDeg: 0,
  gLoad: 1,
  stalled: false,
};

function cloneAirframe(): Airframe {
  return structuredClone(defaultAirframe()) as Airframe;
}

function bodyRotation(): Quaternion {
  return { x: 0, y: 0, z: 0, w: 1 };
}

function command(overrides: Partial<ControlInput>): ControlInput {
  return { ...baseControls, ...overrides };
}

function noControlAirframe(): Airframe {
  const airframe = cloneAirframe();
  for (const part of airframe.parts) if (part.kind === "wing") part.control = undefined;
  return airframe;
}

function offsetEngineAirframe(): Airframe {
  const airframe = cloneAirframe();
  const engine = airframe.parts.find((p) => p.id === "engine");
  if (engine?.kind === "engine") {
    engine.pose = { ...engine.pose, offset: vec3(3.4, 0, 4) };
  }
  return airframe;
}

function heavyStoreAirframe(): Airframe {
  const airframe = cloneAirframe();
  const rotation = bodyRotation();
  airframe.id = "heavy-stores";
  airframe.parts.push(
    {
      id: "left-heavy-store",
      kind: "weapon",
      pose: { offset: vec3(-5.65, -0.35, 0.7), rotation },
      count: 1,
      caliberMm: 0,
      massKg: 950,
      dims: { length: 2.4, width: 0.55, height: 0.48 },
      role: "bomb-rack",
    },
    {
      id: "right-heavy-store",
      kind: "weapon",
      pose: { offset: vec3(5.65, -0.35, 0.7), rotation },
      count: 1,
      caliberMm: 0,
      massKg: 950,
      dims: { length: 2.4, width: 0.55, height: 0.48 },
      role: "bomb-rack",
    },
  );
  return airframe;
}

function fuelLimitedAirframe(): Airframe {
  const airframe = cloneAirframe();
  airframe.id = "fuel-limited";
  airframe.parts.push({
    id: "demo-fuel-tank",
    kind: "tank",
    pose: { offset: vec3(0, -0.3, 1.1), rotation: bodyRotation() },
    fuelKg: 16,
    dryMassKg: 45,
    dims: { radius: 0.42, length: 1.8 },
  });
  return airframe;
}

const scenarios: Scenario[] = [
  {
    id: "roll-baseline",
    title: "Aileron Roll: force at the wing tips",
    subtitle: "Full right roll. The orange panels change local lift, producing a torque from their lever arms instead of a canned roll-rate motor.",
    airframe: cloneAirframe(),
    plan: [{ at: 0, label: "roll right, hold altitude", controls: command({ roll: 0.96, throttle: 0.86 }) }],
    seconds: 4.6,
    speedMps: 178,
  },
  {
    id: "roll-heavy-stores",
    title: "Stores Outboard: inertia changes handling",
    subtitle: "The same aileron command on a heavier wingtip-loaded build. The HUD exposes the larger roll inertia and the slower rate build-up.",
    airframe: heavyStoreAirframe(),
    plan: [{ at: 0, label: "same roll command", controls: command({ roll: 0.96, throttle: 0.86 }) }],
    seconds: 4.6,
    speedMps: 178,
  },
  {
    id: "pitch-stall",
    title: "High-AoA Pull: stall is a surface state",
    subtitle: "The entry starts near the critical angle, then goes full aft. AoA, load, and the stall meter move as surfaces exceed usable angle.",
    airframe: cloneAirframe(),
    plan: [
      { at: 0, label: "near critical AoA", controls: command({ pitch: 0.2, throttle: 0.94 }) },
      { at: 1.1, label: "full pull into separation", controls: command({ pitch: 1, throttle: 1 }) },
    ],
    seconds: 5.4,
    speedMps: 88,
    initialPitchDeg: 34,
  },
  {
    id: "rudder-slip",
    title: "Rudder Slip: yaw force is mounted at the fin",
    subtitle: "A rudder kick pushes at the vertical tail. The measured yaw rate arrives with secondary roll and drag instead of an isolated heading change.",
    airframe: cloneAirframe(),
    plan: [
      { at: 0, label: "centered rudder", controls: command({ throttle: 0.86 }) },
      { at: 0.8, label: "hard right rudder", controls: command({ yaw: 1, throttle: 0.86 }) },
      { at: 3.2, label: "recover", controls: command({ yaw: -0.35, throttle: 0.86 }) },
    ],
    seconds: 4.8,
    speedMps: 168,
  },
  {
    id: "dead-roll",
    title: "No hidden authority",
    subtitle: "The same full-roll command on a build with no moving surfaces: no scalar max-rate motor rescues it.",
    airframe: noControlAirframe(),
    plan: [{ at: 0, label: "roll command, no ailerons", controls: command({ roll: 1, throttle: 0.86 }) }],
    seconds: 4.8,
    speedMps: 178,
  },
  {
    id: "offset-engine",
    title: "Offset engine: thrust has a moment arm",
    subtitle: "Thrust is applied at the mounted engine location. Move the engine off-axis and throttle produces yaw.",
    airframe: offsetEngineAirframe(),
    plan: [
      { at: 0, label: "low throttle", controls: command({ throttle: 0.12 }) },
      { at: 0.9, label: "full throttle, no stick", controls: command({ throttle: 1 }) },
    ],
    seconds: 4.8,
    speedMps: 132,
  },
  {
    id: "finite-fuel",
    title: "Finite Fuel: dry tank removes thrust",
    subtitle: "This airframe carries a tiny demo tank. Full throttle drains it in seconds; after fuel reaches zero, the engine command no longer produces thrust.",
    airframe: fuelLimitedAirframe(),
    plan: [{ at: 0, label: "full throttle climb until dry", controls: command({ pitch: 0.24, throttle: 1 }) }],
    seconds: 6,
    speedMps: 126,
    altitudeM: 980,
  },
];

function makeAircraft(scenario: Scenario): AircraftState {
  const speedMps = scenario.speedMps ?? 180;
  const compiled = compileAirframe(scenario.airframe);
  const altitudeM = scenario.altitudeM ?? 1120;
  const velocity = vec3(0, 0, -speedMps);
  const position = vec3(0, altitudeM, 0);
  let orientation = quatLookRotation(velocity);
  if (scenario.initialPitchDeg) {
    orientation = rotateAroundWorldAxis(
      orientation,
      basisFromQuat(orientation).right,
      (scenario.initialPitchDeg * Math.PI) / 180,
    );
  }
  return {
    id: "demo",
    callsign: "Surface Demo",
    team: "blue",
    color: "#4da3ff",
    position,
    velocity,
    orientation,
    controls: scenario.controls ?? scenario.plan?.[0]?.controls ?? baseControls,
    health: 100,
    weaponCooldown: 0,
    model: compiled.model,
    metrics: { ...initialMetrics, airspeed: speedMps, altitude: position.y },
    angularVelocity: scenario.initialAngularVelocity ?? vec3(0, 0, 0),
    fuelKg: compiled.model.fuelCapacityKg,
    devices: compiled.devices,
    airframe: scenario.airframe,
  };
}

function scenarioCommand(scenario: Scenario, sceneT: number): { controls: ControlInput; phase: string } {
  if (!scenario.plan?.length) {
    return { controls: scenario.controls ?? baseControls, phase: "steady command" };
  }
  let step = scenario.plan[0];
  for (const candidate of scenario.plan) {
    if (candidate.at <= sceneT) step = candidate;
  }
  return { controls: step.controls, phase: step.label };
}

function maxBy(
  snapshots: SurfaceControlSnapshot[],
  value: (snapshot: SurfaceControlSnapshot) => number | undefined,
): number {
  return snapshots.reduce((max, snapshot) => Math.max(max, Math.abs(value(snapshot) ?? 0)), 0);
}

function snap(aircraft: AircraftState, origin: Vec3): DemoAircraft {
  const model = aircraft.model;
  const surfaceControls = aircraft.surfaceControls ?? [];
  const fuelFraction = model.fuelCapacityKg > 0 ? aircraft.fuelKg / model.fuelCapacityKg : 1;
  return {
    position: aircraft.position,
    velocity: aircraft.velocity,
    orientation: aircraft.orientation,
    controls: aircraft.controls,
    metrics: aircraft.metrics,
    angularVelocity: aircraft.angularVelocity,
    fuelKg: aircraft.fuelKg,
    fuelCapacityKg: model.fuelCapacityKg,
    com: model.com,
    inertia: model.inertia,
    surfaceControls,
    stats: {
      downrangeM: length(sub(aircraft.position, origin)),
      verticalSpeedMps: aircraft.velocity.y,
      effectiveMassKg: model.dryMassKg + aircraft.fuelKg,
      fuelFraction,
      stallSeverity: maxBy(surfaceControls, (surface) => surface.stallSeverity),
      maxSurfaceAoADeg: maxBy(surfaceControls, (surface) => surface.totalAoADeg),
      maxSurfaceLoadN: maxBy(surfaceControls, (surface) => surface.loadN),
    },
  };
}

function buildFrames(): DemoFrame[] {
  const frames: DemoFrame[] = [];
  let t = 0;

  for (const scenario of scenarios) {
    const aircraft = makeAircraft(scenario);
    const origin = aircraft.position;
    const count = Math.round(scenario.seconds * fps);

    for (let i = 0; i < count; i += 1) {
      const sceneT = i / fps;
      const { controls, phase } = scenarioCommand(scenario, sceneT);
      stepSimulation([aircraft], { demo: controls }, dt);
      frames.push({
        scenarioId: scenario.id,
        title: scenario.title,
        subtitle: scenario.subtitle,
        phase,
        t,
        sceneT,
        parts: scenario.airframe.parts,
        aircraft: snap(aircraft, origin),
      });
      t += dt;
    }
  }

  return frames;
}

function ffmpeg() {
  mkdirSync(dirname(out), { recursive: true });
  return spawn(
    "ffmpeg",
    [
      "-y",
      "-f",
      "image2pipe",
      "-framerate",
      String(fps),
      "-i",
      "-",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      out,
    ],
    { stdio: ["pipe", "ignore", "inherit"] },
  );
}

const HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;height:100%;background:#081016;overflow:hidden;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#eaf2f5;}
  #gl{position:absolute;inset:0;}
  #top{position:absolute;left:34px;top:28px;width:760px;text-shadow:0 2px 12px rgba(0,0,0,.55);}
  #eyebrow{font:700 12px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:2.4px;text-transform:uppercase;color:#7cfc9a;margin-bottom:8px;}
  #title{font-size:36px;line-height:1.04;font-weight:760;letter-spacing:0;margin-bottom:10px;}
  #subtitle{font-size:17px;line-height:1.45;color:#c7d5da;max-width:760px;}
  #phase{margin-top:14px;display:inline-flex;align-items:center;gap:8px;font:750 12px/1 ui-monospace,SFMono-Regular,Menlo,monospace;color:#061016;background:#7cfc9a;border-radius:8px;padding:9px 11px;box-shadow:0 8px 26px rgba(0,0,0,.22);}
  #metrics{position:absolute;right:26px;top:26px;width:344px;background:rgba(7,13,18,.78);border:1px solid rgba(255,255,255,.14);border-radius:8px;padding:13px 15px;box-shadow:0 14px 38px rgba(0,0,0,.25);}
  .section{padding:2px 0 8px;margin-bottom:6px;border-bottom:1px solid rgba(255,255,255,.1);}
  .section:last-child{border-bottom:0;margin-bottom:0;padding-bottom:0;}
  .section h3{margin:0 0 4px;font:800 11px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;color:#7cfc9a;letter-spacing:1.4px;text-transform:uppercase;}
  .row{display:flex;justify-content:space-between;gap:18px;font:600 12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;color:#dce8eb;}
  .row span:first-child{color:#86a2ad;text-transform:uppercase;letter-spacing:.9px;font-size:10px;}
  #controls{position:absolute;left:34px;bottom:28px;display:flex;gap:8px;align-items:center;}
  .pill{font:700 12px/1 ui-monospace,SFMono-Regular,Menlo,monospace;color:#dce8eb;background:rgba(7,13,18,.76);border:1px solid rgba(255,255,255,.13);border-radius:8px;padding:9px 11px;}
  .hot{color:#061016;background:#7cfc9a;border-color:#7cfc9a;}
  #gauges{position:absolute;right:26px;bottom:28px;width:344px;background:rgba(7,13,18,.66);border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:12px 14px;}
  .meter{display:grid;grid-template-columns:64px 1fr 70px;gap:10px;align-items:center;margin:6px 0;font:700 11px/1 ui-monospace,SFMono-Regular,Menlo,monospace;color:#dce8eb;text-transform:uppercase;letter-spacing:.8px;}
  .meter .track{height:8px;background:rgba(255,255,255,.12);border-radius:999px;overflow:hidden;}
  .meter .fill{height:100%;width:0;background:#7cfc9a;border-radius:999px;}
  .meter.hot .fill{background:#ffcf5a;}
  .meter.red .fill{background:#ff6b6b;}
  .meter b{text-align:right;color:#eff8fb;font-size:11px;letter-spacing:0;text-transform:none;}
  #bar{position:absolute;left:0;right:0;bottom:0;height:4px;background:rgba(255,255,255,.12);}
  #prog{height:100%;width:0;background:#7cfc9a;}
</style></head><body>
  <canvas id="gl" width="${width}" height="${height}"></canvas>
  <section id="top"><div id="eyebrow">scripted physics montage</div><div id="title"></div><div id="subtitle"></div><div id="phase"></div></section>
  <section id="metrics"></section>
  <section id="controls"></section>
  <section id="gauges"></section>
  <div id="bar"><div id="prog"></div></div>
  <script type="importmap">{"imports":{"three":"/three.module.js"}}</script>
  <script type="module">
    import * as THREE from "three";
    const W=${width}, H=${height};
    const WORLD=0.014, PART=0.14;
    const canvas=document.getElementById("gl");
    const renderer=new THREE.WebGLRenderer({canvas,antialias:true,preserveDrawingBuffer:true});
    renderer.setSize(W,H,false);
    renderer.setPixelRatio(1);
    renderer.shadowMap.enabled=true;

    const scene=new THREE.Scene();
    scene.background=new THREE.Color("#081016");
    scene.fog=new THREE.Fog("#081016", 34, 140);
    scene.add(new THREE.HemisphereLight(0xe8fbff,0x232018,1.6));
    const sun=new THREE.DirectionalLight(0xffffff,2.8); sun.position.set(18,28,14); sun.castShadow=true; scene.add(sun);
    const fill=new THREE.DirectionalLight(0x7cfc9a,.6); fill.position.set(-16,8,-12); scene.add(fill);
    const ground=new THREE.Mesh(new THREE.PlaneGeometry(220,220),new THREE.MeshStandardMaterial({color:"#16221f",roughness:.92,metalness:.03}));
    ground.rotation.x=-Math.PI/2; ground.position.y=55*WORLD; ground.receiveShadow=true; scene.add(ground);
    scene.add(new THREE.GridHelper(220,44,0x48636a,0x1f3035));

    const camera=new THREE.PerspectiveCamera(45,W/H,.05,500);
    let group=null, scenarioId="", patches=[];
    const trailMat=new THREE.LineBasicMaterial({color:0x7cfc9a,transparent:true,opacity:.55});
    let trail=new THREE.Line(new THREE.BufferGeometry(),trailMat); scene.add(trail);
    let trailPts=[];

    const mat=(color,opts={})=>new THREE.MeshStandardMaterial({color,roughness:.45,metalness:.22,...opts});
    const q=(r)=>new THREE.Quaternion(r.x,r.y,r.z,r.w);

    function addMesh(parent,geo,material,pos=[0,0,0],rot=[0,0,0]){
      const mesh=new THREE.Mesh(geo,material); mesh.position.set(...pos); mesh.rotation.set(...rot); mesh.castShadow=true; parent.add(mesh); return mesh;
    }

    function buildAircraft(parts){
      if(group) scene.remove(group);
      group=new THREE.Group(); patches=[]; scene.add(group);
      const blue=mat("#4da3ff"), white=mat("#f4fbff"), engine=mat("#9aa6ad",{metalness:.55}), tank=mat("#c9a14a"), store=mat("#78858d",{metalness:.35});
      const patchMat=mat("#ffcf5a",{emissive:"#4a2c00",emissiveIntensity:.35});
      for(const part of parts){
        if(part.kind==="sensor") continue;
        const pg=new THREE.Group();
        pg.position.set(part.pose.offset.x*PART,part.pose.offset.y*PART,part.pose.offset.z*PART);
        pg.quaternion.copy(q(part.pose.rotation));
        group.add(pg);
        if(part.kind==="fuselage"){
          addMesh(pg,new THREE.BoxGeometry(part.dims.width*PART,part.dims.height*PART,part.dims.length*PART),blue);
          const nose=addMesh(pg,new THREE.ConeGeometry(Math.max(part.dims.width,part.dims.height)*PART/2,part.dims.height*PART*1.6,20),white,[0,0,-part.dims.length*PART/2-part.dims.height*PART*.6],[Math.PI/2,0,0]);
          nose.castShadow=true;
        } else if(part.kind==="wing"){
          const vertical=part.control?.axis==="yaw";
          const span=part.planform.span*PART, chord=part.planform.chord*PART, thick=.045;
          const dims=vertical?[thick,span,chord]:[span,thick,chord];
          addMesh(pg,new THREE.BoxGeometry(...dims),blue);
          if(part.control){
            if(part.control.axis==="roll"){
              for(const side of [-1,1]){
                const patch=addMesh(pg,new THREE.BoxGeometry(span*.22,thick*1.55,chord*.34),patchMat,[side*span*.31,thick*.72,chord*.32]);
                patches.push({mesh:patch,axis:"roll",side});
              }
            } else if(part.control.axis==="pitch"){
              const patch=addMesh(pg,new THREE.BoxGeometry(span*.72,thick*1.55,chord*.34),patchMat,[0,thick*.72,chord*.32]);
              patches.push({mesh:patch,axis:"pitch",side:1});
            } else {
              const patch=addMesh(pg,new THREE.BoxGeometry(thick*1.8,span*.54,chord*.34),patchMat,[thick*.72,span*.12,chord*.32]);
              patches.push({mesh:patch,axis:"yaw",side:1});
            }
          }
        } else if(part.kind==="engine"){
          addMesh(pg,new THREE.CylinderGeometry(part.dims.radius*PART,part.dims.radius*PART*.85,part.dims.length*PART,20),engine,[0,0,0],[Math.PI/2,0,0]);
        } else if(part.kind==="tank"){
          addMesh(pg,new THREE.CapsuleGeometry(part.dims.radius*PART,part.dims.length*PART,6,12),tank,[0,0,0],[Math.PI/2,0,0]);
        } else if(part.kind==="weapon"){
          addMesh(pg,new THREE.BoxGeometry(part.dims.width*PART,part.dims.height*PART,part.dims.length*PART),store);
        }
      }
    }

    function fmt(n,d=1){ return Number(n).toFixed(d); }
    function clamp01(n){ return Math.max(0,Math.min(1,n)); }
    function row(k,v){ return '<div class="row"><span>'+k+'</span><b>'+v+'</b></div>'; }
    function section(title,rows){ return '<div class="section"><h3>'+title+'</h3>'+rows.join("")+'</div>'; }
    function meter(label,pct,value,kind=""){
      return '<div class="meter '+kind+'"><span>'+label+'</span><div class="track"><div class="fill" style="width:'+(clamp01(pct)*100).toFixed(1)+'%"></div></div><b>'+value+'</b></div>';
    }
    function renderFrame(f,totalFrames){
      if(f.scenarioId!==scenarioId){ scenarioId=f.scenarioId; buildAircraft(f.parts); trailPts=[]; }
      const a=f.aircraft;
      group.position.set(a.position.x*WORLD,a.position.y*WORLD,a.position.z*WORLD);
      group.quaternion.copy(q(a.orientation));
      for(const p of patches){
        p.mesh.rotation.set(0,0,0);
        if(p.axis==="roll") p.mesh.rotation.x = -a.controls.roll*p.side*.5;
        if(p.axis==="pitch") p.mesh.rotation.x = -a.controls.pitch*.5;
        if(p.axis==="yaw") p.mesh.rotation.y = a.controls.yaw*.5;
        const active=Math.abs(a.controls[p.axis])>.05;
        p.mesh.material.color.set(active?"#ffcf5a":"#7f8d91");
        p.mesh.material.emissive.set(active?"#4a2c00":"#000000");
      }
      trailPts.push(group.position.clone());
      if(trailPts.length>110) trailPts.shift();
      trail.geometry.dispose();
      trail.geometry=new THREE.BufferGeometry().setFromPoints(trailPts);

      const orbit=f.t*.22 + (f.scenarioId==="dead-roll"?1.2:0);
      const target=group.position.clone();
      const camOffset=new THREE.Vector3(Math.sin(orbit)*7.5,3.1,Math.cos(orbit)*7.5);
      camera.position.copy(target.clone().add(camOffset));
      camera.lookAt(target);

      document.getElementById("title").textContent=f.title;
      document.getElementById("subtitle").textContent=f.subtitle;
      document.getElementById("phase").textContent="PLAN: "+f.phase;
      const fuelText=a.fuelCapacityKg>0?fmt(a.fuelKg,1)+" / "+fmt(a.fuelCapacityKg,0)+" kg":"tankless";
      document.getElementById("metrics").innerHTML=[
        section("flight meters",[
          row("airspeed",fmt(a.metrics.airspeed,0)+" m/s"),
          row("altitude",fmt(a.metrics.altitude,0)+" m"),
          row("climb",fmt(a.stats.verticalSpeedMps,1)+" m/s"),
          row("distance",fmt(a.stats.downrangeM,0)+" m"),
          row("AoA",fmt(a.metrics.aoaDeg,1)+" deg"),
          row("load",fmt(a.metrics.gLoad,2)+" G")
        ]),
        section("surface state",[
          row("max surf AoA",fmt(a.stats.maxSurfaceAoADeg,1)+" deg"),
          row("stall meter",fmt(a.stats.stallSeverity*100,0)+" %"),
          row("max surf load",fmt(a.stats.maxSurfaceLoadN/1000,1)+" kN"),
          row("stalled",a.metrics.stalled?"yes":"no")
        ]),
        section("airframe physics",[
          row("fuel",fuelText),
          row("mass",fmt(a.stats.effectiveMassKg,0)+" kg"),
          row("CoM x/y/z",fmt(a.com.x,2)+" / "+fmt(a.com.y,2)+" / "+fmt(a.com.z,2)+" m"),
          row("I roll",fmt(a.inertia.roll,0)+" kg m2"),
          row("I pitch/yaw",fmt(a.inertia.pitch,0)+" / "+fmt(a.inertia.yaw,0))
        ]),
        section("body rates",[
          row("roll",fmt(a.angularVelocity.x,2)+" rad/s"),
          row("pitch",fmt(a.angularVelocity.y,2)+" rad/s"),
          row("yaw",fmt(a.angularVelocity.z,2)+" rad/s")
        ])
      ].join("");
      const c=a.controls;
      document.getElementById("controls").innerHTML=[
        ["pitch",c.pitch],["roll",c.roll],["yaw",c.yaw],["throttle",c.throttle]
      ].map(([k,v])=>'<span class="pill '+(Math.abs(v)>.05?"hot":"")+'">'+k+' '+fmt(v,2)+'</span>').join("");
      document.getElementById("gauges").innerHTML=[
        meter("speed",a.metrics.airspeed/240,fmt(a.metrics.airspeed,0)+" m/s"),
        meter("load",a.metrics.gLoad/5,fmt(a.metrics.gLoad,1)+" G",a.metrics.gLoad>3.2?"hot":""),
        meter("stall",a.stats.stallSeverity,fmt(a.stats.stallSeverity*100,0)+"%",a.stats.stallSeverity>.65?"red":a.stats.stallSeverity>.25?"hot":""),
        meter("fuel",a.fuelCapacityKg>0?a.stats.fuelFraction:1,a.fuelCapacityKg>0?fmt(a.fuelKg,1)+" kg":"n/a",a.fuelCapacityKg>0&&a.stats.fuelFraction<.2?"red":"")
      ].join("");
      document.getElementById("prog").style.width=((f.__index+1)/totalFrames*100).toFixed(2)+"%";
      renderer.render(scene,camera);
    }
    window.renderFrame=renderFrame;
    window.__ready=true;
  </script>
</body></html>`;

async function render(frames: DemoFrame[]): Promise<void> {
  const threeDir = "node_modules/three/build";
  const server = http.createServer((req, res) => {
    const url = (req.url ?? "/").split("?")[0];
    if (url === "/") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(HTML);
      return;
    }
    const name = url.replace(/^\//, "");
    if (/^[\w.-]+\.js$/.test(name)) {
      try {
        res.writeHead(200, { "content-type": "application/javascript" });
        res.end(readFileSync(`${threeDir}/${name}`));
        return;
      } catch {
        // fall through
      }
    }
    res.writeHead(404);
    res.end("not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;

  const ff = ffmpeg();
  const ffDone = once(ff, "close");
  const browser = await chromium.launch({
    args: ["--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--use-gl=angle", "--use-angle=swiftshader"],
  });
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(String(err)));
  await page.goto(url);
  await page.waitForFunction("window.__ready === true", undefined, { timeout: 20_000 });

  for (let i = 0; i < frames.length; i += 1) {
    await page.evaluate(
      ({ frame, total, index }) => {
        (frame as unknown as { __index: number }).__index = index;
        (window as unknown as { renderFrame: (f: unknown, totalFrames: number) => void }).renderFrame(frame, total);
      },
      { frame: frames[i], total: frames.length, index: i },
    );
    const png = await page.screenshot({ type: "png" });
    if (!ff.stdin.write(png)) await once(ff.stdin, "drain");
    if (i % 90 === 0) console.error(`  frame ${i}/${frames.length}`);
  }

  ff.stdin.end();
  await browser.close();
  server.close();
  const [code] = (await ffDone) as [number];
  if (code !== 0) {
    throw new Error(`ffmpeg exited ${code}${errors.length ? `; browser: ${errors[0]}` : ""}`);
  }
}

async function main(): Promise<void> {
  const frames = buildFrames();
  console.error(`physics demo: ${scenarios.length} scenes, ${frames.length} frames, ${(frames.length / fps).toFixed(1)}s -> ${out}`);
  await render(frames);
  console.error(`done -> ${out} (${(frames.length / fps).toFixed(1)}s, ${(length(vec3(width, height, 0))).toFixed(0)}px diagonal)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
