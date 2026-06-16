import { clampControlInput, type ControlInput, type ReplayEvent, type Vec3 } from "../protocol/schema";
import {
  GRAVITY,
  GRAVITY_MPS2,
  densityAtAltitude,
  dynamicPressure,
  machAtSpeed,
  machControlFactor,
  machLiftSlopeFactor,
  machWaveDragCd,
  modelSweepState,
  airspeedLimitExceedance,
  stallSpeedMps,
  sweepStateForMach,
} from "./aero";
import { compileAirframe, defaultAirframe } from "./airframe";
import {
  add,
  basisFromQuat,
  clamp,
  cross,
  dot,
  integrateLocalAngularVelocity,
  lerp,
  length,
  normalize,
  rotateVec,
  scale,
  sub,
  vec3,
} from "./math";
import {
  bodyRatesToLocalOmega,
  burnFuel,
  currentMassProperties,
  integrateBodyAngularVelocity,
  localOmegaToBodyRates,
  worldVectorToLocal,
} from "./mass";
import { sampleJetPropulsion } from "./jet";
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
  WeaponStation,
} from "./types";

const TERRAIN_FLOOR_M = 55;

// Oswald span efficiency for the induced-drag polar cd_i = cl²/(π·AR·e). With the default AR≈7.5 this
// lands at ≈0.053 — essentially the old constant 0.052 — so the default is undisturbed, while a stubby
// low-AR build now pays a real induced-drag penalty and a long-winged build is rewarded.
const OSWALD_E = 0.8;

// Numerical guardrail, not an authority model: forces still decide the acceleration, but absurd builds
// and high-speed stalls cannot integrate to unbounded spin rates in one coarse replay frame.
const MAX_BODY_RATE_RAD_S = 5.5;

// Live overspeed is intentionally soft before it is catastrophic: buffet/drag shows up first, then
// sustained over-q or over-Mach starts hurting the airframe. Envelope sweeps use the same limits as a
// hard boundary because they are measuring usable performance, not damage tolerance.
const OVERSPEED_DAMAGE_PER_S = 22;
const OVERSPEED_DRAG_AREA_M2 = 0.35;
const JET_IDLE_SPOOL = 0.14;

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

// v0.10.x heat-seeking missile profile. The F-14's first heat seeker is an AIM-9M-class Sidewinder:
// IR homing, Mach-2.5-ish peak speed, and short-range WVR kinematics. Public headline numbers are
// visible; seeker details are deliberately approximate and gameplay-facing, not a classified model.
export const AIM9M_SIDEWINDER_PROFILE = {
  id: "aim-9m" as const,
  maxSpeedMach: 2.5,
  speedMps: 850,
  effectiveRangeM: 18_500,
  lifetimeS: 24,
  seekerHalfAngleRad: (38 * Math.PI) / 180,
  trackHalfAngleRad: (48 * Math.PI) / 180,
  maxLateralG: 30,
  navigationConstant: 3.5,
  minLockSignal: 0.2,
  proximityRadiusM: 10,
};

const MISSILE_SPEED = AIM9M_SIDEWINDER_PROFILE.speedMps;
const MISSILE_LIFETIME_S = AIM9M_SIDEWINDER_PROFILE.lifetimeS;
const MISSILE_MAX_RANGE_M = AIM9M_SIDEWINDER_PROFILE.effectiveRangeM;
const MISSILE_COOLDOWN_S = 6;
const MISSILE_PROXIMITY_RADIUS_M = AIM9M_SIDEWINDER_PROFILE.proximityRadiusM;
const MISSILE_DAMAGE = 72;

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
  MISSILE_SPEED,
  MISSILE_LIFETIME_S,
  MISSILE_MAX_RANGE_M,
  MISSILE_COOLDOWN_S,
  MISSILE_DAMAGE,
};

function projectileProfile(kind: Projectile["kind"]) {
  if (kind === "missile") {
    return {
      damage: MISSILE_DAMAGE,
      lifetimeS: MISSILE_LIFETIME_S,
      maxRangeM: MISSILE_MAX_RANGE_M,
      proximityRadiusM: MISSILE_PROXIMITY_RADIUS_M,
      label: "missile",
    };
  }

  return {
    damage: PROJECTILE_DAMAGE,
    lifetimeS: PROJECTILE_LIFETIME_S,
    maxRangeM: PROJECTILE_MAX_RANGE_M,
    proximityRadiusM: 0,
    label: "round",
  };
}

