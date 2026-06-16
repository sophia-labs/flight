import type { PropCurvePoint } from "../protocol/schema";
import type { PropulsionPoint } from "./types";

export interface PropellerSample {
  thrustN: number;
  shaftPowerW: number;
  rpm: number;
  advanceRatio: number;
  ct: number;
  cp: number;
}

const MIN_CP = 0.008;
const SEA_LEVEL_DENSITY_KG_M3 = 1.225;
const DENSITY_SCALE_HEIGHT_M = 8_800;

export const DEFAULT_PROP_CURVE: PropCurvePoint[] = [
  { j: 0, ct: 0.2, cp: 0.09 },
  { j: 0.25, ct: 0.19, cp: 0.092 },
  { j: 0.5, ct: 0.15, cp: 0.083 },
  { j: 0.75, ct: 0.1, cp: 0.066 },
  { j: 1.0, ct: 0.055, cp: 0.048 },
  { j: 1.25, ct: 0.024, cp: 0.034 },
  { j: 1.5, ct: 0.008, cp: 0.026 },
];

export function samplePropulsion(
  point: PropulsionPoint,
  airspeedMps: number,
  densityKgM3: number,
  throttleSetting: number,
): PropellerSample {
  const density = Math.max(densityKgM3, 0.05);
  const throttle = Math.max(0, Math.min(1, throttleSetting));
  const diameter = Math.max(point.diameterM, 0.2);
  const powerAvailableW = point.maxPowerW * throttle * densityPowerFactor(point, density);
  if (powerAvailableW <= 0) {
    return zeroSample(point, 0);
  }

  const idleRps = Math.max(point.idleRpm / 60, 4);
  const maxRps = Math.max(point.maxRpm / 60, idleRps + 1);
  let rps =
    point.mode === "constant-speed"
      ? maxRps * (0.72 + throttle * 0.28)
      : idleRps + (maxRps - idleRps) * Math.sqrt(throttle);

  for (let i = 0; i < 5; i += 1) {
    const j = advanceRatio(airspeedMps, rps, diameter);
    const coeff = coefficients(point, j);
    const loadLimitedRps = Math.cbrt(powerAvailableW / (Math.max(coeff.cp, MIN_CP) * density * diameter ** 5));
    if (point.mode === "constant-speed") {
      const targetRps = maxRps * (0.72 + throttle * 0.28);
      rps = clamp(loadLimitedRps, idleRps, targetRps);
    } else {
      rps = clamp(loadLimitedRps, idleRps, maxRps);
    }
  }

  const j = advanceRatio(airspeedMps, rps, diameter);
  const coeff = coefficients(point, j);
  const shaftPowerW = Math.min(powerAvailableW, coeff.cp * density * rps ** 3 * diameter ** 5);
  const coefficientThrustN = coeff.ct * density * rps ** 2 * diameter ** 4;
  const propulsiveThrustN =
    airspeedMps > 8 ? (propulsiveEfficiency(point, j) * shaftPowerW) / Math.max(airspeedMps, 1) : Infinity;
  const thrustN = Math.max(0, Math.min(coefficientThrustN, propulsiveThrustN));
  return {
    thrustN: Number.isFinite(thrustN) ? thrustN : 0,
    shaftPowerW: Number.isFinite(shaftPowerW) ? shaftPowerW : 0,
    rpm: rps * 60,
    advanceRatio: j,
    ct: coeff.ct,
    cp: coeff.cp,
  };
}

export function estimatePropulsionStaticThrust(point: PropulsionPoint, densityKgM3 = 1.225): number {
  return samplePropulsion(point, 0, densityKgM3, 1).thrustN;
}

export function estimatePropulsionPeakThrust(point: PropulsionPoint, densityKgM3 = 1.225): number {
  let peak = -Infinity;
  for (let speed = 0; speed <= 190; speed += 10) {
    peak = Math.max(peak, samplePropulsion(point, speed, densityKgM3, 1).thrustN);
  }
  return Math.max(0, peak);
}

