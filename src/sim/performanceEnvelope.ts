import {
  GRAVITY_MPS2,
  SEA_LEVEL_DENSITY_KG_M3,
  densityAtAltitude,
  dynamicPressure,
  effectiveAspectRatio,
  effectiveMaxLiftCoefficient,
  isWithinAirspeedLimits,
  machAtSpeed,
  machWaveDragCd,
  modelSweepState,
} from "./aero";
import { sampleJetPropulsion } from "./jet";
import { samplePropulsion } from "./propulsion";
import type { AircraftModel } from "./types";

export const ENVELOPE_MODEL_VERSION = "point-mass-envelope@1";
export const DEFAULT_ENVELOPE_CL_MAX = 1.55;
export const DEFAULT_OSWALD_E = 0.8;
export const SERVICE_CEILING_CLIMB_MPS = 0.508; // 100 ft/min
export const SIM_THRUST_SFC_KG_PER_NS = 6e-5;

export interface EnvelopeSpeedGrid {
  minMps: number;
  maxMps: number;
  stepMps: number;
}

export interface AccelerationSegmentSpec {
  id: string;
  fromMps: number;
  toMps: number;
  altitudeM: number;
}

export interface EnvelopeConfig {
  altitudeM: number[];
  speedGrid: EnvelopeSpeedGrid;
  structuralLoadLimitG: number;
  maxLiftCoefficient: number;
  oswaldEfficiency: number;
  serviceCeilingClimbMps: number;
  accelerationSegments: AccelerationSegmentSpec[];
}

export interface AircraftEnvelopeScalars {
  massKg: number;
  dryMassKg: number;
  fuelCapacityKg: number;
  wingAreaM2: number;
  aspectRatio: number;
  wingLoadingNM2: number;
  thrustToWeight: number;
  parasiteDragAreaM2: number;
  horizontalCd0: number;
  powerHp: number;
  jetDryThrustN: number;
  jetAfterburnerThrustN: number;
  dryThrustToWeight: number;
  afterburnerThrustToWeight: number;
  criticalAltitudeM: number;
  maxMach: number | null;
  sweepRangeDeg: string | null;
  fullThrottleEnduranceS: number | null;
  controlAuthority: {
    pitch: number;
    roll: number;
    yaw: number;
  };
}

export interface LevelEnvelopePoint {
  altitudeM: number;
  speedMps: number;
  mach: number;
  sweepDeg: number | null;
  dynamicPressurePa: number;
  densityKgM3: number;
  requiredCl: number | null;
  stallMargin: number | null;
  availableThrustN: number;
  dragN: number | null;
  excessThrustN: number | null;
  specificExcessPowerMps: number | null;
  climbRateMps: number | null;
  levelFlight: boolean;
}

export type TurnLimit = "lift" | "structure" | "power" | "not-level";

export interface TurnEnvelopePoint {
  altitudeM: number;
  speedMps: number;
  mach: number;
  sweepDeg: number | null;
  liftLimitG: number;
  instantaneousLoadG: number;
  instantaneousTurnRateDps: number | null;
  instantaneousTurnRadiusM: number | null;
  sustainedLoadG: number | null;
  sustainedTurnRateDps: number | null;
  sustainedTurnRadiusM: number | null;
  sustainedSpecificExcessPowerMps: number | null;
  limit: TurnLimit;
}

export interface TurnMetric {
  altitudeM: number;
  speedMps: number;
  loadG: number;
  turnRateDps: number;
  turnRadiusM: number;
}

export interface AltitudeEnvelopeSummary {
  altitudeM: number;
  stallSpeedMps: number | null;
  topLevelSpeedMps: number | null;
  bestClimbRateMps: number | null;
  bestClimbSpeedMps: number | null;
  bestSpecificExcessPowerMps: number | null;
  cornerSpeedMps: number | null;
  bestInstantaneousTurn: TurnMetric | null;
  bestSustainedTurn: TurnMetric | null;
  minimumInstantaneousRadius: TurnMetric | null;
  minimumSustainedRadius: TurnMetric | null;
}

