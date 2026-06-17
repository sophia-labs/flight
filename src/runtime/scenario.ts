import {
  defensiveController,
  pursuitFallback,
} from "../agent/controllers/scripted";
import { bodyPilotController } from "../agent/controllers/bodyPilot";
import type { Controller } from "../agent/controller";
import { perfectSensor } from "../agent/observation";
import { fixedWingBodyManifest } from "../body/manifest";
import { scriptedFixedWingBodyModel } from "../body/model";
import { minimalEvaluator } from "../eval/outcome";
import type { Airframe, MatchReplay, Vec3 } from "../protocol/schema";
import { airframeFromArchetype } from "../sim/aircraftCatalog";
import { compileAirframe, defaultAirframe } from "../sim/airframe";
import { fullFuelByTank } from "../sim/mass";
import { add, clamp, length, normalize, quatLookRotation, scale, sub, vec3 } from "../sim/math";
import type { AircraftState, FlightMetrics, WeaponStation } from "../sim/types";
import { runMatch } from "./match";
import type { MatchConfig } from "./config";

export const TURN_DURATION = 2.4;
export const FRAME_DT = 0.16;

export type ScenarioRunKind = "duel" | "stern-gun" | "balloon" | "balloon-hard" | "bvr-intercept";

export interface ScenarioRunConfig {
  kind: ScenarioRunKind;
  turnCount: number;
}

const INITIAL_METRICS: FlightMetrics = {
  airspeed: 0,
  altitude: 0,
  aoaDeg: 0,
  gLoad: 1,
  stalled: false,
};

// Build the two duelists. The compiler produces each aircraft's model + devices (the camera is a part).
// Both default to the default airframe — byte-identical to the old DEFAULT_MODEL / noseCamera() literals
// — but a custom blue airframe is how "Fly this" sends a built plane into a duel against the default.
export function createInitialAircraft(
  blueAirframe: Airframe = defaultAirframe(),
  redAirframe: Airframe = defaultAirframe(),
): AircraftState[] {
  const blueVelocity = vec3(112, 2, -118);
  const redVelocity = vec3(-112, 0, 112);

  const blue = compileAirframe(blueAirframe);
  const red = compileAirframe(redAirframe);

  return [
    {
      id: "blue-1",
      callsign: "Blue Kite",
      team: "blue",
      color: "#4da3ff",
      position: vec3(-960, 1_080, 860),
      velocity: blueVelocity,
      orientation: quatLookRotation(blueVelocity),
      controls: { pitch: 0, roll: 0, yaw: 0, throttle: 0.86, trigger: false },
      health: 100,
      weaponCooldown: 1.1,
      model: blue.model,
      metrics: { ...INITIAL_METRICS, airspeed: length(blueVelocity), altitude: 1_080 },
      angularVelocity: vec3(0, 0, 0),
      fuelKg: blue.model.fuelCapacityKg,
      fuelByTankKg: fullFuelByTank(blue.model),
      devices: blue.devices,
      airframe: blueAirframe,
    },
    {
      id: "red-1",
      callsign: "Red Anvil",
      team: "red",
      color: "#ff6b61",
      position: vec3(980, 1_020, -760),
      velocity: redVelocity,
      orientation: quatLookRotation(redVelocity),
      controls: { pitch: 0, roll: 0, yaw: 0, throttle: 0.82, trigger: false },
      health: 100,
      weaponCooldown: 0.4,
      model: red.model,
      metrics: { ...INITIAL_METRICS, airspeed: length(redVelocity), altitude: 1_020 },
      angularVelocity: vec3(0, 0, 0),
      fuelKg: red.model.fuelCapacityKg,
      fuelByTankKg: fullFuelByTank(red.model),
      devices: red.devices,
      airframe: redAirframe,
    },
  ];
}