function coefficients(point: PropulsionPoint, advanceRatioValue: number) {
  const diameter = Math.max(point.diameterM, 0.2);
  const pitchRatio = effectivePitchRatio(point, advanceRatioValue, diameter);
  const pitchJScale = clamp(pitchRatio / 0.7, 0.62, 2.35);
  const bladeCtScale = 1 + (point.bladeCount - 3) * 0.04;
  const bladeCpScale = 1 + (point.bladeCount - 3) * 0.08;
  const pitchCtScale = clamp(1 + (pitchRatio - 0.7) * 0.16, 0.84, 1.16);
  const pitchCpScale = clamp(1 + (pitchRatio - 0.7) * 0.24, 0.82, 1.25);
  const lookupJ = advanceRatioValue / pitchJScale;
  const curve = point.curve.length >= 2 ? point.curve : DEFAULT_PROP_CURVE;
  return {
    ct: interpolateCurve(curve, lookupJ, "ct") * bladeCtScale * pitchCtScale,
    cp: Math.max(interpolateCurve(curve, lookupJ, "cp") * bladeCpScale * pitchCpScale, MIN_CP),
  };
}

function effectivePitchRatio(point: PropulsionPoint, advanceRatioValue: number, diameterM: number): number {
  const basePitchRatio = clamp(point.pitchM / diameterM, 0.35, 1.45);
  if (point.mode !== "constant-speed") return basePitchRatio;
  return clamp(Math.max(basePitchRatio, advanceRatioValue * 0.78), basePitchRatio, 1.65);
}

function propulsiveEfficiency(point: PropulsionPoint, advanceRatioValue: number): number {
  const bestJ = point.mode === "constant-speed" ? 1.05 : 0.75;
  const bladeEfficiency = point.bladeCount <= 2 ? 0.9 : clamp(1 + (point.bladeCount - 3) * 0.025, 0.95, 1.06);
  const peakEfficiency = (point.mode === "constant-speed" ? 0.86 : 0.74) * bladeEfficiency;
  const rise = Math.sin(clamp(advanceRatioValue / bestJ, 0, 1) * (Math.PI / 2));
  const overspeedStart = point.mode === "constant-speed" ? 1.6 : 1.15;
  const overspeedPenalty = clamp(1 - Math.max(0, advanceRatioValue - overspeedStart) * 0.35, 0.65, 1);
  return peakEfficiency * rise * overspeedPenalty;
}

function interpolateCurve(curve: PropCurvePoint[], j: number, key: "ct" | "cp"): number {
  const sorted = [...curve].sort((a, b) => a.j - b.j);
  if (j <= sorted[0].j) return sorted[0][key];
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1];
    const next = sorted[i];
    if (j <= next.j) {
      const t = (j - prev.j) / Math.max(next.j - prev.j, 1e-6);
      return prev[key] + (next[key] - prev[key]) * t;
    }
  }
  return sorted[sorted.length - 1][key];
}

function zeroSample(point: PropulsionPoint, rpm: number): PropellerSample {
  return {
    thrustN: 0,
    shaftPowerW: 0,
    rpm,
    advanceRatio: 0,
    ct: point.curve[0]?.ct ?? 0,
    cp: point.curve[0]?.cp ?? 0,
  };
}

function advanceRatio(airspeedMps: number, rps: number, diameterM: number): number {
  return Math.max(0, airspeedMps) / Math.max(rps * diameterM, 0.1);
}

function densityPowerFactor(point: PropulsionPoint, densityKgM3: number): number {
  const criticalAltitudeM = Math.max(0, point.criticalAltitudeM);
  const criticalDensity = SEA_LEVEL_DENSITY_KG_M3 * Math.exp(-criticalAltitudeM / DENSITY_SCALE_HEIGHT_M);
  if (densityKgM3 >= criticalDensity) return 1;
  return clamp((densityKgM3 / criticalDensity) ** 1.35, 0.08, 1.03);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