export interface AccelerationSegmentResult extends AccelerationSegmentSpec {
  timeS: number | null;
  limitingReason: "ok" | "below-stall" | "insufficient-excess-thrust";
}

export interface AircraftPerformanceEnvelope {
  version: typeof ENVELOPE_MODEL_VERSION;
  aircraftId: string;
  aircraftName: string;
  role?: string;
  config: EnvelopeConfig;
  scalars: AircraftEnvelopeScalars;
  level: LevelEnvelopePoint[];
  turn: TurnEnvelopePoint[];
  summaries: AltitudeEnvelopeSummary[];
  acceleration: AccelerationSegmentResult[];
  serviceCeilingM: number | null;
  absoluteCeilingM: number | null;
}

export const DEFAULT_ENVELOPE_CONFIG: EnvelopeConfig = {
  altitudeM: [0, 1_000, 2_000, 4_000, 6_000, 8_000, 10_000, 12_000, 14_000, 16_000, 18_000],
  speedGrid: { minMps: 20, maxMps: 760, stepMps: 5 },
  structuralLoadLimitG: 7.5,
  maxLiftCoefficient: DEFAULT_ENVELOPE_CL_MAX,
  oswaldEfficiency: DEFAULT_OSWALD_E,
  serviceCeilingClimbMps: SERVICE_CEILING_CLIMB_MPS,
  accelerationSegments: [
    { id: "60-100mps-sl", fromMps: 60, toMps: 100, altitudeM: 0 },
    { id: "100-140mps-sl", fromMps: 100, toMps: 140, altitudeM: 0 },
    { id: "100-160mps-4km", fromMps: 100, toMps: 160, altitudeM: 4_000 },
    { id: "250-450mps-6km", fromMps: 250, toMps: 450, altitudeM: 6_000 },
    { id: "mach0.8-1.2-10km", fromMps: 239, toMps: 359, altitudeM: 10_000 },
  ],
};

export function buildPerformanceEnvelope(
  model: AircraftModel,
  opts: {
    aircraftId: string;
    aircraftName: string;
    role?: string;
    config?: Partial<EnvelopeConfig>;
  },
): AircraftPerformanceEnvelope {
  const config = mergeConfig(opts.config);
  const speedSamples = range(config.speedGrid.minMps, config.speedGrid.maxMps, config.speedGrid.stepMps);
  const level: LevelEnvelopePoint[] = [];
  const turn: TurnEnvelopePoint[] = [];

  for (const altitudeM of config.altitudeM) {
    const densityKgM3 = densityAtAltitude(altitudeM);
    for (const speedMps of speedSamples) {
      level.push(sampleLevelPoint(model, speedMps, altitudeM, densityKgM3, config));
      turn.push(sampleTurnPoint(model, speedMps, altitudeM, densityKgM3, config));
    }
  }

  const summaries = config.altitudeM.map((altitudeM) =>
    summarizeAltitude(model, altitudeM, level, turn, config),
  );
  return {
    version: ENVELOPE_MODEL_VERSION,
    aircraftId: opts.aircraftId,
    aircraftName: opts.aircraftName,
    ...(opts.role ? { role: opts.role } : {}),
    config,
    scalars: aircraftEnvelopeScalars(model),
    level,
    turn,
    summaries,
    acceleration: config.accelerationSegments.map((segment) =>
      estimateAccelerationSegment(model, segment, config),
    ),
    serviceCeilingM: ceilingFromSummaries(summaries, config.serviceCeilingClimbMps),
    absoluteCeilingM: ceilingFromSummaries(summaries, 0),
  };
}

