import { ObservationSchema, type ContactPercept, type Observation } from "../protocol/schema";
import {
  activeRadarLockAvailable,
  hasLoadedActiveRadarMissile,
  hasLoadedHeatSeeker,
  irLockAvailable,
} from "../sim/flight";
import { radarSensor } from "./perception";
import type { SensorDevice } from "../sim/parts";
import { basisFromQuat, dot, length, normalize, sub } from "../sim/math";
import type { AircraftState } from "../sim/types";

export interface DetectedContact {
  target: AircraftState;
  confidence: number;
}

// Visibility filter: world truth -> what THIS agent is allowed to perceive. Splitting the
// sensor (who can I see) from the projection (how it is framed) means a fog-of-war experiment
// in 0.3.0 swaps the sensor while controllers stay untouched.
export interface SensorModel {
  detect(world: AircraftState[], self: AircraftState): DetectedContact[];
}

// Radar-limited sensor model: contact only if inside the radar's range + cone. Confidence falls off
// with distance so a far, fading return is distinguishable from a close, solid one.
export function radarSensorModel(device: SensorDevice): SensorModel {
  return {
    detect(world, self) {
      const frame = radarSensor.sense(device, world, self);
      const maxRangeM = Math.max(device.for.maxRangeM, 1);
      return frame.contacts
        .filter((c) => c.inView)
        .map((c) => {
          const target = world.find((a) => a.id === c.id);
          if (!target) return undefined;
          return {
            target,
            confidence: Math.max(0.1, 1 - c.range / maxRangeM),
          };
        })
        .filter((c): c is DetectedContact => c !== undefined);
    },
  };
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
  messages: string[] = [],
): Observation {
  const basis = basisFromQuat(self.orientation);
  const missileLoaded = hasLoadedHeatSeeker(self);
  const radarMissileLoaded = hasLoadedActiveRadarMissile(self);

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
      ...(target.static ? { balloon: true } : {}),
      ...(missileLoaded && irLockAvailable(self, target) ? { missileLock: true } : {}),
      ...(radarMissileLoaded && activeRadarLockAvailable(self, target) ? { radarLock: true } : {}),
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
      ...(missileLoaded ? { missileLoaded: true } : {}),
      ...(radarMissileLoaded ? { radarMissileLoaded: true } : {}),
    },
    contacts,
    ...(messages.length > 0 ? { messages } : {}),
  });
}