// A close stern-start duel for live Body iteration: both aircraft are dynamic and flown by whatever
// agents the MatchConfig attaches, but blue starts with a real gunsight solution on red. This keeps
// prompt/setup experiments cheap: if the Body reads the field correctly, a projectile should be born
// immediately and the replay can prove whether the simulated round actually connects.
export function createDuelGunStartAircraft(
  blueAirframe: Airframe = defaultAirframe(),
  redAirframe: Airframe = defaultAirframe(),
): AircraftState[] {
  const blueVelocity = vec3(0, 0, -165);
  const redVelocity = vec3(0, 0, -135);

  const blue = compileAirframe(blueAirframe);
  const red = compileAirframe(redAirframe);

  return [
    {
      id: "blue-1",
      callsign: "Blue Kite",
      team: "blue",
      color: "#4da3ff",
      position: vec3(0, 1_260, 900),
      velocity: blueVelocity,
      orientation: quatLookRotation(blueVelocity),
      controls: { pitch: 0, roll: 0, yaw: 0, throttle: 0.92, trigger: false },
      health: 100,
      weaponCooldown: 0,
      model: blue.model,
      metrics: { ...INITIAL_METRICS, airspeed: length(blueVelocity), altitude: 1_260 },
      angularVelocity: vec3(0, 0, 0),
      fuelKg: blue.model.fuelCapacityKg,
      fuelByTankKg: fullFuelByTank(blue.model),
      devices: blue.devices,
      airframe: blueAirframe,
    },
    {
      id: "red-1",
      callsign: "Red Anvil",
      team: "red",
      color: "#ff6b61",
      position: vec3(0, 1_260, 560),
      velocity: redVelocity,
      orientation: quatLookRotation(redVelocity),
      controls: { pitch: 0, roll: 0, yaw: 0, throttle: 0.84, trigger: false },
      health: 100,
      weaponCooldown: 0,
      model: red.model,
      metrics: { ...INITIAL_METRICS, airspeed: length(redVelocity), altitude: 1_260 },
      angularVelocity: vec3(0, 0, 0),
      fuelKg: red.model.fuelCapacityKg,
      fuelByTankKg: fullFuelByTank(red.model),
      devices: red.devices,
      airframe: redAirframe,
    },
  ];
}

// A less-instant live-Body duel: blue starts in a stern-quarter pursuit rather than already welded to
// the crosshair, red is dynamic and turning, and blue's gun starts cold for a few seconds. The first
// shot should therefore happen after a visible chase/lineup instead of on frame one.
export function createDuelDogfightStartAircraft(
  blueAirframe: Airframe = defaultAirframe(),
  redAirframe: Airframe = defaultAirframe(),
): AircraftState[] {
  const blueVelocity = vec3(12, 0, -165);
  const redVelocity = vec3(-12, 0, -140);

  const blue = compileAirframe(blueAirframe);
  const red = compileAirframe(redAirframe);

  return [
    {
      id: "blue-1",
      callsign: "Blue Kite",
      team: "blue",
      color: "#4da3ff",
      position: vec3(-80, 1_260, 1_060),
      velocity: blueVelocity,
      orientation: quatLookRotation(blueVelocity),
      controls: { pitch: 0, roll: 0, yaw: 0, throttle: 0.94, trigger: false },
      health: 100,
      weaponCooldown: 0,
      model: blue.model,
      metrics: { ...INITIAL_METRICS, airspeed: length(blueVelocity), altitude: 1_260 },
      angularVelocity: vec3(0, 0, 0),
      fuelKg: blue.model.fuelCapacityKg,
      fuelByTankKg: fullFuelByTank(blue.model),
      devices: blue.devices,
      airframe: blueAirframe,
    },
    {
      id: "red-1",
      callsign: "Red Anvil",
      team: "red",
      color: "#ff6b61",
      position: vec3(20, 1_260, 380),
      velocity: redVelocity,
      orientation: quatLookRotation(redVelocity),
      controls: { pitch: 0.02, roll: -0.1, yaw: -0.04, throttle: 0.86, trigger: false },
      health: 100,
      weaponCooldown: 2.8,
      model: red.model,
      metrics: { ...INITIAL_METRICS, airspeed: length(redVelocity), altitude: 1_260 },
      angularVelocity: vec3(0, 0, 0),
      fuelKg: red.model.fuelCapacityKg,
      fuelByTankKg: fullFuelByTank(red.model),
      devices: red.devices,
      airframe: redAirframe,
    },
  ];
}