export function aircraftEnvelopeScalars(model: AircraftModel): AircraftEnvelopeScalars {
  const weightN = Math.max(model.massKg * GRAVITY_MPS2, 1);
  const powerHp = model.propulsions.reduce((sum, point) => sum + point.maxPowerW / 745.7, 0);
  const jetDryThrustN = model.jetPropulsions.reduce((sum, point) => sum + point.dryThrustN, 0);
  const jetAfterburnerThrustN = model.jetPropulsions.reduce(
    (sum, point) => sum + point.afterburnerThrustN,
    0,
  );
  const criticalAltitudeM = model.propulsions.reduce(
    (highest, point) => Math.max(highest, point.criticalAltitudeM),
    0,
  );
  const sweep = model.variableSweep;
  return {
    massKg: model.massKg,
    dryMassKg: model.dryMassKg,
    fuelCapacityKg: model.fuelCapacityKg,
    wingAreaM2: model.wingAreaM2,
    aspectRatio: model.aspectRatio,
    wingLoadingNM2: weightN / Math.max(model.wingAreaM2, 1),
    thrustToWeight: model.maxThrustN / weightN,
    parasiteDragAreaM2: model.parasiteDragAreaM2,
    horizontalCd0: horizontalCd0(model),
    powerHp,
    jetDryThrustN,
    jetAfterburnerThrustN,
    dryThrustToWeight: jetDryThrustN / weightN,
    afterburnerThrustToWeight: jetAfterburnerThrustN / weightN,
    criticalAltitudeM,
    maxMach: model.machAero?.maxMach ?? null,
    sweepRangeDeg: sweep ? `${Math.round(sweep.minSweepDeg)}-${Math.round(sweep.maxSweepDeg)}` : null,
    fullThrottleEnduranceS:
      model.fuelCapacityKg > 0 && model.maxThrustN > 0
        ? model.fuelCapacityKg / (SIM_THRUST_SFC_KG_PER_NS * model.maxThrustN)
        : null,
    controlAuthority: model.controlAuthority,
  };
}

export function availableThrustN(
  model: AircraftModel,
  airspeedMps: number,
  densityKgM3: number,
  throttle = 1,
  altitudeM = altitudeMFromDensity(densityKgM3),
): number {
  let thrustN = 0;
  for (const point of model.propulsions) {
    thrustN += samplePropulsion(point, airspeedMps, densityKgM3, throttle).thrustN;
  }
  for (const point of model.jetPropulsions) {
    thrustN += sampleJetPropulsion(point, airspeedMps, altitudeM, throttle).thrustN;
  }
  for (const point of model.thrustPoints) {
    thrustN += point.maxThrustN * throttle;
  }
  return thrustN;
}

export function requiredLiftCoefficient(
  model: AircraftModel,
  airspeedMps: number,
  densityKgM3: number,
  loadFactorG = 1,
  altitudeM = altitudeMFromDensity(densityKgM3),
): number {
  const qbar = dynamicPressure(densityKgM3, airspeedMps);
  return (loadFactorG * model.massKg * GRAVITY_MPS2) / Math.max(qbar * effectiveWingAreaM2(model, airspeedMps, altitudeM), 1e-6);
}

export function requiredDragN(
  model: AircraftModel,
  airspeedMps: number,
  densityKgM3: number,
  loadFactorG = 1,
  opts: {
    maxLiftCoefficient?: number;
    oswaldEfficiency?: number;
    altitudeM?: number;
  } = {},
): number {
  const altitudeM = opts.altitudeM ?? altitudeMFromDensity(densityKgM3);
  if (!isWithinAirspeedLimits(model, airspeedMps, altitudeM)) return Infinity;
  const maxLiftCoefficient = effectiveMaxLiftCoefficient(
    model,
    airspeedMps,
    altitudeM,
    opts.maxLiftCoefficient ?? DEFAULT_ENVELOPE_CL_MAX,
  );
  const oswaldEfficiency = opts.oswaldEfficiency ?? DEFAULT_OSWALD_E;
  const qbar = dynamicPressure(densityKgM3, airspeedMps);
  const wingAreaM2 = effectiveWingAreaM2(model, airspeedMps, altitudeM);
  const requiredCl = requiredLiftCoefficient(model, airspeedMps, densityKgM3, loadFactorG, altitudeM);
  if (requiredCl > maxLiftCoefficient) return Infinity;

  const inducedDragCd =
    (requiredCl * requiredCl) / (Math.PI * Math.max(effectiveAspectRatio(model, airspeedMps, altitudeM), 0.3) * oswaldEfficiency);
  const sweep = modelSweepState(model, airspeedMps, altitudeM);
  const waveDragCd = machWaveDragCd(machAtSpeed(airspeedMps, altitudeM), sweep?.sweepDeg ?? 0, model.machAero);
  const parasiteAreaM2 = model.parasiteDragAreaM2 * (model.machAero?.parasiteAreaScale ?? 1);
  return qbar * wingAreaM2 * (horizontalCd0(model) + inducedDragCd + waveDragCd) +
    qbar * (parasiteAreaM2 + wingAreaM2 * waveDragCd * 0.45);
}

