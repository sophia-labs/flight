import { clamp } from "../../sim/math";
import type { Observation, PilotIntentAction } from "../../protocol/schema";
import type { Controller } from "../controller";

function sideToken(right: number) {
  if (Math.abs(right) < 0.12) return "center";
  return right < 0 ? "left" : "right";
}

function verticalToken(up: number) {
  if (Math.abs(up) < 0.12) return "level";
  return up > 0 ? "above" : "below";
}

export function bodyPursuitIntent(observation: Observation, aggression = 0.72): PilotIntentAction {
  const enemy = observation.contacts[0];
  const self = observation.self;
  if (!enemy) {
    return {
      kind: "pilot-intent",
      goal: "keep the aircraft controlled while searching for the target",
      urgency: 0.25,
      riskTolerance: 0.35,
      style: "careful",
      constraints: ["do_not_crash", "avoid_stall", "keep_energy"],
      attention: [`airspeed_${Math.round(self.airspeed)}`, `altitude_${Math.round(self.altitude)}`],
      trigger: false,
    };
  }

  const side = sideToken(enemy.bearingRight);
  const vertical = verticalToken(enemy.bearingUp);
  const rangeBand = enemy.range < 450 ? "close" : enemy.range < 1000 ? "near" : "far";
  const lowEnergy = self.airspeed < 116 || self.stalled;
  const lowAltitude = self.altitude < 260;
  const urgency = clamp(
    0.22 + aggression * 0.36 + (enemy.bearingForward < 0 ? 0.22 : 0) + (enemy.range < 650 ? 0.18 : 0),
    0,
    1,
  );
  const riskTolerance = clamp(
    aggression - (lowEnergy ? 0.26 : 0) - (lowAltitude ? 0.18 : 0) + (rangeBand === "near" ? 0.08 : 0),
    0.18,
    0.88,
  );
  const trigger =
    enemy.bearingForward > 0.976 &&
    Math.abs(enemy.bearingRight) < 0.16 &&
    Math.abs(enemy.bearingUp) < 0.16 &&
    enemy.range < 1_080 &&
    self.weaponCooldown <= 0.05;

  return {
    kind: "pilot-intent",
    goal:
      lowEnergy || self.stalled
        ? `recover energy, then turn ${side} toward the target`
        : `turn ${side} toward the ${rangeBand} target and line up without losing the wing`,
    urgency,
    riskTolerance,
    style: lowEnergy ? "body_first" : aggression > 0.75 ? "reckless_but_survivable" : "controlled_aggression",
    constraints: [
      "do_not_crash",
      "avoid_stall",
      lowEnergy ? "rebuild_speed" : "preserve_energy",
      lowAltitude ? "respect_ground" : "stay_fighting",
    ],
    attention: [
      `target_${side}`,
      `target_${vertical}`,
      `range_${rangeBand}`,
      `closure_${enemy.closureRate < -20 ? "closing" : enemy.closureRate > 20 ? "opening" : "steady"}`,
    ],
    trigger,
  };
}

export function bodyPilotController(aggression = 0.72): Controller {
  return async (observation) => {
    const action = bodyPursuitIntent(observation, aggression);
    return {
      action,
      rationale: action.goal,
    };
  };
}
