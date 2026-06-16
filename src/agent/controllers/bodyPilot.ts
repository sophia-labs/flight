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
      armedFire: false, // nothing to shoot → the held action is not armed → the sear stays dead
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
  // HELD ACTION (v0.9.x assisted sear): the Pilot no longer computes the firing INSTANT itself — that
  // is the Body's job now (the seat that sees the geometry). The Pilot ARMS a held action ("weapons
  // free — squeeze when you have the solution") whenever a target is roughly in front and within the
  // gun's reach; the fast Body then flies the reticle on and calls its own shot (SOLUTION=now), and the
  // sear blocks a shot at empty sky. So this is a COARSE permission gate, not a precise aim test: arm
  // generously when there is something worth shooting ahead, and let the Body own the precise call.
  const armedFire =
    enemy.bearingForward > 0 && // target somewhere ahead of the nose
    enemy.range < (enemy.balloon ? 2_900 : 1_400); // within the round's reach for the target type
  // `trigger` is retained as the same coarse permission level (kept for back-compat + the non-Body
  // adapters that still read it). The Body path reads `armedFire`; the sear, not this flag, fires.
  const trigger = armedFire;

  // Balloon hunt: the Body's energy instinct (dive for speed) makes it sink under a hovering target and
  // scatter the gun geometry. The Pilot has no stick — only words — so it coaches the aim every turn:
  // it reads the bearing and calls the correction out loud, holds the Body level, and reframes its
  // dive reflex ("you're already fast enough"). Pure prompting; the trigger gate above is untouched.
  const isBalloon = enemy.balloon === true;
  const vCue =
    enemy.bearingUp > 0.1
      ? "the balloon is ABOVE your nose — raise the nose and STOP sinking"
      : enemy.bearingUp < -0.1
        ? "the balloon is slightly low — ease the nose down a touch, do not dive"
        : "the balloon is dead on your nose";
  const sideCue = Math.abs(enemy.bearingRight) < 0.1 ? "wings level" : `ease ${side}`;
  // Weapons-free coaching: with the held action armed, the Body owns the shot — so the Pilot coaches it
  // to fly the reticle on and call it ("squeeze when the balloon sits on your + boresight"), instead of
  // the old "I will pull the trigger for you."
  const fireCue = armedFire
    ? " WEAPONS FREE: you call the shot — keep flying the balloon onto your boresight + and squeeze (SOLUTION now) the instant it sits centred on the crosshair."
    : "";

  return {
    kind: "pilot-intent",
    goal: isBalloon
      ? `Steady gun run on the balloon. ${vCue}; ${sideCue}. HOLD your altitude — you are already fast enough, do NOT trade altitude or dive. Keep the balloon glued to your boresight crosshair and fly straight onto it until it fills your sight.${fireCue}`
      : lowEnergy || self.stalled
        ? `recover energy, then turn ${side} toward the target`
        : `turn ${side} toward the ${rangeBand} target and line up without losing the wing`,
    urgency,
    riskTolerance,
    style: isBalloon
      ? "steady_gun_run"
      : lowEnergy
        ? "body_first"
        : aggression > 0.75
          ? "reckless_but_survivable"
          : "controlled_aggression",
    constraints: isBalloon
      ? ["hold_altitude", "do_not_dive", "keep_balloon_centered", "do_not_crash", "avoid_stall"]
      : [
          "do_not_crash",
          "avoid_stall",
          lowEnergy ? "rebuild_speed" : "preserve_energy",
          lowAltitude ? "respect_ground" : "stay_fighting",
        ],
    attention: isBalloon
      ? [`balloon_${vertical}`, `balloon_${side}`, `range_${rangeBand}`, "hold_level", "nose_on_target"]
      : [
          `target_${side}`,
          `target_${vertical}`,
          `range_${rangeBand}`,
          `closure_${enemy.closureRate < -20 ? "closing" : enemy.closureRate > 20 ? "opening" : "steady"}`,
        ],
    trigger,
    armedFire,
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