// --- v0.8.x balloon target: the project's founding challenge made real ---------------------------
// A tethered RED balloon that hovers in place (AircraftState.static skips flight integration) and never
// fires (no-op controller, trigger stays false). It lives in the world `aircraft` list so perception,
// the scripted Pilot's nearest-enemy Observation, and resolveWeapons all treat it as an ordinary
// contact with health — the Body acquires + engages it through the exact combat stack. It is fat
// (perceivedRadiusM ⇒ a big glyph from far away) and fragile (low health ⇒ one good burst kills it).
export function createBalloonTarget(position: Vec3, heatSignatureOverride?: number): AircraftState {
  return {
    id: "balloon",
    callsign: "Red Balloon",
    team: "red",
    color: "#ff5da3",
    position,
    velocity: vec3(0, 0, 0),
    orientation: quatLookRotation(vec3(0, 0, -1)),
    controls: { pitch: 0, roll: 0, yaw: 0, throttle: 0, trigger: false },
    health: 12, // fragile: one gun burst (the balloon damage band is 12-30) pops it
    weaponCooldown: 0,
    model: compileAirframe(defaultAirframe()).model, // unused (static skips integration) but keeps the shape valid
    metrics: { ...INITIAL_METRICS, airspeed: 0, altitude: position.y },
    angularVelocity: vec3(0, 0, 0),
    fuelKg: 0,
    static: true,
    perceivedRadiusM: 42, // ~84 m apparent span: a fat '@' glyph well before gun range
    // A "cold" gun balloon omits this (stays invisible to IR); a thermal/flare balloon sets it so an
    // AIM-9 can lock it. Default-undefined keeps every existing balloon scenario byte-identical.
    ...(heatSignatureOverride !== undefined ? { heatSignatureOverride } : {}),
  };
}

// An AIM-9M-class heat-seeking rail on the nose boresight, one round. Mirrors the catalog F-14's missile
// station shape so resolveWeapons' firstLoadedMissileStation path launches it on the ordinary trigger —
// no new fire contract. count=1 means ammoForStation reads 1 without seeding weaponAmmo.
function aim9Station(): WeaponStation {
  return {
    id: "aim-9m-rail",
    kind: "missile",
    guidance: "heat-seeking",
    count: 1,
    caliberMm: 127,
    localOffset: vec3(0, -0.4, -0.6),
    localForward: vec3(0, 0, -1),
  };
}

// Bolt a missile station onto a compiled aircraft (the default model carries none). With one loaded, a
// trigger pull launches the AIM-9 instead of a bullet (resolveWeapons), reusing the existing fire path.
function armWithMissile(state: AircraftState): AircraftState {
  return {
    ...state,
    model: { ...state.model, weaponStations: [...state.model.weaponStations, aim9Station()] },
  };
}

// Holds the trigger while flying straight — fires the loaded AIM-9 as soon as cooldown allows. A TEST
// FIXTURE for the missile-harness proof (deterministic, no creds), NOT live flight behaviour.
export const missileTriggerController: Controller = async () => ({
  action: { kind: "raw-stick", reason: "fox-2", pitch: 0, roll: 0, yaw: 0, throttle: 0.9, trigger: true },
  rationale: "fox-2: hold trigger to launch the loaded heat-seeker",
});

// v0.10.x basic combat harness: the 5 km heat-seeker shot the gun engagement geometrically cannot make.
// Blue starts ~5 km dead ahead of a HOT (thermal/flare) balloon at co-altitude, carrying one AIM-9M. At
// 5 km the balloon's IR signal (heat/rangeKm^2 = 10/25 = 0.4) clears the seeker min-lock (0.2), so a
// trigger pull launches a missile that PN-guides to the kill.
export function createMissileBalloonScenarioAircraft(blueAirframe: Airframe = defaultAirframe()): AircraftState[] {
  const blueStart = vec3(0, 1_300, 5_000);
  const balloonAt = vec3(0, 1_300, 0);
  const blueVelocity = scale(normalize(sub(balloonAt, blueStart)), 205);
  const blue = compileAirframe(blueAirframe);
  const shooter: AircraftState = {
    id: "blue-1",
    callsign: "Blue Kite",
    team: "blue",
    color: "#4da3ff",
    position: blueStart,
    velocity: blueVelocity,
    orientation: quatLookRotation(blueVelocity),
    controls: { pitch: 0, roll: 0, yaw: 0, throttle: 0.9, trigger: false },
    health: 100,
    weaponCooldown: 0,
    model: blue.model,
    metrics: { ...INITIAL_METRICS, airspeed: length(blueVelocity), altitude: blueStart.y },
    angularVelocity: vec3(0, 0, 0),
    fuelKg: blue.model.fuelCapacityKg,
    fuelByTankKg: fullFuelByTank(blue.model),
    devices: blue.devices,
    airframe: blueAirframe,
  };
  return [armWithMissile(shooter), createBalloonTarget(balloonAt, 10)];
}

