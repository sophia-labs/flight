import {
  defensiveController,
  pursuitFallback,
} from "../agent/controllers/scripted";
import { bodyPilotController } from "../agent/controllers/bodyPilot";
import type { Controller } from "../agent/controller";
import { fixedWingBodyManifest } from "../body/manifest";
import { scriptedFixedWingBodyModel } from "../body/model";
import { perfectSensor } from "../agent/observation";
import { minimalEvaluator } from "../eval/outcome";
import type { Airframe, MatchReplay, Vec3 } from "../protocol/schema";
import { compileAirframe, defaultAirframe } from "../sim/airframe";
import { fullFuelByTank } from "../sim/mass";
import { length, normalize, quatLookRotation, scale, sub, vec3 } from "../sim/math";
import type { AircraftState, FlightMetrics } from "../sim/types";
import { runMatch } from "./match";
import type { MatchConfig } from "./config";

export const TURN_DURATION = 2.4;
export const FRAME_DT = 0.16;

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
export function createBalloonTarget(position: Vec3): AircraftState {
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
export function createBalloonScenarioAircraft(): AircraftState[] {
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

  const blue = compileAirframe(defaultAirframe());
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
      airframe: defaultAirframe(),
    },
    createBalloonTarget(balloonAt),
  ];
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
export function buildBalloonMatchConfig(turnCount = 16): MatchConfig {
  const config = scriptedConfig(createBalloonScenarioAircraft(), turnCount);
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
