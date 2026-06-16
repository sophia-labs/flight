import { SEA_LEVEL_DENSITY_KG_M3, densityAtAltitude, machAtSpeed } from "./aero";
import type { JetPropulsionPoint } from "./types";

export interface JetSample {
  thrustN: number;
  dryThrustN: number;
  afterburnerThrustN: number;
  fuelFlowKgS: number;
  mach: number;
  afterburnerFraction: number;
}

const DRY_TSFC_KG_PER_NS = 1.9e-5;
const AFTERBURNER_TSFC_KG_PER_NS = 5.8e-5;

export function sampleJetPropulsion(
  point: JetPropulsionPoint,
  airspeedMps: number,
  altitudeM: number,
  throttleSetting: number,
): JetSample {
  const throttle = clamp(throttleSetting, 0, 1);
  const mach = machAtSpeed(airspeedMps, altitudeM);
  const dryGate = clamp(point.afterburnerThrottle, 0.55, 0.98);
  const dryCommand = dryGate <= 0 ? 1 : clamp(throttle / dryGate, 0, 1);
  const afterburnerFraction = throttle <= dryGate
    ? 0
    : clamp((throttle - dryGate) / Math.max(1 - dryGate, 0.02), 0, 1);

  const installed = installedThrustFactor(mach, altitudeM);
  const idleThrust = point.dryThrustN * clamp(point.idleThrustFraction, 0, 0.18);
  const dryThrustN = lerp(idleThrust, point.dryThrustN, dryCommand) * installed;
  const afterburnerDelta = Math.max(0, point.afterburnerThrustN - point.dryThrustN);
  const afterburnerThrustN = afterburnerDelta * afterburnerFraction * installed;
  const thrustN = Math.max(0, dryThrustN + afterburnerThrustN);

  return {
    thrustN,
    dryThrustN,
    afterburnerThrustN,
    fuelFlowKgS: dryThrustN * DRY_TSFC_KG_PER_NS + afterburnerThrustN * AFTERBURNER_TSFC_KG_PER_NS,
    mach,
    afterburnerFraction,
  };
}

function installedThrustFactor(mach: number, altitudeM: number): number {
  const sigma = clamp(densityAtAltitude(altitudeM) / SEA_LEVEL_DENSITY_KG_M3, 0.02, 1.05);
  const altitudeLapse = Math.max(0.1, sigma ** 0.46);
  const inletAltitudePenalty = altitudeM <= 14_000
    ? 1
    : clamp(Math.exp(-(altitudeM - 14_000) / 4_800), 0.24, 1);
  const ramRise = clamp(1 + mach * 0.38 - mach * mach * 0.055, 0.82, 1.48);
  const inletRecovery =
    mach <= 1.6
      ? 1
      : clamp(1 - (mach - 1.6) * 0.16, 0.76, 1);
  return altitudeLapse * inletAltitudePenalty * ramRise * inletRecovery;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * clamp(t, 0, 1);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