// Scripted proof of the missile harness: blue flies straight and holds the trigger; the AIM-9 locks the
// hot balloon and kills it. Deterministic (no creds) — proves launch + IR lock + intercept end to end.
export function buildMissileBalloonMatchConfig(turnCount = 8): MatchConfig {
  return {
    id: "missile-balloon-proof-001",
    turnDuration: TURN_DURATION,
    frameDt: FRAME_DT,
    maxTurns: turnCount,
    decisionTimeoutMs: 5_000,
    initialAircraft: createMissileBalloonScenarioAircraft(),
    sensor: perfectSensor,
    evaluator: minimalEvaluator,
    fallback: pursuitFallback,
    agents: {
      "blue-1": {
        meta: { id: "blue-1", kind: "scripted", label: "missile shooter (scripted trigger)" },
        controller: missileTriggerController,
      },
      balloon: {
        meta: { id: "balloon", kind: "scripted", label: "balloon (static, hot)" },
        controller: staticController,
      },
    },
  };
}

// A no-op controller: a static balloon is never flown. It returns a neutral raw-stick (zeros, no
// trigger) so the match loop has a valid action for it, though stepSimulation skips its integration.
export const staticController: Controller = async () => ({
  action: { kind: "raw-stick", reason: "static balloon", pitch: 0, roll: 0, yaw: 0, throttle: 0, trigger: false },
  rationale: "balloon (static)",
});

// The balloon scenario: a single Blue Body, starting ~4-6 km out at a similar/slightly-lower altitude,
// must navigate to + pop a hovering red balloon. "Longer distance + more flight time" — the Body manages
// energy by cruising/diving but climbs poorly, so the balloon is placed level-to-slightly-above.
export function createBalloonScenarioAircraft(blueAirframe: Airframe = defaultAirframe()): AircraftState[] {
  // Blue Body up and to one side; balloon ~2.8 km ahead and ~100 m BELOW (a shallow dive — the Body
  // manages energy by diving and cruises well, but climbs poorly, so the target sits a touch lower than
  // its start, never above it). With REAL projectiles (v0.9.x) the gun is no longer a forgiving cone, so
  // the Body must be inside the ~2.9 km round-reach while STILL lined up — before its dive reflex
  // scatters the geometry. 2.8 km gives the assisted sear several early aligned ticks instead of a
  // single knife-edge frame.
  const blueStart = vec3(-2_750, 1_320, 2_550);
  const balloonAt = vec3(-691, 1_222, 655);
  const heading = sub(balloonAt, blueStart); // point the Body roughly at the balloon at spawn
  const blueVelocity = scale(normalize(heading), 150);

  const blue = compileAirframe(blueAirframe);
  return [
    {
      id: "blue-1",
      callsign: "Blue Kite",
      team: "blue",
      color: "#4da3ff",
      position: blueStart,
      velocity: blueVelocity,
      orientation: quatLookRotation(blueVelocity),
      controls: { pitch: 0, roll: 0, yaw: 0, throttle: 0.92, trigger: false },
      health: 100,
      weaponCooldown: 0.4,
      model: blue.model,
      metrics: { ...INITIAL_METRICS, airspeed: length(blueVelocity), altitude: blueStart.y },
      angularVelocity: vec3(0, 0, 0),
      fuelKg: blue.model.fuelCapacityKg,
      fuelByTankKg: fullFuelByTank(blue.model),
      devices: blue.devices,
      airframe: blueAirframe,
    },
    createBalloonTarget(balloonAt),
  ];
}

// Longer, off-axis balloon intercept for the motor-program + twitch Body loop. Blue starts farther out
// and pointed slightly right of the target, so the slow planner has to fly a smooth intercept before
// the held weapons_free guard hands off to the twitch Body near the guns cone.
export function createChallengingBalloonScenarioAircraft(blueAirframe: Airframe = defaultAirframe()): AircraftState[] {
  const blueStart = vec3(-5_250, 1_520, 3_650);
  const balloonAt = vec3(-760, 1_235, 240);
  const toBalloon = sub(balloonAt, blueStart);
  const offsetAim = add(toBalloon, vec3(720, 0, 0));
  const blueVelocity = scale(normalize(offsetAim), 168);

  const blue = compileAirframe(blueAirframe);
  return [
    {
      id: "blue-1",
      callsign: "Blue Kite",
      team: "blue",
      color: "#4da3ff",
      position: blueStart,
      velocity: blueVelocity,
      orientation: quatLookRotation(blueVelocity),
      controls: { pitch: 0, roll: 0, yaw: 0, throttle: 0.94, trigger: false },
      health: 100,
      weaponCooldown: 0.2,
      model: blue.model,
      metrics: { ...INITIAL_METRICS, airspeed: length(blueVelocity), altitude: blueStart.y },
      angularVelocity: vec3(0, 0, 0),
      fuelKg: blue.model.fuelCapacityKg,
      fuelByTankKg: fullFuelByTank(blue.model),
      devices: blue.devices,
      airframe: blueAirframe,
    },
    createBalloonTarget(balloonAt),
  ];
}

