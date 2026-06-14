import { clampControlInput, type ControlInput, type ReplayEvent } from "../protocol/schema";
import { compileAirframe, defaultAirframe } from "./airframe";
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
import type { AircraftModel, AircraftState, FlightMetrics, StepResult } from "./types";

const GRAVITY = vec3(0, -9.81, 0);
const SEA_LEVEL_DENSITY = 1.225;
const TERRAIN_FLOOR_M = 55;

// Aerodynamic rotational damping per axis. These set the control time-constant τ = I/(qbar·DAMP) — and
// ONLY τ, because the steady-state rate cancels DAMP — calibrated against the default's inertia so the
// default's response (roll τ≈0.22 s, pitch≈0.45 s, yaw≈0.75 s at cruise) matches the old kinematic feel.
const DAMP_ROLL = 33.5;
const DAMP_PITCH = 70.0;
const DAMP_YAW = 50.0;

// Static-stability gain: a stable airframe (CoM ahead of the aero centre, staticMarginM > 0) makes a
// restoring pitch moment ∝ staticMargin·q̄·area·AoA that weathervanes the nose back toward the relative
// wind. Tuned gentle so the plane trims hands-off without fighting a commanded turn.
const STAB_K = 0.5;

// Dihedral (roll-stability) gain: sideslip produces a rolling moment toward wings-level. A coordinated
// turn carries ~no sideslip, so this doesn't fight commanded banking — it only damps out skidding and
// the slow knife-edge/inverted attitudes an uncoordinated pilot falls into. The real fix for "flies like
// a maniac" is the pilot, but this stops the airframe from happily living at any bank angle.
const DIHEDRAL_K = 1.5;

// Oswald span efficiency for the induced-drag polar cd_i = cl²/(π·AR·e). With the default AR≈7.5 this
// lands at ≈0.053 — essentially the old constant 0.052 — so the default is undisturbed, while a stubby
// low-AR build now pays a real induced-drag penalty and a long-winged build is rewarded.
const OSWALD_E = 0.8;

// Specific fuel consumption (kg burned per N of thrust per second). Sized so an ~1800 kg tank gives
// ~400 s of full-throttle endurance — visible drain over a long fight, not match-ending in a short one.
const SFC = 6e-5;

// The default airframe's compiled model — the calibration baseline. Computed via compileAirframe (one
// source of truth) rather than a hand-written literal now that the model carries derived inertia/CoM/etc.
export const DEFAULT_MODEL: AircraftModel = compileAirframe(defaultAirframe()).model;

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
  const cd = 0.034 + (cl * cl) / (Math.PI * model.aspectRatio * OSWALD_E) + stallSeverity * 0.28;
  const drag = scale(normalize(aircraft.velocity), -qbar * model.wingAreaM2 * cd);
  // Fuel: a tanked airframe (fuelCapacityKg > 0) burns ∝ thrust and cuts thrust when dry; a tankless
  // one has infinite fuel. effectiveMass shrinks as fuel burns, so the aircraft accelerates/climbs
  // better light. (CoM + inertia are held at the wet value — a stated cut.)
  const tanked = model.fuelCapacityKg > 0;
  const hasFuel = !tanked || aircraft.fuelKg > 0;
  const thrustN = hasFuel ? model.maxThrustN * (0.14 + controls.throttle * 0.86) : 0;
  if (tanked) aircraft.fuelKg = Math.max(0, aircraft.fuelKg - SFC * thrustN * dt);
  const effectiveMassKg = Math.max(model.dryMassKg + aircraft.fuelKg, 1); // floor guards a fully-empty build

  const thrust = scale(basis.forward, thrustN);
  const totalForce = add(add(add(lift, sideForce), drag), thrust);
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

  // --- Rigid-body rotation (v0.6.0) ---
  // Control surfaces make torque ∝ qbar·stick; aerodynamic damping opposes the body rate ∝ qbar·ω.
  // Steady-state full-stick rate = model.maxRate (qbar AND damp cancel at equilibrium), so the calibrated
  // default reproduces the old kinematic rates; speed-dependence is now EMERGENT via the time constant
  // τ = I/(qbar·damp) — slow and sluggish when slow, snappy when fast. Damping is integrated IMPLICITLY
  // (the ω_next = (ω + dt·τ_ctrl/I)/(1 + dt·qbar·damp/I) form), which is unconditionally stable even at
  // this coarse 16 ms step where an explicit scheme would ring or diverge in a dive.
  const stallBite = stalled ? 0.52 : 1; // control surfaces lose authority in the buffet (old stall feel)
  const ctrlRoll = controls.roll * model.maxRollRate * DAMP_ROLL * qbar * stallBite;
  const ctrlPitch = controls.pitch * model.maxPitchRate * DAMP_PITCH * qbar * stallBite;
  const ctrlYaw = -controls.yaw * model.maxYawRate * DAMP_YAW * qbar * stallBite;
  // Static restoring moment (pitch): nose-up AoA on a stable airframe produces a nose-down torque that
  // weathervanes back toward the relative wind. Zero at AoA 0, so it adds no standing torque in level
  // flight. Goes in the torque numerator (it doesn't depend on the rate).
  const tauStabPitch = -STAB_K * model.staticMarginM * model.wingAreaM2 * qbar * aoa;
  // Dihedral: sideslip rolls the aircraft back toward wings-level (toward the relative wind).
  const tauDihedralRoll = -DIHEDRAL_K * model.wingAreaM2 * qbar * sideSlip;
  const omega = aircraft.angularVelocity;
  const wRoll = (omega.x + (dt * (ctrlRoll + tauDihedralRoll)) / model.inertia.roll) / (1 + (dt * qbar * DAMP_ROLL) / model.inertia.roll);
  const wPitch = (omega.y + (dt * (ctrlPitch + tauStabPitch)) / model.inertia.pitch) / (1 + (dt * qbar * DAMP_PITCH) / model.inertia.pitch);
  const wYaw = (omega.z + (dt * ctrlYaw) / model.inertia.yaw) / (1 + (dt * qbar * DAMP_YAW) / model.inertia.yaw);
  aircraft.angularVelocity = vec3(wRoll, wPitch, wYaw);

  let orientation = aircraft.orientation;
  orientation = rotateAroundWorldAxis(orientation, basis.forward, wRoll * dt);
  orientation = rotateAroundWorldAxis(orientation, basis.right, wPitch * dt);
  orientation = rotateAroundWorldAxis(orientation, basis.up, wYaw * dt);
  aircraft.orientation = orientation;
  aircraft.weaponCooldown = Math.max(0, aircraft.weaponCooldown - dt);

  const loadForce = length(add(lift, sideForce));
  const gLoad = loadForce / (effectiveMassKg * 9.81);

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