export function stallSpeedAtAltitudeMps(
  model: AircraftModel,
  altitudeM: number,
  maxLiftCoefficient = DEFAULT_ENVELOPE_CL_MAX,
  loadFactorG = 1,
): number {
  if (model.wingAreaM2 <= 0 || maxLiftCoefficient <= 0) return Infinity;
  const densityKgM3 = Math.max(densityAtAltitude(altitudeM), 0.05);
  return Math.sqrt(
    (2 * loadFactorG * model.massKg * GRAVITY_MPS2) /
      (densityKgM3 * model.wingAreaM2 * maxLiftCoefficient),
  );
}

export function horizontalCd0(model: AircraftModel): number {
  let areaM2 = 0;
  let weightedCd0 = 0;
  for (const surface of model.aeroSurfaces) {
    if (surface.kind !== "horizontal") continue;
    areaM2 += surface.areaM2;
    weightedCd0 += surface.areaM2 * surface.cd0;
  }
  return areaM2 > 0 ? weightedCd0 / areaM2 : 0.03;
}

function sampleLevelPoint(
  model: AircraftModel,
  speedMps: number,
  altitudeM: number,
  densityKgM3: number,
  config: EnvelopeConfig,
): LevelEnvelopePoint {
  const mach = machAtSpeed(speedMps, altitudeM);
  const sweep = modelSweepState(model, speedMps, altitudeM);
  const requiredCl = requiredLiftCoefficient(model, speedMps, densityKgM3, 1, altitudeM);
  const liftLimit = effectiveMaxLiftCoefficient(model, speedMps, altitudeM, config.maxLiftCoefficient);
  const dragN = requiredCl <= liftLimit
    ? requiredDragN(model, speedMps, densityKgM3, 1, { ...config, altitudeM })
    : Infinity;
  const available = availableThrustN(model, speedMps, densityKgM3, 1, altitudeM);
  const excessThrust = Number.isFinite(dragN) ? available - dragN : null;
  const ps = excessThrust === null
    ? null
    : (excessThrust * speedMps) / Math.max(model.massKg * GRAVITY_MPS2, 1);
  return {
    altitudeM,
    speedMps,
    mach,
    sweepDeg: sweep?.sweepDeg ?? null,
    dynamicPressurePa: dynamicPressure(densityKgM3, speedMps),
    densityKgM3,
    requiredCl: Number.isFinite(requiredCl) ? requiredCl : null,
    stallMargin: Number.isFinite(requiredCl) && requiredCl > 0 ? liftLimit / requiredCl : null,
    availableThrustN: available,
    dragN: Number.isFinite(dragN) ? dragN : null,
    excessThrustN: excessThrust,
    specificExcessPowerMps: ps,
    climbRateMps: ps,
    levelFlight: ps !== null && ps >= 0,
  };
}