// v0.10.x agent-facing combat: a HOT (IR) balloon and Blue carrying an AIM-9, but harder than a turn-1
// snapshot — Blue starts ~8.5 km out with the balloon ~35 deg off the nose (OUTSIDE the 38 deg seeker
// cone), so the planner must TURN to bring it into the seeker AND CLOSE inside the ~6.3 km lock range
// (heat=8) before the FOX-2 sear (match.ts) can release. A gun kill here is geometrically hopeless
// (would-hit=NEVER); the heat-seeker is the answer, but the planner has to orient and set it up first.
export function createChallengingMissileScenarioAircraft(blueAirframe: Airframe = defaultAirframe()): AircraftState[] {
  const balloonAt = vec3(-760, 1_235, 240);
  const blueStart = vec3(-6_900, 1_640, 6_150); // ~8.5 km out
  const dir = normalize(sub(balloonAt, blueStart));
  // Rotate the nose ~35 deg off the target in the horizontal plane so it starts outside the seeker cone.
  const yaw = (35 * Math.PI) / 180;
  const heading = vec3(
    dir.x * Math.cos(yaw) - dir.z * Math.sin(yaw),
    dir.y,
    dir.x * Math.sin(yaw) + dir.z * Math.cos(yaw),
  );
  const blueVelocity = scale(heading, 195);
  const blue = compileAirframe(blueAirframe);
  const shooter: AircraftState = {
    id: "blue-1",
    callsign: "Blue Kite",
    team: "blue",
    color: "#4da3ff",
    position: blueStart,
    velocity: blueVelocity,
    orientation: quatLookRotation(blueVelocity),
    controls: { pitch: 0, roll: 0, yaw: 0, throttle: 0.9, trigger: false },
    health: 100,
    weaponCooldown: 0,
    model: blue.model,
    metrics: { ...INITIAL_METRICS, airspeed: length(blueVelocity), altitude: blueStart.y },
    angularVelocity: vec3(0, 0, 0),
    fuelKg: blue.model.fuelCapacityKg,
    fuelByTankKg: fullFuelByTank(blue.model),
    devices: blue.devices,
    airframe: blueAirframe,
  };
  return [armWithMissile(shooter), createBalloonTarget(balloonAt, 8)];
}

// Holds a straight motor-program tape with a weapons_free guard armed — the no-twitch FOX-2 path. The
// missile sear (match.ts) releases the AIM-9 when the IR lock goes live. Test fixture, no creds.
export const motorProgramArmController: Controller = async () => ({
  action: {
    kind: "motor-program",
    durationMs: 2_500,
    sampleDtMs: 50,
    samples: [
      { tMs: 0, pitch: 0, roll: 0, yaw: 0, throttle: 0.9, trigger: false },
      { tMs: 2_500, pitch: 0, roll: 0, yaw: 0, throttle: 0.9, trigger: false },
    ],
    heldActions: [{ kind: "weapons_free", condition: "ir_lock" }],
  },
  rationale: "fox-2 armed; sear fires on IR lock",
});

// Deterministic proof of the AGENT-FACING missile path: a motor-program planner that arms weapons_free,
// flown with no reflex Body, fires the FOX-2 via the IR sear and pops the hot balloon. Uses the EASY
// dead-ahead scenario so the straight-flying fixture controller acquires the lock without maneuvering
// (the harder createChallengingMissileScenarioAircraft is for the live planner that can turn).
export function buildMissileSearMatchConfig(turnCount = 6): MatchConfig {
  return {
    id: "missile-sear-proof-001",
    turnDuration: TURN_DURATION,
    frameDt: FRAME_DT,
    maxTurns: turnCount,
    decisionTimeoutMs: 5_000,
    initialAircraft: createMissileBalloonScenarioAircraft(),
    sensor: perfectSensor,
    evaluator: minimalEvaluator,
    fallback: pursuitFallback,
    agents: {
      "blue-1": {
        meta: { id: "blue-1", kind: "scripted", label: "motor-program FOX-2 (sear)" },
        controller: motorProgramArmController,
      },
      balloon: {
        meta: { id: "balloon", kind: "scripted", label: "balloon (static, hot)" },
        controller: staticController,
      },
    },
  };
}

