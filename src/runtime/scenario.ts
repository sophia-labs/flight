import {
  defensiveController,
  pursuitController,
  pursuitFallback,
} from "../agent/controllers/scripted";
import { perfectSensor } from "../agent/observation";
import { minimalEvaluator } from "../eval/outcome";
import type { Airframe, MatchReplay } from "../protocol/schema";
import { compileAirframe, defaultAirframe } from "../sim/airframe";
import { length, quatLookRotation, vec3 } from "../sim/math";
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
      devices: red.devices,
      airframe: redAirframe,
    },
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
        meta: { id: "blue-1", kind: "scripted", label: "pursuit" },
        controller: pursuitController(0.82),
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
