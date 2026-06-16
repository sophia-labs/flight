import type { AircraftModel } from "./types";
import { vec3 } from "./math";

export const GRAVITY_MPS2 = 9.81;
export const GRAVITY = vec3(0, -GRAVITY_MPS2, 0);
export const SEA_LEVEL_DENSITY_KG_M3 = 1.225;
export const SEA_LEVEL_TEMPERATURE_K = 288.15;
export const TROPOPAUSE_TEMPERATURE_K = 216.65;
export const TEMPERATURE_LAPSE_K_PER_M = 0.0065;
export const AIR_GAMMA = 1.4;
export const AIR_GAS_CONSTANT_J_KG_K = 287.05;

// Calibrated so the default airframe stays near the old 62 m/s sea-level stall cue, while custom
// wing-loading and altitude now move the threshold in the physically expected direction.
const STALL_SPEED_CL_MAX = 1.7;

export function densityAtAltitude(altitudeM: number): number {
  return SEA_LEVEL_DENSITY_KG_M3 * Math.exp(-Math.max(altitudeM, 0) / 8_800);
}

export function temperatureAtAltitude(altitudeM: number): number {
  return Math.max(
    TROPOPAUSE_TEMPERATURE_K,
    SEA_LEVEL_TEMPERATURE_K - Math.max(altitudeM, 0) * TEMPERATURE_LAPSE_K_PER_M,
  );
}

export function speedOfSoundAtAltitude(altitudeM: number): number {
  return Math.sqrt(AIR_GAMMA * AIR_GAS_CONSTANT_J_KG_K * temperatureAtAltitude(altitudeM));
}

export function machAtSpeed(airspeedMps: number, altitudeM: number): number {
  return Math.max(0, airspeedMps) / Math.max(speedOfSoundAtAltitude(altitudeM), 1);
}

export function dynamicPressure(densityKgM3: number, speedMps: number): number {
  return 0.5 * Math.max(densityKgM3, 0) * speedMps * speedMps;
}

export function stallSpeedMps(
  model: Pick<AircraftModel, "wingAreaM2" | "massKg">,
  densityKgM3: number = SEA_LEVEL_DENSITY_KG_M3,
  massKg: number = model.massKg,
): number {
  if (model.wingAreaM2 <= 0) return Infinity;
  const density = Math.max(densityKgM3, 0.05);
  const mass = Math.max(massKg, 1);
  return Math.sqrt((2 * mass * GRAVITY_MPS2) / (density * model.wingAreaM2 * STALL_SPEED_CL_MAX));
}

export interface SweepState {
  t: number;
  sweepDeg: number;
  sweepRad: number;
  affectedAreaFraction: number;
}

export function sweepStateForMach(
  sweep: NonNullable<AircraftModel["variableSweep"]> | undefined,
  mach: number,
): SweepState | null {
  if (!sweep) return null;
  const span = Math.max(sweep.machSwept - sweep.machForward, 0.05);
  const t = clamp01((mach - sweep.machForward) / span);
  const sweepDeg = sweep.minSweepDeg + (sweep.maxSweepDeg - sweep.minSweepDeg) * t;
  return {
    t,
    sweepDeg,
    sweepRad: (sweepDeg * Math.PI) / 180,
    affectedAreaFraction: clamp01(sweep.affectedAreaFraction ?? 1),
  };
}

export function modelSweepState(model: AircraftModel, speedMps: number, altitudeM: number): SweepState | null {
  return sweepStateForMach(model.variableSweep, machAtSpeed(speedMps, altitudeM));
}

export function effectiveAspectRatio(model: AircraftModel, speedMps: number, altitudeM: number): number {
  const sweep = modelSweepState(model, speedMps, altitudeM);
  if (!sweep) return model.aspectRatio;
  const cosSweep = Math.cos(sweep.sweepRad);
  const sweptPenalty = sweep.affectedAreaFraction * (1 - cosSweep * cosSweep) * 0.85;
  return Math.max(0.6, model.aspectRatio * (1 - sweptPenalty));
}

export function effectiveMaxLiftCoefficient(
  model: AircraftModel,
  speedMps: number,
  altitudeM: number,
  baseClMax: number,
): number {
  const mach = machAtSpeed(speedMps, altitudeM);
  const sweep = modelSweepState(model, speedMps, altitudeM);
  const sweepLoss = sweep ? sweep.affectedAreaFraction * (0.24 * sweep.t + 0.08 * Math.sin(sweep.sweepRad)) : 0;
  const compressibilityLoss = mach <= 0.72 ? 0 : clamp01((mach - 0.72) / 1.15) * 0.22;
  return Math.max(0.45, baseClMax * (1 - sweepLoss) * (1 - compressibilityLoss));
}

export function machLiftSlopeFactor(mach: number, sweepDeg = 0): number {
  const subsonicBoost = mach < 0.72 ? 1 / Math.sqrt(Math.max(0.5, 1 - mach * mach * 0.72)) : 1.12;
  const transonicLoss = 1 - clamp01((mach - 0.82) / 0.55) * 0.28;
  const sweepLoss = 1 - clamp01(sweepDeg / 70) * 0.34;
  return clamp(subsonicBoost * transonicLoss * sweepLoss, 0.48, 1.22);
}

export function machControlFactor(mach: number): number {
  if (mach <= 0.82) return 1;
  if (mach <= 1.2) return 1 - (mach - 0.82) * 0.3;
  return clamp(0.88 - (mach - 1.2) * 0.18, 0.55, 0.88);
}

export function machWaveDragCd(
  mach: number,
  sweepDeg = 0,
  profile: AircraftModel["machAero"] | undefined,
): number {
  const sweepDelay = Math.sin((Math.max(0, sweepDeg) * Math.PI) / 180) * 0.32;
  const dragRiseMach = profile?.dragRiseMach ?? 0.76;
  const onset = dragRiseMach + sweepDelay;
  if (mach <= onset) return 0;

  const transonicT = clamp01((mach - onset) / 0.35);
  const transonicCd = (profile?.waveDragCd ?? 0.022) * smoothstep(transonicT);
  const supersonicT = clamp01((mach - 1.05) / 1.4);
  const supersonicCd = (profile?.supersonicWaveDragCd ?? 0.018) * supersonicT * supersonicT;
  return transonicCd + supersonicCd;
}

export function isWithinAirspeedLimits(model: AircraftModel, speedMps: number, altitudeM: number): boolean {
  return airspeedLimitExceedance(model, speedMps, altitudeM) <= 0;
}

export function airspeedLimitExceedance(model: AircraftModel, speedMps: number, altitudeM: number): number {
  const profile = model.machAero;
  if (!profile) return 0;
  let exceedance = 0;
  const mach = machAtSpeed(speedMps, altitudeM);
  if (profile.maxMach !== undefined) {
    exceedance = Math.max(exceedance, mach / Math.max(profile.maxMach, 0.1) - 1);
  }
  if (profile.qLimitPa !== undefined) {
    const qbar = dynamicPressure(densityAtAltitude(altitudeM), speedMps);
    exceedance = Math.max(exceedance, qbar / Math.max(profile.qLimitPa, 1) - 1);
  }
  return Math.max(0, exceedance);
}

function smoothstep(t: number): number {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
