import { clamp } from "../../sim/math";
import type { Action, Observation } from "../../protocol/schema";
import type { Controller } from "../controller";

// Geometric pursuit, ported verbatim from the old src/sim/agents.ts but now reading the
// ego-relative Observation instead of omniscient AircraftState. The direction cosines
// (bearingForward/right/up) and closureRate are exactly the dot products the original took.
export function pursuitAction(observation: Observation, aggression: number): Action {
  const enemy = observation.contacts[0];
  if (!enemy) {
    return { kind: "raw-stick", pitch: 0, roll: 0, yaw: 0, throttle: 0.7, trigger: false };
  }

  const targetForward = enemy.bearingForward;
  const targetRight = enemy.bearingRight;
  const targetUp = enemy.bearingUp;
  const closure = enemy.closureRate; // range rate (matches the old `closure`)
  const range = enemy.range;
  const leadBias = clamp(closure / 180, -0.28, 0.28);
  const throttle = range > 850 ? 0.97 : range < 420 && closure < -25 ? 0.46 : 0.76;

  return {
    kind: "raw-stick",
    pitch: clamp(targetUp * 3.2 + leadBias * 0.25, -1, 1),
    roll: clamp(targetRight * (2.35 + aggression * 0.5), -1, 1),
    yaw: clamp(targetRight * 1.2, -1, 1),
    throttle,
    trigger:
      targetForward > 0.975 &&
      Math.abs(targetRight) < 0.13 &&
      Math.abs(targetUp) < 0.13 &&
      range < 1_050,
  };
}

export function pursuitController(aggression = 0.82): Controller {
  return async (observation) => ({
    action: pursuitAction(observation, aggression),
    rationale: "pursuit",
  });
}

export function defensiveController(aggression = 0.64): Controller {
  return async (observation, context) => {
    const base = pursuitAction(observation, aggression);
    const phase = context.turn;
    const weave = Math.sin(phase * 0.9) * 0.34;
    const vertical = Math.cos(phase * 0.7) * 0.22;
    return {
      action: {
        kind: "raw-stick",
        pitch: clamp(base.pitch + vertical, -1, 1),
        roll: clamp(base.roll + weave, -1, 1),
        yaw: base.yaw,
        throttle: Math.max(0.68, base.throttle),
        trigger: base.trigger,
      },
      rationale: "defensive",
    };
  };
}

// Default fallback for a failed/timed-out external pilot: keep maneuvering with scripted pursuit.
export function pursuitFallback(observation: Observation): Action {
  return pursuitAction(observation, 0.82);
}
