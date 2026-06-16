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
  Projectile,
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

// --- v0.9.x simulated projectiles -------------------------------------------------------------------
// Real bullets replace the old instant hitscan cone. On a fired shot the gun spawns a round at the ship
// nose travelling MUZZLE_SPEED along the gun axis plus the shooter's own velocity; the round integrates
// pos += vel*dt every step and is swept against enemy targets. A 14deg-off lob no longer "hits" a fat
// balloon — the bullet flies past it, because the round goes where the muzzle pointed, not where the
// target is.
const MUZZLE_SPEED = 900; // m/s muzzle velocity (added to shooter velocity)
const PROJECTILE_LIFETIME_S = 2.5; // despawn after this many seconds of flight
const PROJECTILE_MAX_RANGE_M = 2_900; // despawn past this travelled distance (matches the old balloon reach)
const WEAPON_COOLDOWN_S = 2.65; // per-shot cadence — unchanged from the hitscan gun
const MUZZLE_OFFSET_M = 18; // round spawns this far ahead of the ship origin (the nose)
const BALLOON_HIT_RADIUS_M = 42; // a fat balloon target's capture radius (its perceivedRadiusM)
const AIRCRAFT_HIT_RADIUS_M = 8; // a small airframe's capture radius
const PROJECTILE_DAMAGE = 26; // damage a connecting round deals (one good burst pops the 12-hp balloon)

// The capture radius a round must pass within to register a hit on a target. A balloon uses its big
// perceived size; an aircraft is a small point target. Mirrored by the on-solution geometry in
// src/eval/balloonMetrics.ts — change both together.
export function targetHitRadiusM(target: AircraftState): number {
  if (target.static === true) return target.perceivedRadiusM ?? BALLOON_HIT_RADIUS_M;
  return AIRCRAFT_HIT_RADIUS_M;
}

// The RETICLE: a fixed angular aim circle around the gun axis (the boresight +). It is deliberately
// WIDER than the round's hit radius, so a target sitting inside the reticle is NOT a guaranteed hit —
// the Body still has to centre it. This is the assisted sear's gate: it blocks a SOLUTION=now called at
// empty sky (nothing in the reticle), but it does NOT aim for the Body. Sloppy "now" inside the reticle
// can still miss; a centred one connects. Skill stays in the seat. (~3.4deg half-angle ≈ a generous
// gunsight pipper — at 1 km that is a ~60 m circle vs the round's much tighter capture.)
export const RETICLE_HALF_ANGLE_RAD = 0.06; // ~3.4deg

// Is any enemy target inside the reticle (within RETICLE_HALF_ANGLE_RAD of the gun axis, ahead, and in
// range)? The third key of the assisted sear: the Body may only call its own shot at something actually
// in the reticle — not at empty sky — but being in the reticle does not guarantee the round lands.
// Pure geometry — no mutation/RNG — so it is deterministic and re-runnable.
export function targetInReticle(shooter: AircraftState, aircraft: AircraftState[]): boolean {
  const forward = basisFromQuat(shooter.orientation).forward;
  const muzzle = add(shooter.position, scale(forward, MUZZLE_OFFSET_M));
  const reach = Math.min(PROJECTILE_MAX_RANGE_M, MUZZLE_SPEED * PROJECTILE_LIFETIME_S);
  for (const target of aircraft) {
    if (target.team === shooter.team || target.health <= 0 || target.id === shooter.id) continue;
    const toTarget = sub(target.position, muzzle);
    const range = length(toTarget);
    if (range < 1 || range > reach) continue;
    // Reticle gate: the target is inside the fixed reticle half-angle, widened by the target's own
    // angular size (a fat balloon fills more of the pipper, so its EDGE entering the circle counts).
    const angularRadius = Math.atan2(targetHitRadiusM(target), range);
    const onAxis = dot(forward, normalize(toTarget));
    if (onAxis >= Math.cos(RETICLE_HALF_ANGLE_RAD + angularRadius)) return true;
  }
  return false;
}

export {
  MUZZLE_SPEED,
  PROJECTILE_LIFETIME_S,
  PROJECTILE_MAX_RANGE_M,
  WEAPON_COOLDOWN_S,
  MUZZLE_OFFSET_M,
  PROJECTILE_DAMAGE,
};

// Closest approach (squared) of the swept segment p0->p1 to a fixed point c. A fast bullet can step
// past a small target in one frame, so we test the whole segment, not just the endpoints — no tunnelling.
function closestApproachSqToPoint(
  p0: ReturnType<typeof vec3>,
  p1: ReturnType<typeof vec3>,
  c: ReturnType<typeof vec3>,
): number {
  const seg = sub(p1, p0);
  const segLenSq = dot(seg, seg);
  if (segLenSq < 1e-9) {
    const d = sub(c, p0);
    return dot(d, d);
  }
  const t = clamp(dot(sub(c, p0), seg) / segLenSq, 0, 1);
  const closest = add(p0, scale(seg, t));
  const d = sub(c, closest);
  return dot(d, d);
}

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
  projectiles: Projectile[] = [],
  time = 0,
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

  // 1) Integrate the rounds already in flight (and resolve their hits) against this frame's geometry.
  const surviving = stepProjectiles(projectiles, aircraft, dt, time, events);
  // 2) Spawn new rounds for ships that fired this step; the fresh rounds fly next step.
  const spawned = resolveWeapons(aircraft, time, events);
  surviving.push(...spawned);

  return { aircraft, events, projectiles: surviving };
}