function sampleTurnPoint(
  model: AircraftModel,
  speedMps: number,
  altitudeM: number,
  densityKgM3: number,
  config: EnvelopeConfig,
): TurnEnvelopePoint {
  const qbar = dynamicPressure(densityKgM3, speedMps);
  const weightN = Math.max(model.massKg * GRAVITY_MPS2, 1);
  const mach = machAtSpeed(speedMps, altitudeM);
  const sweep = modelSweepState(model, speedMps, altitudeM);
  const clMax = effectiveMaxLiftCoefficient(model, speedMps, altitudeM, config.maxLiftCoefficient);
  const liftLimitG = isWithinAirspeedLimits(model, speedMps, altitudeM)
    ? Math.max(0, (qbar * effectiveWingAreaM2(model, speedMps, altitudeM) * clMax) / weightN)
    : 0;
  const instantaneousLoadG = Math.min(liftLimitG, config.structuralLoadLimitG);
  const instantaneous = turnAtLoad(speedMps, instantaneousLoadG);
  const thrustN = availableThrustN(model, speedMps, densityKgM3, 1, altitudeM);
  const levelDragN = requiredDragN(model, speedMps, densityKgM3, 1, { ...config, altitudeM });

  if (!Number.isFinite(levelDragN) || thrustN < levelDragN || instantaneousLoadG <= 1) {
    return {
      altitudeM,
      speedMps,
      mach,
      sweepDeg: sweep?.sweepDeg ?? null,
      liftLimitG,
      instantaneousLoadG,
      instantaneousTurnRateDps: instantaneous?.turnRateDps ?? null,
      instantaneousTurnRadiusM: instantaneous?.turnRadiusM ?? null,
      sustainedLoadG: null,
      sustainedTurnRateDps: null,
      sustainedTurnRadiusM: null,
      sustainedSpecificExcessPowerMps: null,
      limit: "not-level",
    };
  }

  const sustainedLoadG = solveSustainedLoadG(
    model,
    speedMps,
    altitudeM,
    densityKgM3,
    thrustN,
    instantaneousLoadG,
    config,
  );
  const sustained = turnAtLoad(speedMps, sustainedLoadG);
  const sustainedDragN = requiredDragN(model, speedMps, densityKgM3, sustainedLoadG, { ...config, altitudeM });
  const sustainedPs = ((thrustN - sustainedDragN) * speedMps) / weightN;
  const liftOrStructure = liftLimitG < config.structuralLoadLimitG ? "lift" : "structure";

  return {
    altitudeM,
    speedMps,
    mach,
    sweepDeg: sweep?.sweepDeg ?? null,
    liftLimitG,
    instantaneousLoadG,
    instantaneousTurnRateDps: instantaneous?.turnRateDps ?? null,
    instantaneousTurnRadiusM: instantaneous?.turnRadiusM ?? null,
    sustainedLoadG,
    sustainedTurnRateDps: sustained?.turnRateDps ?? null,
    sustainedTurnRadiusM: sustained?.turnRadiusM ?? null,
    sustainedSpecificExcessPowerMps: Number.isFinite(sustainedPs) ? sustainedPs : null,
    limit: sustainedLoadG < instantaneousLoadG - 0.02 ? "power" : liftOrStructure,
  };
}