function projectileHitRadiusM(round: Projectile, target: AircraftState): number {
  return targetHitRadiusM(target) + projectileProfile(round.kind).proximityRadiusM;
}

function clampMagnitude(v: Vec3, maxMagnitude: number): Vec3 {
  const magnitude = length(v);
  if (magnitude <= maxMagnitude || magnitude < 1e-8) return v;
  return scale(v, maxMagnitude / magnitude);
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

function missileForward(round: Projectile): Vec3 {
  return normalize(round.velocity, vec3(0, 0, -1));
}

// Deliberately compact IR model: hot jets and afterburner dominate, rear aspect is strongest, but
// all-aspect AIM-9M behavior leaves a weaker nose/beam signature. Range attenuation then determines
// whether the seeker can maintain a useful signal.
export function targetHeatSignature(target: AircraftState, observerPosition: Vec3): number {
  if (target.health <= 0) return 0;
  const jetCount = target.model.jetPropulsions.length;
  const propCount = target.model.propulsions.length;
  const thrustPointCount = target.model.thrustPoints.length;
  const throttle = clamp01(target.controls.throttle);
  const spool = clamp01(target.metrics.engineSpool ?? target.engineSpool ?? throttle);
  const engineHeat = jetCount > 0
    ? jetCount * 8.5
    : propCount > 0
      ? propCount * 1.8
      : thrustPointCount > 0
        ? thrustPointCount * 2.4
        : 0;
  const afterburnerHeat = target.metrics.afterburner ? jetCount * 18 : 0;
  const speedHeat = clamp01(length(target.velocity) / 360) * 1.4;
  const baseHeat = (target.static ? 0.05 : 1.2) + engineHeat + throttle * 5 + spool * 5 + afterburnerHeat + speedHeat;

  const targetForward = basisFromQuat(target.orientation).forward;
  const toObserver = normalize(sub(observerPosition, target.position), scale(targetForward, -1));
  const rearAspect = clamp01((dot(toObserver, scale(targetForward, -1)) + 1) / 2);
  const aspectGain = 0.32 + rearAspect * 0.68;
  return baseHeat * aspectGain;
}

interface HeatSeekerCandidate {
  target: AircraftState;
  angleRad: number;
  heat: number;
  signal: number;
}

function heatSeekerCandidate(
  round: Projectile,
  target: AircraftState,
  maxAngleRad: number,
  minSignal: number,
): HeatSeekerCandidate | undefined {
  if (target.team === round.team || target.health <= 0 || target.id === round.ownerId) return undefined;
  const toTarget = sub(target.position, round.position);
  const range = length(toTarget);
  if (range < 1 || range > MISSILE_MAX_RANGE_M) return undefined;
  const los = normalize(toTarget);
  const angleRad = Math.acos(clamp(dot(missileForward(round), los), -1, 1));
  if (angleRad > maxAngleRad) return undefined;
  const heat = targetHeatSignature(target, round.position);
  const rangeKm = Math.max(0.25, range / 1_000);
  const signal = heat / (rangeKm * rangeKm);
  if (signal < minSignal) return undefined;
  return { target, angleRad, heat, signal };
}

function strongestHeatTarget(
  round: Projectile,
  aircraft: AircraftState[],
  maxAngleRad: number,
  minSignal: number,
): HeatSeekerCandidate | undefined {
  let best: HeatSeekerCandidate | undefined;
  for (const target of aircraft) {
    const candidate = heatSeekerCandidate(round, target, maxAngleRad, minSignal);
    if (!candidate) continue;
    if (!best || candidate.signal > best.signal) best = candidate;
  }
  return best;
}

function heatSeekingTarget(round: Projectile, aircraft: AircraftState[]): HeatSeekerCandidate | undefined {
  const relaxedSignal = AIM9M_SIDEWINDER_PROFILE.minLockSignal * 0.55;
  const lockedTarget = round.targetId
    ? aircraft.find((target) => target.id === round.targetId && target.health > 0)
    : undefined;
  if (lockedTarget) {
    const current = heatSeekerCandidate(
      round,
      lockedTarget,
      AIM9M_SIDEWINDER_PROFILE.trackHalfAngleRad,
      relaxedSignal,
    );
    if (current) return current;
  }
  return strongestHeatTarget(
    round,
    aircraft,
    AIM9M_SIDEWINDER_PROFILE.seekerHalfAngleRad,
    AIM9M_SIDEWINDER_PROFILE.minLockSignal,
  );
}

function guideHeatSeekingMissile(round: Projectile, aircraft: AircraftState[], dt: number): Projectile {
  if (round.kind !== "missile" || round.guidance !== "heat-seeking") return round;
  const candidate = heatSeekingTarget(round, aircraft);
  if (!candidate) {
    return {
      ...round,
      lockState: round.lockState === "acquired" ? "lost" : (round.lockState ?? "none"),
      seekerAngleRad: undefined,
      targetHeat: undefined,
      lockSignal: undefined,
    };
  }

  const target = candidate.target;
  const toTarget = sub(target.position, round.position);
  const rangeSq = Math.max(dot(toTarget, toTarget), 1);
  const los = normalize(toTarget);
  const relativeVelocity = sub(target.velocity, round.velocity);
  const closingSpeed = Math.max(0, -dot(relativeVelocity, los));
  const losRate = scale(cross(toTarget, relativeVelocity), 1 / rangeSq);
  const commandedAccel = scale(
    cross(losRate, los),
    AIM9M_SIDEWINDER_PROFILE.navigationConstant * Math.max(closingSpeed, 1),
  );
  const limitedAccel = clampMagnitude(commandedAccel, AIM9M_SIDEWINDER_PROFILE.maxLateralG * GRAVITY_MPS2);
  const previousSpeed = Math.max(length(round.velocity), 1);
  const nextDirection = normalize(add(round.velocity, scale(limitedAccel, dt)), missileForward(round));

  return {
    ...round,
    velocity: scale(nextDirection, previousSpeed),
    targetId: target.id,
    lockState: "acquired",
    seekerAngleRad: candidate.angleRad,
    targetHeat: candidate.heat,
    lockSignal: candidate.signal,
  };
}

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
  altitudeM: number,
  omegaWorld: ReturnType<typeof vec3>,
  com: ReturnType<typeof vec3>,
): SurfaceSample {
  const basis = basisFromQuat(aircraft.orientation);
  const rWorld = rotateVec(aircraft.orientation, sub(surface.localOffset, com));
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
  const mach = machAtSpeed(surfaceSpeed, altitudeM);
  const sweep = sweepStateForMach(surface.sweep, mach);
  const sweepDeg = sweep?.sweepDeg ?? 0;
  const liftSlopeFactor = machLiftSlopeFactor(mach, sweepDeg);
  const controlFactor = machControlFactor(mach);
  const sweepT = sweep?.t ?? 0;
  const stallAoA = surface.stallAoARad * (1 - 0.18 * sweepT);
  const stallSeverity = clamp(
    (Math.abs(alphaEffective) - stallAoA) / Math.max(stallAoA * 0.85, 1e-3),
    0,
    1,
  );

  const zeroLiftCl = surface.zeroLiftCl * (1 - 0.45 * sweepT);
  const clLinear = zeroLiftCl + surface.liftSlope * liftSlopeFactor * (alpha + deflection * controlFactor);
  const positiveClMax = (surface.kind === "vertical" ? 1.25 : 1.55) * (1 - 0.24 * sweepT);
  const negativeClMax = (surface.kind === "vertical" ? 1.1 : 1.28) * (1 - 0.2 * sweepT);
  const clAttached = clamp(clLinear, -negativeClMax, positiveClMax);
  const clSeparated = Math.sin(2 * alphaEffective) * (surface.kind === "vertical" ? 0.32 : 0.38);
  const cl = lerp(clAttached, clSeparated, stallSeverity);
  const sweepAspect = sweep ? surface.aspectRatio * (1 - sweep.affectedAreaFraction * (1 - Math.cos(sweep.sweepRad) ** 2) * 0.85) : surface.aspectRatio;
  const inducedDrag = (cl * cl) / (Math.PI * Math.max(sweepAspect, 0.3) * OSWALD_E);
  const aileronDrag = surface.control?.axis === "roll" ? Math.max(0, -deflection) * 0.11 : 0;
  const separatedDrag = stallSeverity * (0.38 + 0.32 * Math.sin(Math.min(Math.abs(alphaEffective), Math.PI / 2)) ** 2);
  const waveDrag = machWaveDragCd(mach, sweepDeg, aircraft.model.machAero);
  const cd =
    surface.cd0 + waveDrag + inducedDrag + separatedDrag + Math.abs(deflection) * 0.035 + aileronDrag;
  const qbar = dynamicPressure(density, surfaceSpeed);

  const vhat = normalize(surfaceVelocity, forward);
  const liftDir = normalize(sub(up, scale(vhat, dot(up, vhat))), up);
  const liftForce = scale(liftDir, qbar * surface.areaM2 * cl);
  const dragForce = scale(vhat, -qbar * surface.areaM2 * cd);
  const force = add(liftForce, dragForce);
  const cpShiftWorld = rotateVec(
    aircraft.orientation,
    scale(surface.localForward, -surface.chordM * 0.18 * stallSeverity),
  );
  const forceArmWorld = add(rWorld, cpShiftWorld);
  return {
    force,
    liftForce,
    torque: cross(forceArmWorld, force),
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
    const guidedRound = guideHeatSeekingMissile(round, aircraft, dt);
    const profile = projectileProfile(guidedRound.kind);
    const p0 = guidedRound.position;
    const p1 = add(p0, scale(guidedRound.velocity, dt));
    const stepLen = length(sub(p1, p0));

    // Swept hit test against every enemy target with health, keeping the closest intercept along the
    // segment so a round can't pass two contacts and credit the wrong one.
    let hit: { target: AircraftState; distSq: number } | undefined;
    for (const target of aircraft) {
      if (target.team === guidedRound.team || target.health <= 0 || target.id === guidedRound.ownerId) continue;
      const radius = projectileHitRadiusM(guidedRound, target);
      const distSq = closestApproachSqToPoint(p0, p1, target.position);
      if (distSq <= radius * radius && (!hit || distSq < hit.distSq)) {
        hit = { target, distSq };
      }
    }

    if (hit) {
      const target = hit.target;
      target.health = clamp(target.health - profile.damage, 0, 100);
      events.push({
        type: "hit",
        actorId: guidedRound.ownerId,
        targetId: target.id,
        message: `${profile.label} from ${guidedRound.ownerId} hits ${target.callsign} for ${profile.damage}`,
        origin: p0,
        impact: target.position,
      });
      continue; // round is consumed
    }

    const travelled = guidedRound.distanceTravelledM + stepLen;
    const age = time + dt - guidedRound.spawnTime;
    if (travelled > profile.maxRangeM || age > profile.lifetimeS) continue; // despawn
    survivors.push({ ...guidedRound, position: p1, distanceTravelledM: travelled });
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
  const qbar = dynamicPressure(density, speed);
  const mach = machAtSpeed(speed, aircraft.position.y);
  const sweep = modelSweepState(model, speed, aircraft.position.y);
  const overspeed = airspeedLimitExceedance(model, speed, aircraft.position.y);

  // Fuel: a tanked airframe (fuelCapacityKg > 0) burns ∝ thrust and cuts thrust when dry; a tankless
  // one has infinite fuel. Fuel lives in individual tanks, so burn changes total mass, CoM, and inertia.
  currentMassProperties(aircraft);
  const tanked = model.fuelCapacityKg > 0;
  const hasFuel = !tanked || aircraft.fuelKg > 0;
  const targetThrustSetting = hasFuel ? JET_IDLE_SPOOL + controls.throttle * (1 - JET_IDLE_SPOOL) : 0;
  const spoolSetting = model.jetPropulsions.length > 0
    ? stepJetSpool(aircraft, targetThrustSetting, dt)
    : targetThrustSetting;
  const thrustSetting = hasFuel ? spoolSetting : 0;
  const commandedThrustN = model.maxThrustN * thrustSetting;
  const massProperties = currentMassProperties(aircraft);
  const effectiveMassKg = Math.max(massProperties.massKg, 1); // floor guards a fully-empty build
  const com = massProperties.com;

  const omegaWorld = bodyOmegaWorld(aircraft);
  let totalForce = vec3(0, 0, 0);
  let totalTorque = vec3(0, 0, 0);
  let loadForce = vec3(0, 0, 0);
  let maxSurfaceStall = 0;
  let horizontalAlphaArea = 0;
  let horizontalArea = 0;
  let fuelBurnKgS = 0;
  let afterburnerFraction = 0;
  const surfaceControls: NonNullable<AircraftState["surfaceControls"]> = [];

  for (const surface of model.aeroSurfaces) {
    const sample = sampleSurface(surface, aircraft, controls, density, aircraft.position.y, omegaWorld, com);
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
    const parasiteArea = model.parasiteDragAreaM2 * (model.machAero?.parasiteAreaScale ?? 1);
    const bodyWaveDragN = model.machAero
      ? qbar * Math.max(model.wingAreaM2, 1) * machWaveDragCd(mach, sweep?.sweepDeg ?? 0, model.machAero) * 0.45
      : 0;
    const overspeedDragN = overspeed > 0
      ? qbar * OVERSPEED_DRAG_AREA_M2 * Math.min(overspeed * overspeed * 18, 6)
      : 0;
    totalForce = add(
      totalForce,
      scale(normalize(aircraft.velocity), -(qbar * parasiteArea + bodyWaveDragN + overspeedDragN)),
    );
  }

  if (overspeed > 0) {
    aircraft.health = clamp(aircraft.health - OVERSPEED_DAMAGE_PER_S * overspeed * dt, 0, 100);
  }

  if (commandedThrustN > 0) {
    let appliedThrustPoint = false;
    for (const point of model.propulsions) {
      const localForward = rotateVec(aircraft.orientation, point.localForward);
      const rWorld = rotateVec(aircraft.orientation, sub(point.localOffset, com));
      const diskVelocity = add(aircraft.velocity, cross(omegaWorld, rWorld));
      const axialAirspeed = Math.max(0, dot(diskVelocity, localForward));
      const sample = samplePropulsion(point, axialAirspeed, density, thrustSetting);
      const force = scale(localForward, sample.thrustN);
      totalForce = add(totalForce, force);
      totalTorque = add(totalTorque, cross(rWorld, force));
      fuelBurnKgS += SFC * sample.thrustN;
      appliedThrustPoint = true;
    }

    for (const point of model.jetPropulsions) {
      const localForward = rotateVec(aircraft.orientation, point.localForward);
      const rWorld = rotateVec(aircraft.orientation, sub(point.localOffset, com));
      const inletVelocity = add(aircraft.velocity, cross(omegaWorld, rWorld));
      const axialAirspeed = Math.max(0, dot(inletVelocity, localForward));
      const sample = sampleJetPropulsion(point, axialAirspeed, aircraft.position.y, thrustSetting);
      const force = scale(localForward, sample.thrustN);
      totalForce = add(totalForce, force);
      totalTorque = add(totalTorque, cross(rWorld, force));
      fuelBurnKgS += sample.fuelFlowKgS;
      afterburnerFraction = Math.max(afterburnerFraction, sample.afterburnerFraction);
      appliedThrustPoint = true;
    }

    for (const point of model.thrustPoints) {
      const force = scale(rotateVec(aircraft.orientation, point.localForward), point.maxThrustN * thrustSetting);
      const rWorld = rotateVec(aircraft.orientation, sub(point.localOffset, com));
      totalForce = add(totalForce, force);
      totalTorque = add(totalTorque, cross(rWorld, force));
      fuelBurnKgS += SFC * point.maxThrustN * thrustSetting;
      appliedThrustPoint = true;
    }

    if (!appliedThrustPoint) {
      totalForce = add(totalForce, scale(basis.forward, commandedThrustN));
      fuelBurnKgS += SFC * commandedThrustN;
    }
  }

  if (tanked && fuelBurnKgS > 0) burnFuel(aircraft, fuelBurnKgS * dt);

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

  const torqueLocal = worldVectorToLocal(totalTorque, basis);
  let omegaLocal = integrateBodyAngularVelocity(
    bodyRatesToLocalOmega(aircraft.angularVelocity),
    torqueLocal,
    massProperties.inertiaTensor,
    dt,
  );
  const nextRates = localOmegaToBodyRates(omegaLocal);
  aircraft.angularVelocity = vec3(
    clamp(Number.isFinite(nextRates.x) ? nextRates.x : 0, -MAX_BODY_RATE_RAD_S, MAX_BODY_RATE_RAD_S),
    clamp(Number.isFinite(nextRates.y) ? nextRates.y : 0, -MAX_BODY_RATE_RAD_S, MAX_BODY_RATE_RAD_S),
    clamp(Number.isFinite(nextRates.z) ? nextRates.z : 0, -MAX_BODY_RATE_RAD_S, MAX_BODY_RATE_RAD_S),
  );
  omegaLocal = bodyRatesToLocalOmega(aircraft.angularVelocity);

  aircraft.orientation = integrateLocalAngularVelocity(
    aircraft.orientation,
    omegaLocal,
    dt,
  );
  aircraft.weaponCooldown = Math.max(0, aircraft.weaponCooldown - dt);

  const metricAoa = horizontalArea > 0 ? horizontalAlphaArea / horizontalArea : aoa;
  const stalled = speed < stallSpeedMps(model, density, effectiveMassKg) || maxSurfaceStall > 0.2;
  const gLoad = length(loadForce) / (effectiveMassKg * GRAVITY_MPS2);
  const finalAirspeed = length(aircraft.velocity);
  const finalMach = machAtSpeed(finalAirspeed, aircraft.position.y);
  const finalDensity = densityAtAltitude(aircraft.position.y);
  const finalSweep = modelSweepState(model, finalAirspeed, aircraft.position.y);

  return {
    airspeed: finalAirspeed,
    altitude: aircraft.position.y,
    aoaDeg: (metricAoa * 180) / Math.PI,
    gLoad,
    stalled: stalled || overspeed > 0.18,
    mach: finalMach,
    dynamicPressurePa: dynamicPressure(finalDensity, finalAirspeed),
    ...(finalSweep ? { sweepDeg: finalSweep.sweepDeg } : {}),
    afterburner: afterburnerFraction > 0.05,
    ...(model.jetPropulsions.length > 0 ? { engineSpool: aircraft.engineSpool ?? thrustSetting } : {}),
  };
}

function stepJetSpool(aircraft: AircraftState, targetThrustSetting: number, dt: number): number {
  const previous = clamp(aircraft.engineSpool ?? JET_IDLE_SPOOL, 0, 1);
  const target = clamp(targetThrustSetting, 0, 1);
  const increasing = target > previous;
  const burnerTransition = target > 0.82 || previous > 0.82;
  const tau = increasing ? (burnerTransition ? 0.75 : 2.2) : 1.0;
  const alpha = 1 - Math.exp(-Math.max(dt, 0) / tau);
  const next = previous + (target - previous) * alpha;
  aircraft.engineSpool = clamp(next, 0, 1);
  return aircraft.engineSpool;
}

function ammoForStation(shooter: AircraftState, station: WeaponStation): number {
  return shooter.weaponAmmo?.[station.id] ?? station.count;
}

function spendStationAmmo(shooter: AircraftState, station: WeaponStation): void {
  const next = Math.max(0, ammoForStation(shooter, station) - 1);
  shooter.weaponAmmo = { ...(shooter.weaponAmmo ?? {}), [station.id]: next };
}

function firstLoadedMissileStation(shooter: AircraftState): WeaponStation | undefined {
  return shooter.model.weaponStations.find(
    (station) => station.kind === "missile" && ammoForStation(shooter, station) > 0,
  );
}

function spawnMissile(
  shooter: AircraftState,
  station: WeaponStation,
  time: number,
  aircraft: AircraftState[],
  events: ReplayEvent[],
): Projectile {
  spendStationAmmo(shooter, station);
  shooter.weaponCooldown = MISSILE_COOLDOWN_S;

  const forward = normalize(rotateVec(shooter.orientation, station.localForward), basisFromQuat(shooter.orientation).forward);
  const muzzle = add(shooter.position, rotateVec(shooter.orientation, station.localOffset));
  const velocity = add(scale(forward, MISSILE_SPEED), shooter.velocity);
  const initialRound: Projectile = {
    id: `missile-${shooter.id}-${station.id}-${time.toFixed(4)}`,
    kind: "missile",
    guidance: station.guidance,
    ...(station.guidance === "heat-seeking" ? { missileModel: AIM9M_SIDEWINDER_PROFILE.id } : {}),
    position: muzzle,
    velocity,
    ownerId: shooter.id,
    team: shooter.team,
    spawnTime: time,
    distanceTravelledM: 0,
  };
  const heatTarget = station.guidance === "heat-seeking"
    ? strongestHeatTarget(
        initialRound,
        aircraft,
        AIM9M_SIDEWINDER_PROFILE.seekerHalfAngleRad,
        AIM9M_SIDEWINDER_PROFILE.minLockSignal,
      )
    : undefined;
  const target = heatTarget?.target ?? (station.guidance === "none" ? nearestOpponent(shooter, aircraft) : undefined);
  const round: Projectile = {
    ...initialRound,
    lockState: station.guidance === "heat-seeking" ? (heatTarget ? "acquired" : "none") : "none",
    ...(target ? { targetId: target.id } : {}),
    ...(heatTarget
      ? {
          seekerAngleRad: heatTarget.angleRad,
          targetHeat: heatTarget.heat,
          lockSignal: heatTarget.signal,
        }
      : {}),
  };

  events.push({
    type: "shot",
    actorId: shooter.id,
    ...(target ? { targetId: target.id } : {}),
    message: station.guidance === "heat-seeking"
      ? `${shooter.callsign} launches AIM-9M`
      : `${shooter.callsign} launches missile`,
    origin: muzzle,
    ...(target ? { impact: target.position } : {}),
  });

  return round;
}

function spawnBullet(
  shooter: AircraftState,
  time: number,
  aircraft: AircraftState[],
  events: ReplayEvent[],
): Projectile {
  shooter.weaponCooldown = WEAPON_COOLDOWN_S;
  const forward = basisFromQuat(shooter.orientation).forward;
  const muzzle = add(shooter.position, scale(forward, MUZZLE_OFFSET_M));
  // Bullet velocity in the world frame: gun axis * muzzle speed + the platform's own velocity.
  const velocity = add(scale(forward, MUZZLE_SPEED), shooter.velocity);
  const target = nearestOpponent(shooter, aircraft);

  events.push({
    type: "shot",
    actorId: shooter.id,
    ...(target ? { targetId: target.id } : {}),
    message: `${shooter.callsign} fires`,
    origin: muzzle,
    ...(target ? { impact: target.position } : {}),
  });

  // Deterministic id: a ship fires at most one round per step and each step has a unique time, so
  // owner+time is unique across a match AND reproducible run-to-run (no module-level counter that
  // would drift between matches and break replay-determinism).
  return {
    id: `bullet-${shooter.id}-${time.toFixed(4)}`,
    kind: "bullet",
    position: muzzle,
    velocity,
    ownerId: shooter.id,
    team: shooter.team,
    spawnTime: time,
    distanceTravelledM: 0,
    ...(target ? { targetId: target.id } : {}),
  };
}

// Spawn a real weapon for any ship that pulls the trigger this step. Gun-only aircraft keep the legacy
// bullet path. Missile stations spend one round and either fly dumb-fire or acquire an IR target,
// depending on station guidance.
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

    const missileStation = firstLoadedMissileStation(shooter);
    spawned.push(
      missileStation
        ? spawnMissile(shooter, missileStation, time, aircraft, events)
        : spawnBullet(shooter, time, aircraft, events),
    );
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