// The all-scripted duel as a MatchConfig: blue pursues, red flies defensively. Reproduces the v0.1.0
// duel, now routed through the pluggable runtime. The aircraft (and thus their airframes) are injected
// so the same scripted match can fly a built plane against the default.
function scriptedConfig(initialAircraft: AircraftState[], turnCount: number): MatchConfig {
  return {
    id: "demo-merge-001",
    turnDuration: TURN_DURATION,
    frameDt: FRAME_DT,
    maxTurns: turnCount,
    decisionTimeoutMs: 5_000,
    initialAircraft,
    sensor: perfectSensor,
    evaluator: minimalEvaluator,
    fallback: pursuitFallback,
    agents: {
      "blue-1": {
        meta: {
          id: "blue-1",
          kind: "scripted",
          label: "embodied body pilot",
          config: { bodyId: fixedWingBodyManifest.bodyId, bodyTickDt: fixedWingBodyManifest.bodyTickDt },
        },
        controller: bodyPilotController(0.78),
        body: {
          manifest: fixedWingBodyManifest,
          model: scriptedFixedWingBodyModel,
        },
      },
      "red-1": {
        meta: { id: "red-1", kind: "scripted", label: "defensive" },
        controller: defensiveController(0.64),
      },
    },
  };
}

export function buildScriptedMatchConfig(turnCount = 28): MatchConfig {
  return scriptedConfig(createInitialAircraft(), turnCount);
}

// The scripted balloon match: the embodied Body (blue-1) vs a static balloon. Same controllers/seam as
// the duel, but red is the hovering no-op balloon. Used by the balloon verification test and as the
// scripted reference for the deepseek film. Longer fuse (more turns) to navigate + acquire + pop it.
export function buildBalloonMatchConfig(turnCount = 16, blueAirframe: Airframe = defaultAirframe()): MatchConfig {
  const config = scriptedConfig(createBalloonScenarioAircraft(blueAirframe), turnCount);
  return {
    ...config,
    id: "balloon-hunt-001",
    agents: {
      "blue-1": config.agents["blue-1"],
      balloon: {
        meta: { id: "balloon", kind: "scripted", label: "balloon (static)" },
        controller: staticController,
      },
    },
  };
}

export function generateBalloonMatch(turnCount = 16): Promise<MatchReplay> {
  return runMatch(buildBalloonMatchConfig(turnCount));
}

export function generateDemoMatch(turnCount = 28): Promise<MatchReplay> {
  return runMatch(buildScriptedMatchConfig(turnCount));
}

// "Fly this": a built (blue) airframe duels the default (red) under the scripted controllers — fully
// deterministic, no credentials. The recorded replay carries both airframes, so the viewer renders the
// plane you built flying it. Flying a build with a real LLM stays on the headless film/sweep path.
export function buildAirframeMatchConfig(blueAirframe: Airframe, turnCount = 28): MatchConfig {
  return scriptedConfig(createInitialAircraft(blueAirframe, defaultAirframe()), turnCount);
}

export function generateAirframeMatch(blueAirframe: Airframe, turnCount = 28): Promise<MatchReplay> {
  return runMatch(buildAirframeMatchConfig(blueAirframe, turnCount));
}


// A sightseeing prop plane puttering along at low altitude, completely unarmed and unhurried.
export const gentlePropController: Controller = async (observation) => {
  const desiredAltitude = 2_500;
  const altError = desiredAltitude - observation.self.altitude;
  const pitch = Math.max(-0.12, Math.min(0.12, altError * 0.003));
  const throttle = Math.max(0.35, Math.min(0.65, 0.46 + altError * 0.0005));
  return {
    action: {
      kind: "raw-stick",
      pitch,
      roll: 0,
      yaw: 0,
      throttle,
      trigger: false,
    },
    rationale: "gentle sightseeing cruise",
  };
};