function summarizeAltitude(
  model: AircraftModel,
  altitudeM: number,
  level: LevelEnvelopePoint[],
  turn: TurnEnvelopePoint[],
  config: EnvelopeConfig,
): AltitudeEnvelopeSummary {
  const levelAtAltitude = level.filter((point) => point.altitudeM === altitudeM);
  const turnAtAltitude = turn.filter((point) => point.altitudeM === altitudeM);
  const topLevel = last(levelAtAltitude.filter((point) => point.levelFlight));
  const bestClimb = maxBy(
    levelAtAltitude.filter((point) => point.specificExcessPowerMps !== null),
    (point) => point.specificExcessPowerMps ?? -Infinity,
  );
  const instTurns = turnAtAltitude
    .map((point) => turnMetric(point, "instantaneous"))
    .filter((point): point is TurnMetric => point !== null);
  const sustainedTurns = turnAtAltitude
    .map((point) => turnMetric(point, "sustained"))
    .filter((point): point is TurnMetric => point !== null);

  return {
    altitudeM,
    stallSpeedMps: finiteOrNull(stallSpeedAtAltitudeMps(model, altitudeM, config.maxLiftCoefficient)),
    topLevelSpeedMps: topLevel?.speedMps ?? null,
    bestClimbRateMps: bestClimb?.specificExcessPowerMps ?? null,
    bestClimbSpeedMps: bestClimb?.speedMps ?? null,
    bestSpecificExcessPowerMps: bestClimb?.specificExcessPowerMps ?? null,
    cornerSpeedMps: finiteOrNull(stallSpeedAtAltitudeMps(model, altitudeM, config.maxLiftCoefficient, config.structuralLoadLimitG)),
    bestInstantaneousTurn: maxBy(instTurns, (point) => point.turnRateDps) ?? null,
    bestSustainedTurn: maxBy(sustainedTurns, (point) => point.turnRateDps) ?? null,
    minimumInstantaneousRadius: minBy(instTurns, (point) => point.turnRadiusM) ?? null,
    minimumSustainedRadius: minBy(sustainedTurns, (point) => point.turnRadiusM) ?? null,
  };
}

function estimateAccelerationSegment(
  model: AircraftModel,
  segment: AccelerationSegmentSpec,
  config: EnvelopeConfig,
): AccelerationSegmentResult {
  if (segment.toMps <= segment.fromMps) {
    return { ...segment, timeS: 0, limitingReason: "ok" };
  }
  const stallMps = stallSpeedAtAltitudeMps(model, segment.altitudeM, config.maxLiftCoefficient);
  if (segment.fromMps < stallMps) {
    return { ...segment, timeS: null, limitingReason: "below-stall" };
  }

  const densityKgM3 = densityAtAltitude(segment.altitudeM);
  let speedMps = segment.fromMps;
  let timeS = 0;
  const stepMps = Math.max(0.5, Math.min(2, config.speedGrid.stepMps));
  while (speedMps < segment.toMps - 1e-6) {
    const dragN = requiredDragN(model, speedMps, densityKgM3, 1, { ...config, altitudeM: segment.altitudeM });
    const thrustN = availableThrustN(model, speedMps, densityKgM3, 1, segment.altitudeM);
    const accelerationMps2 = Number.isFinite(dragN) ? (thrustN - dragN) / Math.max(model.massKg, 1) : -Infinity;
    if (accelerationMps2 <= 0 || !Number.isFinite(accelerationMps2)) {
      return { ...segment, timeS: null, limitingReason: "insufficient-excess-thrust" };
    }
    const dv = Math.min(stepMps, segment.toMps - speedMps);
    timeS += dv / accelerationMps2;
    speedMps += dv;
  }

  return { ...segment, timeS, limitingReason: "ok" };
}

