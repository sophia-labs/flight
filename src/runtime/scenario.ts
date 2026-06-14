import {
  defensiveController,
  pursuitController,
  pursuitFallback,
} from "../agent/controllers/scripted";
import { perfectSensor } from "../agent/observation";
import { minimalEvaluator } from "../eval/outcome";
import type { MatchReplay } from "../protocol/schema";
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

export function createInitialAircraft(): AircraftState[] {
  const blueVelocity = vec3(112, 2, -118);
  const redVelocity = vec3(-112, 0, 112);

  // Both fly the default airframe; the compiler produces the model + devices (the camera is a part of
  // it). By construction this is byte-identical to the old DEFAULT_MODEL / noseCamera() literals. A
  // fresh airframe per ship so the recorded airframes don't share a mutable reference.
  const blueAirframe = defaultAirframe();
  const redAirframe = defaultAirframe();
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
      devices: red.devices,
      airframe: redAirframe,
    },
  ];
}

// The all-scripted demo as a MatchConfig: blue pursues, red flies defensively. Reproduces the
// v0.1.0 duel, now routed through the pluggable runtime.
export function buildScriptedMatchConfig(turnCount = 28): MatchConfig {
  return {
    id: "demo-merge-001",
    turnDuration: TURN_DURATION,
    frameDt: FRAME_DT,
    maxTurns: turnCount,
    decisionTimeoutMs: 5_000,
    initialAircraft: createInitialAircraft(),
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

export function generateDemoMatch(turnCount = 28): Promise<MatchReplay> {
  return runMatch(buildScriptedMatchConfig(turnCount));
}
