import { clampControlInput, type ControlInput, type ReplayEvent } from "../protocol/schema";
import {
  add,
  basisFromQuat,
  clamp,
  dot,
  length,
  normalize,
  rotateAroundWorldAxis,
  scale,
  sub,
  vec3,
} from "./math";
import type { AircraftState, FlightMetrics, StepResult } from "./types";

const GRAVITY = vec3(0, -9.81, 0);
const SEA_LEVEL_DENSITY = 1.225;
const TERRAIN_FLOOR_M = 55;

export const DEFAULT_MODEL = {
  massKg: 9_200,
  wingAreaM2: 22.5,
  maxThrustN: 74_000,
  maxPitchRate: 0.92,
  maxRollRate: 1.75,
  maxYawRate: 0.34,
  stallAoARad: 0.42,
};

export function stepSimulation(
  aircraft: AircraftState[],
  controlsById: Record<string, ControlInput>,
  dt: number,
): StepResult {
  const events: ReplayEvent[] = [];

  for (const ship of aircraft) {
    const controls = clampControlInput(controlsById[ship.id] ?? ship.controls);
    ship.controls = controls;
    ship.metrics = stepAircraft(ship, controls, dt);

    if (ship.position.y <= TERRAIN_FLOOR_M + 0.01 && length(ship.velocity) > 55) {
      ship.health = clamp(ship.health - 4.5 * dt, 0, 100);
      if (Math.round(ship.health) % 9 === 0) {
        events.push({
          type: "terrain",
          actorId: ship.id,
          message: `${ship.callsign} is scraping the floor`,
          origin: ship.position,
        });
      }
    }
  }

  events.push(...resolveWeapons(aircraft));

  return { aircraft, events };
}

function stepAircraft(
  aircraft: AircraftState,
  controls: ControlInput,
  dt: number,
): FlightMetrics {
  const model = aircraft.model;
  const basis = basisFromQuat(aircraft.orientation);
  const speed = length(aircraft.velocity);
  const forwardSpeed = dot(aircraft.velocity, basis.forward);
  const bodyVerticalSpeed = dot(aircraft.velocity, basis.up);
  const bodySideSpeed = dot(aircraft.velocity, basis.right);
  const aoa = Math.atan2(-bodyVerticalSpeed, Math.max(Math.abs(forwardSpeed), 1));
  const density = SEA_LEVEL_DENSITY * Math.exp(-Math.max(aircraft.position.y, 0) / 8_800);
  const qbar = 0.5 * density * speed * speed;
  const aoaAbs = Math.abs(aoa);
  const stallSeverity = clamp((aoaAbs - model.stallAoARad) / 0.28, 0, 1);
  const stalled = speed < 62 || stallSeverity > 0.2;
  const liftEfficiency = 1 - stallSeverity * 0.72;
  const cl = clamp(0.21 + 3.05 * aoa + controls.pitch * 0.12, -1.05, 1.48) * liftEfficiency;
  const lift = scale(basis.up, qbar * model.wingAreaM2 * cl);
  const sideSlip = clamp(bodySideSpeed / Math.max(speed, 1), -1, 1);
  const sideForce = scale(basis.right, -qbar * 8.5 * sideSlip * 1.15);
  const cd = 0.034 + cl * cl * 0.052 + stallSeverity * 0.28;
  const drag = scale(normalize(aircraft.velocity), -qbar * model.wingAreaM2 * cd);
  const thrust = scale(basis.forward, model.maxThrustN * (0.14 + controls.throttle * 0.86));
  const totalForce = add(add(add(lift, sideForce), drag), thrust);
  const acceleration = add(scale(totalForce, 1 / model.massKg), GRAVITY);
  const controlAuthority = clamp((speed - 38) / 118, 0.18, 1.08) * (stalled ? 0.52 : 1);

  aircraft.velocity = add(aircraft.velocity, scale(acceleration, dt));
  aircraft.position = add(aircraft.position, scale(aircraft.velocity, dt));

  if (aircraft.position.y < TERRAIN_FLOOR_M) {
    aircraft.position = { ...aircraft.position, y: TERRAIN_FLOOR_M };
    aircraft.velocity = {
      ...aircraft.velocity,
      y: Math.max(12, Math.abs(aircraft.velocity.y) * 0.22),
    };
  }

  let orientation = aircraft.orientation;
  orientation = rotateAroundWorldAxis(
    orientation,
    basis.forward,
    controls.roll * model.maxRollRate * controlAuthority * dt,
  );
  orientation = rotateAroundWorldAxis(
    orientation,
    basis.right,
    controls.pitch * model.maxPitchRate * controlAuthority * dt,
  );
  orientation = rotateAroundWorldAxis(
    orientation,
    basis.up,
    -(controls.yaw * model.maxYawRate + controls.roll * 0.055) * controlAuthority * dt,
  );
  aircraft.orientation = orientation;
  aircraft.weaponCooldown = Math.max(0, aircraft.weaponCooldown - dt);

  const loadForce = length(add(lift, sideForce));
  const gLoad = loadForce / (model.massKg * 9.81);

  return {
    airspeed: length(aircraft.velocity),
    altitude: aircraft.position.y,
    aoaDeg: (aoa * 180) / Math.PI,
    gLoad,
    stalled,
  };
}

function resolveWeapons(aircraft: AircraftState[]): ReplayEvent[] {
  const events: ReplayEvent[] = [];

  for (const shooter of aircraft) {
    if (!shooter.controls.trigger || shooter.weaponCooldown > 0 || shooter.health <= 0) {
      continue;
    }

    shooter.weaponCooldown = 2.65;
    const target = nearestOpponent(shooter, aircraft);
    if (!target) {
      continue;
    }

    const toTarget = sub(target.position, shooter.position);
    const range = length(toTarget);
    const direction = normalize(toTarget);
    const forward = basisFromQuat(shooter.orientation).forward;
    const angle = Math.acos(clamp(dot(direction, forward), -1, 1));
    const origin = add(shooter.position, scale(forward, 18));
    const impact = target.position;

    events.push({
      type: "shot",
      actorId: shooter.id,
      targetId: target.id,
      message: `${shooter.callsign} fires`,
      origin,
      impact,
    });

    if (range < 1_180 && angle < 0.155) {
      const damage = clamp(36 * (1 - range / 1_420) * (1 - angle / 0.19), 7, 28);
      target.health = clamp(target.health - damage, 0, 100);
      events.push({
        type: "hit",
        actorId: shooter.id,
        targetId: target.id,
        message: `${shooter.callsign} scores ${Math.round(damage)} damage on ${target.callsign}`,
        origin,
        impact,
      });
    } else {
      events.push({
        type: "miss",
        actorId: shooter.id,
        targetId: target.id,
        message: `${shooter.callsign} misses ${target.callsign}`,
        origin,
        impact,
      });
    }
  }

  return events;
}

function nearestOpponent(shooter: AircraftState, aircraft: AircraftState[]) {
  return aircraft
    .filter((candidate) => candidate.team !== shooter.team && candidate.health > 0)
    .sort(
      (a, b) =>
        length(sub(a.position, shooter.position)) - length(sub(b.position, shooter.position)),
    )[0];
}
