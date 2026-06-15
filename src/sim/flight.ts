import { clampControlInput, type ControlInput, type ReplayEvent } from "../protocol/schema";
import { compileAirframe, defaultAirframe } from "./airframe";
import {
  add,
  basisFromQuat,
  clamp,
  cross,
  dot,
  length,
  normalize,
  rotateAroundWorldAxis,
  rotateVec,
  scale,
  sub,
  vec3,
} from "./math";
import { samplePropulsion } from "./propulsion";
import { surfaceControlSnapshot, surfaceEffectiveDeflectionRad } from "./types";
import type {
  AeroSurface,
  AircraftModel,
  AircraftState,
  FlightMetrics,
  StepResult,
  SurfaceAerodynamicState,
} from "./types";

const GRAVITY = vec3(0, -9.81, 0);
const SEA_LEVEL_DENSITY = 1.225;
const TERRAIN_FLOOR_M = 55;

// Oswald span efficiency for the induced-drag polar cd_i = cl²/(π·AR·e). With the default AR≈7.5 this
// lands at ≈0.053 — essentially the old constant 0.052 — so the default is undisturbed, while a stubby
// low-AR build now pays a real induced-drag penalty and a long-winged build is rewarded.
const OSWALD_E = 0.8;

// Numerical guardrail, not an authority model: forces still decide the acceleration, but absurd builds
// and high-speed stalls cannot integrate to unbounded spin rates in one coarse replay frame.
const MAX_BODY_RATE_RAD_S = 5.5;

// Specific fuel consumption (kg burned per N of thrust per second). Sized so an ~1800 kg tank gives
// ~400 s of full-throttle endurance — visible drain over a long fight, not match-ending in a short one.
const SFC = 6e-5;

// The default airframe's compiled model — the calibration baseline. Computed via compileAirframe (one
// source of truth) rather than a hand-written literal now that the model carries derived inertia/CoM/etc.
export const DEFAULT_MODEL: AircraftModel = compileAirframe(defaultAirframe()).model;

function densityAtAltitude(altitudeM: number): number {
  return SEA_LEVEL_DENSITY * Math.exp(-Math.max(altitudeM, 0) / 8_800);
}

function bodyOmegaWorld(aircraft: AircraftState) {
  const basis = basisFromQuat(aircraft.orientation);
  return add(
    add(scale(basis.forward, aircraft.angularVelocity.x), scale(basis.right, aircraft.angularVelocity.y)),
    scale(basis.up, aircraft.angularVelocity.z),
  );
}

interface SurfaceSample {
  force: ReturnType<typeof vec3>;
  liftForce: ReturnType<typeof vec3>;
  torque: ReturnType<typeof vec3>;
  alpha: number;
  alphaEffective: number;
  stallSeverity: number;
}

function sampleSurface(
  surface: AeroSurface,
  aircraft: AircraftState,
  controls: ControlInput,
  density: number,
  omegaWorld: ReturnType<typeof vec3>,
): SurfaceSample {
  const basis = basisFromQuat(aircraft.orientation);
  const rWorld = rotateVec(aircraft.orientation, sub(surface.localOffset, aircraft.model.com));
  const surfaceVelocity = add(aircraft.velocity, cross(omegaWorld, rWorld));
  const surfaceSpeed = length(surfaceVelocity);
  if (surfaceSpeed < 0.5 || surface.areaM2 <= 0) {
    const zero = vec3(0, 0, 0);
    return {
      force: zero,
      liftForce: zero,
      torque: zero,
      alpha: 0,
      alphaEffective: 0,
      stallSeverity: 0,
    };
  }

  const forward = normalize(rotateVec(aircraft.orientation, surface.localForward), basis.forward);
  const up = normalize(rotateVec(aircraft.orientation, surface.localUp), basis.up);
  const vForward = dot(surfaceVelocity, forward);
  const vLift = dot(surfaceVelocity, up);
  const alpha = Math.atan2(-vLift, Math.max(Math.abs(vForward), 1));
  const deflection = surfaceEffectiveDeflectionRad(surface, controls);
  const alphaEffective = alpha + deflection;
  const stallSeverity = clamp(
    (Math.abs(alphaEffective) - surface.stallAoARad) / Math.max(surface.stallAoARad * 0.85, 1e-3),
    0,
    1,
  );

  const clLinear = surface.zeroLiftCl + surface.liftSlope * alphaEffective;
  const cl = clamp(clLinear, -1.28, 1.55) * (1 - stallSeverity * 0.78);
  const inducedDrag = (cl * cl) / (Math.PI * Math.max(surface.aspectRatio, 0.3) * OSWALD_E);
  const aileronDrag = surface.control?.axis === "roll" ? Math.max(0, -deflection) * 0.11 : 0;
  const cd =
    surface.cd0 + inducedDrag + stallSeverity * 0.38 + Math.abs(deflection) * 0.035 + aileronDrag;
  const qbar = 0.5 * density * surfaceSpeed * surfaceSpeed;

  const vhat = normalize(surfaceVelocity, forward);
  const liftDir = normalize(sub(up, scale(vhat, dot(up, vhat))), up);
  const liftForce = scale(liftDir, qbar * surface.areaM2 * cl);
  const dragForce = scale(vhat, -qbar * surface.areaM2 * cd);
  const force = add(liftForce, dragForce);
  return {
    force,
    liftForce,
    torque: cross(rWorld, force),
    alpha,
    alphaEffective,
    stallSeverity,
  };
}