// Integrate each live round one step, sweep it against enemy targets, apply damage on the closest
// intercept, and drop rounds that hit / time out / overrange. Mutates `events` (pushes 'hit'); returns
// the survivors.
function stepProjectiles(
  projectiles: Projectile[],
  aircraft: AircraftState[],
  dt: number,
  time: number,
  events: ReplayEvent[],
): Projectile[] {
  const survivors: Projectile[] = [];
  for (const round of projectiles) {
    const p0 = round.position;
    const p1 = add(p0, scale(round.velocity, dt));
    const stepLen = length(sub(p1, p0));

    // Swept hit test against every enemy target with health, keeping the closest intercept along the
    // segment so a round can't pass two contacts and credit the wrong one.
    let hit: { target: AircraftState; distSq: number } | undefined;
    for (const target of aircraft) {
      if (target.team === round.team || target.health <= 0 || target.id === round.ownerId) continue;
      const radius = targetHitRadiusM(target);
      const distSq = closestApproachSqToPoint(p0, p1, target.position);
      if (distSq <= radius * radius && (!hit || distSq < hit.distSq)) {
        hit = { target, distSq };
      }
    }

    if (hit) {
      const target = hit.target;
      target.health = clamp(target.health - PROJECTILE_DAMAGE, 0, 100);
      events.push({
        type: "hit",
        actorId: round.ownerId,
        targetId: target.id,
        message: `round from ${round.ownerId} hits ${target.callsign} for ${PROJECTILE_DAMAGE}`,
        origin: p0,
        impact: target.position,
      });
      continue; // round is consumed
    }

    const travelled = round.distanceTravelledM + stepLen;
    const age = time + dt - round.spawnTime;
    if (travelled > PROJECTILE_MAX_RANGE_M || age > PROJECTILE_LIFETIME_S) continue; // despawn
    survivors.push({ ...round, position: p1, distanceTravelledM: travelled });
  }
  return survivors;
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

// Spawn a real round for any ship that pulls the trigger this step. The round is born at the muzzle
// (nose) travelling MUZZLE_SPEED along the gun axis plus the shooter's own velocity — it goes where the
// nose points, NOT toward the target, so aim now matters. Fires on a rising trigger edge gated by the
// per-shot cooldown (held-true ⇒ one round per cooldown, not an auto-stream). Returns the new rounds;
// the 'shot' event is emitted here, while 'hit'/'miss' are decided downstream when the round arrives.
function resolveWeapons(
  aircraft: AircraftState[],
  time: number,
  events: ReplayEvent[],
): Projectile[] {
  const spawned: Projectile[] = [];

  for (const shooter of aircraft) {
    const trigger = shooter.controls.trigger === true;
    shooter.prevTrigger = trigger; // tracked for the held-action sear (Phase 2); not the fire gate here

    // Fire when the trigger is held AND the per-shot cooldown is ready — the cooldown paces a held
    // trigger to one round per WEAPON_COOLDOWN_S (it does not auto-stream every frame).
    if (!trigger || shooter.weaponCooldown > 0 || shooter.health <= 0) {
      continue;
    }

    shooter.weaponCooldown = WEAPON_COOLDOWN_S;
    const forward = basisFromQuat(shooter.orientation).forward;
    const muzzle = add(shooter.position, scale(forward, MUZZLE_OFFSET_M));
    // Bullet velocity in the world frame: gun axis * muzzle speed + the platform's own velocity.
    const velocity = add(scale(forward, MUZZLE_SPEED), shooter.velocity);

    // Deterministic id: a ship fires at most one round per step and each step has a unique time, so
    // owner+time is unique across a match AND reproducible run-to-run (no module-level counter that
    // would drift between matches and break replay-determinism).
    spawned.push({
      id: `bullet-${shooter.id}-${time.toFixed(4)}`,
      position: muzzle,
      velocity,
      ownerId: shooter.id,
      team: shooter.team,
      spawnTime: time,
      distanceTravelledM: 0,
    });

    const target = nearestOpponent(shooter, aircraft);
    events.push({
      type: "shot",
      actorId: shooter.id,
      ...(target ? { targetId: target.id } : {}),
      message: `${shooter.callsign} fires`,
      origin: muzzle,
      ...(target ? { impact: target.position } : {}),
    });
  }

  return spawned;
}

function nearestOpponent(shooter: AircraftState, aircraft: AircraftState[]) {
  return aircraft
    .filter((candidate) => candidate.team !== shooter.team && candidate.health > 0)
    .sort(
      (a, b) =>
        length(sub(a.position, shooter.position)) - length(sub(b.position, shooter.position)),
    )[0];
}
