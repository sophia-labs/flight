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

export const DEFAULT_PROP_CURVE: PropCurvePoint[] = [
  { j: 0, ct: 0.22, cp: 0.09 },
  { j: 0.25, ct: 0.205, cp: 0.095 },
  { j: 0.5, ct: 0.16, cp: 0.085 },
  { j: 0.75, ct: 0.105, cp: 0.068 },
  { j: 1.0, ct: 0.052, cp: 0.049 },
  { j: 1.2, ct: 0.012, cp: 0.035 },
  { j: 1.35, ct: -0.01, cp: 0.028 },
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
  const powerAvailableW = point.maxPowerW * throttle * densityPowerFactor(densityKgM3);
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
  const thrustN = coeff.ct * density * rps ** 2 * diameter ** 4;
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
  const pitchRatio = clamp(point.pitchM / diameter, 0.35, 1.35);
  const pitchJScale = clamp(pitchRatio / 0.7, 0.62, 1.48);
  const bladeCtScale = 1 + (point.bladeCount - 3) * 0.04;
  const bladeCpScale = 1 + (point.bladeCount - 3) * 0.08;
  const pitchCtScale = clamp(1 + (pitchRatio - 0.7) * 0.22, 0.84, 1.14);
  const pitchCpScale = clamp(1 + (pitchRatio - 0.7) * 0.32, 0.82, 1.22);
  const lookupJ = advanceRatioValue / pitchJScale;
  const curve = point.curve.length >= 2 ? point.curve : DEFAULT_PROP_CURVE;
  return {
    ct: interpolateCurve(curve, lookupJ, "ct") * bladeCtScale * pitchCtScale,
    cp: Math.max(interpolateCurve(curve, lookupJ, "cp") * bladeCpScale * pitchCpScale, MIN_CP),
  };
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

function densityPowerFactor(densityKgM3: number): number {
  return clamp((densityKgM3 / 1.225) ** 0.85, 0.18, 1.05);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