export function stepSimulation(
  aircraft: AircraftState[],
  controlsById: Record<string, ControlInput>,
  dt: number,
): StepResult {
  const events: ReplayEvent[] = [];

  for (const ship of aircraft) {
    // A static balloon hovers in place: skip flight integration entirely (no fall/stall/move). It keeps
    // its spawn position/velocity/orientation and its initial metrics, but still takes damage below.
    if (ship.static) continue;

    const controls = clampControlInput(controlsById[ship.id] ?? ship.controls);
    ship.controls = controls;
    ship.metrics = stepAircraft(ship, controls, dt);

    if (ship.position.y <= TERRAIN_FLOOR_M + 0.5 && length(ship.velocity) > 55) {
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
  const aoa = Math.atan2(-bodyVerticalSpeed, Math.max(Math.abs(forwardSpeed), 1));
  const density = densityAtAltitude(aircraft.position.y);
  const qbar = 0.5 * density * speed * speed;

  // Fuel: a tanked airframe (fuelCapacityKg > 0) burns ∝ thrust and cuts thrust when dry; a tankless
  // one has infinite fuel. effectiveMass shrinks as fuel burns, so the aircraft accelerates/climbs
  // better light. (CoM + inertia are held at the wet value — a stated cut.)
  const tanked = model.fuelCapacityKg > 0;
  const hasFuel = !tanked || aircraft.fuelKg > 0;
  const thrustSetting = hasFuel ? 0.14 + controls.throttle * 0.86 : 0;
  const commandedThrustN = model.maxThrustN * thrustSetting;
  if (tanked) aircraft.fuelKg = Math.max(0, aircraft.fuelKg - SFC * commandedThrustN * dt);
  const effectiveMassKg = Math.max(model.dryMassKg + aircraft.fuelKg, 1); // floor guards a fully-empty build

  const omegaWorld = bodyOmegaWorld(aircraft);
  let totalForce = vec3(0, 0, 0);
  let totalTorque = vec3(0, 0, 0);
  let loadForce = vec3(0, 0, 0);
  let maxSurfaceStall = 0;
  let horizontalAlphaArea = 0;
  let horizontalArea = 0;
  const surfaceControls: NonNullable<AircraftState["surfaceControls"]> = [];

  for (const surface of model.aeroSurfaces) {
    const sample = sampleSurface(surface, aircraft, controls, density, omegaWorld);
    totalForce = add(totalForce, sample.force);
    totalTorque = add(totalTorque, sample.torque);
    loadForce = add(loadForce, sample.liftForce);
    maxSurfaceStall = Math.max(maxSurfaceStall, sample.stallSeverity);
    if (surface.control) {
      const measured: SurfaceAerodynamicState = {
        localAoADeg: (sample.alpha * 180) / Math.PI,
        totalAoADeg: (sample.alphaEffective * 180) / Math.PI,
        stallSeverity: sample.stallSeverity,
        loadN: length(sample.liftForce),
      };
      const snapshot = surfaceControlSnapshot(surface, aircraft, measured);
      if (snapshot) surfaceControls.push(snapshot);
    }
    if (surface.kind === "horizontal") {
      horizontalAlphaArea += sample.alpha * surface.areaM2;
      horizontalArea += surface.areaM2;
    }
  }
  aircraft.surfaceControls = surfaceControls;

  if (speed > 0.5 && model.parasiteDragAreaM2 > 0) {
    totalForce = add(
      totalForce,
      scale(normalize(aircraft.velocity), -qbar * model.parasiteDragAreaM2),
    );
  }

  if (commandedThrustN > 0) {
    let appliedThrustPoint = false;
    for (const point of model.propulsions) {
      const localForward = rotateVec(aircraft.orientation, point.localForward);
      const rWorld = rotateVec(aircraft.orientation, sub(point.localOffset, model.com));
      const diskVelocity = add(aircraft.velocity, cross(omegaWorld, rWorld));
      const axialAirspeed = Math.max(0, dot(diskVelocity, localForward));
      const sample = samplePropulsion(point, axialAirspeed, density, thrustSetting);
      const force = scale(localForward, sample.thrustN);
      totalForce = add(totalForce, force);
      totalTorque = add(totalTorque, cross(rWorld, force));
      appliedThrustPoint = true;
    }

    for (const point of model.thrustPoints) {
      const force = scale(rotateVec(aircraft.orientation, point.localForward), point.maxThrustN * thrustSetting);
      const rWorld = rotateVec(aircraft.orientation, sub(point.localOffset, model.com));
      totalForce = add(totalForce, force);
      totalTorque = add(totalTorque, cross(rWorld, force));
      appliedThrustPoint = true;
    }

    if (!appliedThrustPoint) {
      totalForce = add(totalForce, scale(basis.forward, commandedThrustN));
    }
  }

  const acceleration = add(scale(totalForce, 1 / effectiveMassKg), GRAVITY);

  aircraft.velocity = add(aircraft.velocity, scale(acceleration, dt));
  aircraft.position = add(aircraft.position, scale(aircraft.velocity, dt));

  if (aircraft.position.y < TERRAIN_FLOOR_M) {
    aircraft.position = { ...aircraft.position, y: TERRAIN_FLOOR_M };
    aircraft.velocity = {
      ...aircraft.velocity,
      y: Math.max(12, Math.abs(aircraft.velocity.y) * 0.22),
    };
  }

  const omega = aircraft.angularVelocity;
  const nextRoll = omega.x + (dot(totalTorque, basis.forward) / model.inertia.roll) * dt;
  const nextPitch = omega.y + (dot(totalTorque, basis.right) / model.inertia.pitch) * dt;
  const nextYaw = omega.z + (dot(totalTorque, basis.up) / model.inertia.yaw) * dt;
  aircraft.angularVelocity = vec3(
    clamp(Number.isFinite(nextRoll) ? nextRoll : 0, -MAX_BODY_RATE_RAD_S, MAX_BODY_RATE_RAD_S),
    clamp(Number.isFinite(nextPitch) ? nextPitch : 0, -MAX_BODY_RATE_RAD_S, MAX_BODY_RATE_RAD_S),
    clamp(Number.isFinite(nextYaw) ? nextYaw : 0, -MAX_BODY_RATE_RAD_S, MAX_BODY_RATE_RAD_S),
  );

  let orientation = aircraft.orientation;
  orientation = rotateAroundWorldAxis(orientation, basis.forward, aircraft.angularVelocity.x * dt);
  orientation = rotateAroundWorldAxis(orientation, basis.right, aircraft.angularVelocity.y * dt);
  orientation = rotateAroundWorldAxis(orientation, basis.up, aircraft.angularVelocity.z * dt);
  aircraft.orientation = orientation;
  aircraft.weaponCooldown = Math.max(0, aircraft.weaponCooldown - dt);

  const metricAoa = horizontalArea > 0 ? horizontalAlphaArea / horizontalArea : aoa;
  const stalled = speed < 62 || maxSurfaceStall > 0.2;
  const gLoad = length(loadForce) / (effectiveMassKg * 9.81);

  return {
    airspeed: length(aircraft.velocity),
    altitude: aircraft.position.y,
    aoaDeg: (metricAoa * 180) / Math.PI,
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

    // A fat balloon is a generous target: widen the gun cone + range so a weak shooter who lines up
    // roughly on it can actually pop it (gettable, not frustrating). Its angular size scales the cone,
    // so a ~50 m balloon subtends far more sky than a 16 m airframe. Aircraft keep the tight default.
    const balloon = target.static === true;
    const coneRad = balloon ? 0.42 : 0.155;
    const maxRangeM = balloon ? 2_900 : 1_180;
    if (range < maxRangeM && angle < coneRad) {
      const damage = balloon
        ? clamp(30 * (1 - angle / (coneRad + 0.06)), 12, 30)
        : clamp(36 * (1 - range / 1_420) * (1 - angle / 0.19), 7, 28);
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