function solveSustainedLoadG(
  model: AircraftModel,
  speedMps: number,
  altitudeM: number,
  densityKgM3: number,
  thrustN: number,
  maxLoadG: number,
  config: EnvelopeConfig,
): number {
  let lo = 1;
  let hi = Math.max(1, maxLoadG);
  for (let i = 0; i < 28; i += 1) {
    const mid = (lo + hi) / 2;
    const dragN = requiredDragN(model, speedMps, densityKgM3, mid, { ...config, altitudeM });
    if (Number.isFinite(dragN) && thrustN >= dragN) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return lo;
}

function turnAtLoad(speedMps: number, loadG: number): { turnRateDps: number; turnRadiusM: number } | null {
  if (loadG <= 1 || speedMps <= 0) return null;
  const radialFactor = Math.sqrt(loadG * loadG - 1);
  const turnRateRadS = (GRAVITY_MPS2 * radialFactor) / speedMps;
  return {
    turnRateDps: turnRateRadS * (180 / Math.PI),
    turnRadiusM: (speedMps * speedMps) / (GRAVITY_MPS2 * radialFactor),
  };
}

function turnMetric(point: TurnEnvelopePoint, mode: "instantaneous" | "sustained"): TurnMetric | null {
  const loadG = mode === "instantaneous" ? point.instantaneousLoadG : point.sustainedLoadG;
  const turnRateDps = mode === "instantaneous" ? point.instantaneousTurnRateDps : point.sustainedTurnRateDps;
  const turnRadiusM = mode === "instantaneous" ? point.instantaneousTurnRadiusM : point.sustainedTurnRadiusM;
  if (loadG === null || turnRateDps === null || turnRadiusM === null || turnRateDps <= 0) return null;
  return {
    altitudeM: point.altitudeM,
    speedMps: point.speedMps,
    loadG,
    turnRateDps,
    turnRadiusM,
  };
}

function ceilingFromSummaries(summaries: AltitudeEnvelopeSummary[], climbThresholdMps: number): number | null {
  const sorted = [...summaries].sort((a, b) => a.altitudeM - b.altitudeM);
  let previous: AltitudeEnvelopeSummary | undefined;
  for (const current of sorted) {
    const climb = current.bestClimbRateMps ?? -Infinity;
    if (climb < climbThresholdMps) {
      if (!previous) return current.altitudeM;
      const prevClimb = previous.bestClimbRateMps ?? -Infinity;
      if (!Number.isFinite(prevClimb) || prevClimb === climb) return current.altitudeM;
      const t = (climbThresholdMps - prevClimb) / (climb - prevClimb);
      return previous.altitudeM + t * (current.altitudeM - previous.altitudeM);
    }
    previous = current;
  }
  return null;
}

function mergeConfig(config: Partial<EnvelopeConfig> | undefined): EnvelopeConfig {
  return {
    ...DEFAULT_ENVELOPE_CONFIG,
    ...(config ?? {}),
    speedGrid: { ...DEFAULT_ENVELOPE_CONFIG.speedGrid, ...(config?.speedGrid ?? {}) },
    altitudeM: config?.altitudeM ?? DEFAULT_ENVELOPE_CONFIG.altitudeM,
    accelerationSegments: config?.accelerationSegments ?? DEFAULT_ENVELOPE_CONFIG.accelerationSegments,
  };
}

function effectiveWingAreaM2(model: AircraftModel, speedMps: number, altitudeM: number): number {
  const sweep = modelSweepState(model, speedMps, altitudeM);
  if (!sweep) return Math.max(model.wingAreaM2, 1);
  const areaLoss = sweep.affectedAreaFraction * sweep.t * 0.08;
  return Math.max(1, model.wingAreaM2 * (1 - areaLoss));
}

function altitudeMFromDensity(densityKgM3: number): number {
  const ratio = Math.max(densityKgM3, 0.01) / SEA_LEVEL_DENSITY_KG_M3;
  return Math.max(0, -8_800 * Math.log(ratio));
}

function range(min: number, max: number, step: number): number[] {
  const out: number[] = [];
  const safeStep = Math.max(step, 0.1);
  for (let value = min; value <= max + safeStep * 0.5; value += safeStep) {
    out.push(Number(value.toFixed(6)));
  }
  return out;
}

function finiteOrNull(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

function maxBy<T>(items: T[], score: (item: T) => number): T | undefined {
  let best: T | undefined;
  let bestScore = -Infinity;
  for (const item of items) {
    const value = score(item);
    if (value > bestScore) {
      best = item;
      bestScore = value;
    }
  }
  return best;
}

function minBy<T>(items: T[], score: (item: T) => number): T | undefined {
  let best: T | undefined;
  let bestScore = Infinity;
  for (const item of items) {
    const value = score(item);
    if (value < bestScore) {
      best = item;
      bestScore = value;
    }
  }
  return best;
}

function last<T>(items: T[]): T | undefined {
  return items[items.length - 1];
}
