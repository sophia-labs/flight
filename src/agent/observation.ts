import { ObservationSchema, type ContactPercept, type Observation } from "../protocol/schema";
import { basisFromQuat, dot, length, normalize, sub } from "../sim/math";
import type { AircraftState } from "../sim/types";

export interface DetectedContact {
  target: AircraftState;
  confidence: number;
}

// Visibility filter: world truth -> what THIS agent is allowed to perceive. Splitting the
// sensor (who can I see) from the projection (how is it framed) means a fog-of-war experiment
// in 0.3.0 swaps the sensor while controllers stay untouched.
export interface SensorModel {
  detect(world: AircraftState[], self: AircraftState): DetectedContact[];
}

// 0.2.0: perfect information. Keeps the thread deterministic; the seam is what matters.
export const perfectSensor: SensorModel = {
  detect(world, self) {
    return world
      .filter((candidate) => candidate.team !== self.team && candidate.health > 0)
      .map((target) => ({ target, confidence: 1 }));
  },
};

// Projects internal AircraftState into an ego-relative percept. Reads internal state (not the
// public snapshot) so the projection decides what is revealed. The per-contact direction
// cosines are exactly the dot products the scripted controllers used to take against the raw
// basis — pre-projected here so a controller never needs omniscient world state.
export function toObservation(
  self: AircraftState,
  world: AircraftState[],
  turn: number,
  time: number,
  sensor: SensorModel = perfectSensor,
): Observation {
  const basis = basisFromQuat(self.orientation);

  const contacts: ContactPercept[] = sensor.detect(world, self).map(({ target }) => {
    const relative = sub(target.position, self.position);
    const direction = normalize(relative);
    return {
      id: target.id,
      team: target.team,
      range: length(relative),
      bearingForward: dot(direction, basis.forward),
      bearingRight: dot(direction, basis.right),
      bearingUp: dot(direction, basis.up),
      // range rate along the line of sight (matches the old controllers' `closure`): + opening, - closing
      closureRate: dot(sub(target.velocity, self.velocity), direction),
      health: target.health,
    };
  });

  return ObservationSchema.parse({
    schemaVersion: 1,
    selfId: self.id,
    turn,
    time,
    self: {
      airspeed: self.metrics.airspeed,
      altitude: self.metrics.altitude,
      aoaDeg: self.metrics.aoaDeg,
      gLoad: self.metrics.gLoad,
      health: self.health,
      weaponCooldown: self.weaponCooldown,
      stalled: self.metrics.stalled,
    },
    contacts,
  });
}
