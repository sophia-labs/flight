import { clamp } from "../../sim/math";
import type { Action, FlightDirectorAction, Observation } from "../../protocol/schema";
import type { Controller } from "../controller";

const RAD2DEG = 180 / Math.PI;

// Geometric pursuit, ported verbatim from the old src/sim/agents.ts but now reading the
// ego-relative Observation instead of omniscient AircraftState. The direction cosines
// (bearingForward/right/up) and closureRate are exactly the dot products the original took.
export function pursuitAction(observation: Observation, aggression: number): FlightDirectorAction {
  const enemy = observation.contacts[0];
  if (!enemy) {
    return {
      kind: "flight-director",
      targetBankDeg: 0,
      targetLoadG: 1,
      throttle: 0.7,
      speedPriority: "hold",
      trigger: false,
    };
  }

  const targetForward = enemy.bearingForward;
  const targetRight = enemy.bearingRight;
  const targetUp = enemy.bearingUp;
  const closure = enemy.closureRate; // range rate (matches the old `closure`)
  const range = enemy.range;
  const throttle = range > 850 ? 0.97 : range < 420 && closure < -25 ? 0.46 : 0.76;
  const liftVectorBank = Math.atan2(targetRight, Math.max(targetUp, 0.08)) * RAD2DEG;
  const bankDemand =
    targetForward < -0.2
      ? clamp((targetRight >= 0 ? 1 : -1) * (68 + aggression * 14), -88, 88)
      : clamp(liftVectorBank * (0.82 + aggression * 0.18), -88, 88);
  const angularError = Math.acos(clamp(targetForward, -1, 1)) / Math.PI;
  const speedLimit =
    observation.self.airspeed < 115 ? 1.8 : observation.self.airspeed < 145 ? 2.6 : observation.self.airspeed < 175 ? 3.3 : 4.1;
  const loadDemand = clamp(1.02 + aggression * 0.85 + angularError * 1.65 + Math.max(targetUp, 0) * 0.4, 0.7, speedLimit);
  const speedPriority = range > 900 || observation.self.airspeed < 118 ? "gain" : range < 420 ? "bleed" : "hold";

  return {
    kind: "flight-director",
    targetBankDeg: bankDemand,
    targetLoadG: loadDemand,
    throttle,
    speedPriority,
    trigger:
      targetForward > 0.975 &&
      Math.abs(targetRight) < 0.17 &&
      Math.abs(targetUp) < 0.17 &&
      range < 1_140,
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
    const weave = Math.sin(phase * 0.9) * 10;
    const unload = Math.cos(phase * 0.7) * 0.35;
    return {
      action: {
        kind: "flight-director",
        targetBankDeg: clamp(base.targetBankDeg + weave, -88, 88),
        targetLoadG: clamp(base.targetLoadG + unload, 0.6, 5.8),
        throttle: Math.max(0.68, base.throttle),
        speedPriority: base.speedPriority,
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