// F-14 starts far from a tiny civilian prop plane, navigating on a GCI datum until its nose radar
// acquires the target. The prop plane has no radar and no weapons.
export function createBvrInterceptAircraft(
  blueAirframe: Airframe = airframeFromArchetype("variable-sweep-tomcat"),
): AircraftState[] {
  const f14Airframe = blueAirframe;
  const propAirframe = airframeFromArchetype("day-tripper");
  const f14Compiled = compileAirframe(f14Airframe);
  const propCompiled = compileAirframe(propAirframe);

  const propPosition = vec3(0, 2_500, 0);
  const propVelocity = vec3(55, 0, 0);
  const f14Position = vec3(0, 2_500, -42_400);
  const f14Velocity = vec3(0, 0, 420);
  const prop: AircraftState = {
    id: "prop-1",
    callsign: "Day Tripper",
    team: "red",
    color: "#f4c95d",
    position: propPosition,
    velocity: propVelocity,
    orientation: quatLookRotation(propVelocity),
    controls: { pitch: 0, roll: 0, yaw: 0, throttle: 0.46, trigger: false },
    health: 100,
    weaponCooldown: 0,
    model: propCompiled.model,
    metrics: { ...INITIAL_METRICS, airspeed: length(propVelocity), altitude: 2_500 },
    angularVelocity: vec3(0, 0, 0),
    fuelKg: propCompiled.model.fuelCapacityKg,
    fuelByTankKg: fullFuelByTank(propCompiled.model),
    devices: propCompiled.devices,
    airframe: propAirframe,
  };

  const f14: AircraftState = {
    id: "blue-1",
    callsign: "Tomcat-1",
    team: "blue",
    color: "#4da3ff",
    position: f14Position,
    velocity: f14Velocity,
    orientation: quatLookRotation(f14Velocity),
    controls: { pitch: 0, roll: 0, yaw: 0, throttle: 0.92, trigger: false },
    health: 100,
    weaponCooldown: 0.2,
    model: f14Compiled.model,
    metrics: { ...INITIAL_METRICS, airspeed: length(f14Velocity), altitude: 2_500 },
    angularVelocity: vec3(0, 0, 0),
    fuelKg: f14Compiled.model.fuelCapacityKg,
    fuelByTankKg: fullFuelByTank(f14Compiled.model),
    devices: f14Compiled.devices,
    airframe: f14Airframe,
  };

  return [f14, prop];
}

export function buildBvrInterceptMatchConfig(turnCount = 30, blueAirframe?: Airframe): MatchConfig {
  void turnCount;
  void blueAirframe;
  throw new Error("BVR intercept requires the server scenario runner so it can use a live radar-limited pilot");
}

export function generateBvrInterceptMatch(turnCount = 30): Promise<MatchReplay> {
  return runMatch(buildBvrInterceptMatchConfig(turnCount));
}


export function buildScenarioMatchConfig(blueAirframe: Airframe, scenario: ScenarioRunConfig): MatchConfig {
  const turnCount = normalizedTurnCount(scenario.turnCount);
  if (scenario.kind === "stern-gun") {
    return {
      ...scriptedConfig(createDuelGunStartAircraft(blueAirframe, defaultAirframe()), turnCount),
      id: "stern-gun-start-001",
    };
  }
  if (scenario.kind === "balloon") {
    return buildBalloonMatchConfig(turnCount, blueAirframe);
  }
  if (scenario.kind === "balloon-hard") {
    const config = scriptedConfig(createChallengingBalloonScenarioAircraft(blueAirframe), turnCount);
    return {
      ...config,
      id: "hard-balloon-intercept-001",
      agents: {
        "blue-1": config.agents["blue-1"],
        balloon: {
          meta: { id: "balloon", kind: "scripted", label: "balloon (static)" },
          controller: staticController,
        },
      },
    };
  }
  if (scenario.kind === "bvr-intercept") {
    return buildBvrInterceptMatchConfig(turnCount, blueAirframe);
  }
  return buildAirframeMatchConfig(blueAirframe, turnCount);
}

export function generateScenarioMatch(
  blueAirframe: Airframe,
  scenario: ScenarioRunConfig,
  onProgress?: (progress: import("./config").MatchProgress) => void,
): Promise<MatchReplay> {
  return runMatch({ ...buildScenarioMatchConfig(blueAirframe, scenario), onProgress });
}

function normalizedTurnCount(turnCount: number): number {
  return Math.max(1, Math.min(80, Math.round(Number.isFinite(turnCount) ? turnCount : 2)));
}
