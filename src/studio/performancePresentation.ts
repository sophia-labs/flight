import type {
  AircraftPerformanceEnvelope,
  AltitudeEnvelopeSummary,
  TurnMetric,
} from "../sim/performanceEnvelope";

const MPH_PER_MPS = 2.2369362921;
const FPM_PER_MPS = 196.8503937;

export interface PerformanceMetricCard {
  detail: string;
  label: string;
  value: string;
}

export interface PerformanceTrait {
  label: string;
  rating: number;
  tone: "cool" | "hot" | "steady" | "warn";
  value: string;
}

export interface PerformancePresentation {
  accelerationNote: string;
  cards: PerformanceMetricCard[];
  headline: string;
  operatingNote: string;
  traits: PerformanceTrait[];
}

export function performancePresentation(envelope: AircraftPerformanceEnvelope): PerformancePresentation {
  const seaLevel = summaryAt(envelope, 0) ?? envelope.summaries[0] ?? null;
  const top = bestTopSpeed(envelope);
  const climb = bestClimb(envelope);
  const instantaneous = bestTurn(envelope, "instantaneous");
  const sustained = bestTurn(envelope, "sustained");
  const lowSpeedAccel = envelope.acceleration.find((segment) => segment.id === "60-100mps-sl") ?? envelope.acceleration[0];

  const topMph = mphNumber(top?.topLevelSpeedMps);
  const climbFpm = fpmNumber(climb?.bestClimbRateMps);
  const sustainedTurnRate = sustained?.turnRateDps ?? null;
  const seaLevelStallMph = mphNumber(seaLevel?.stallSpeedMps);
  const serviceCeilingText = envelope.serviceCeilingM === null
    ? `>${formatInteger(Math.max(...envelope.config.altitudeM))} m`
    : `${formatInteger(envelope.serviceCeilingM)} m`;

  return {
    accelerationNote: accelerationText(lowSpeedAccel),
    cards: [
      {
        label: "top speed",
        value: topMph === null ? "n/a" : `${formatInteger(topMph)} mph`,
        detail: top ? `best at ${formatInteger(top.altitudeM)} m` : "no level-flight point",
      },
      {
        label: "best climb",
        value: climbFpm === null ? "n/a" : `${formatInteger(climbFpm)} fpm`,
        detail: climb?.bestClimbSpeedMps ? `at ${formatInteger(climb.bestClimbSpeedMps * MPH_PER_MPS)} mph` : "no positive climb",
      },
      {
        label: "service ceiling",
        value: serviceCeilingText,
        detail: "100 fpm threshold",
      },
      {
        label: "sustained turn",
        value: sustained ? `${formatDecimal(sustained.turnRateDps, 1)} deg/s` : "n/a",
        detail: sustained ? `${formatDecimal(sustained.loadG, 1)} g at ${formatInteger(sustained.speedMps * MPH_PER_MPS)} mph` : "power limited",
      },
    ],
    headline: headlineFor(envelope, topMph, climbFpm, sustainedTurnRate),
    operatingNote: operatingNote(envelope, seaLevel, instantaneous, sustained),
    traits: [
      {
        label: "speed",
        value: topMph === null ? "n/a" : speedLabel(topMph),
        rating: rating(topMph, 180, 1_500),
        tone: topMph !== null && topMph > 700 ? "hot" : "cool",
      },
      {
        label: "climb",
        value: climbFpm === null ? "n/a" : climbLabel(climbFpm),
        rating: rating(climbFpm, 900, 45_000),
        tone: climbFpm !== null && climbFpm > 12_000 ? "hot" : "steady",
      },
      {
        label: "turn",
        value: sustainedTurnRate === null ? "n/a" : turnLabel(sustainedTurnRate),
        rating: rating(sustainedTurnRate, 8, 30),
        tone: sustainedTurnRate !== null && sustainedTurnRate > 23 ? "hot" : "steady",
      },
      {
        label: "low speed",
        value: seaLevelStallMph === null ? "n/a" : stallLabel(seaLevelStallMph),
        rating: inverseRating(seaLevelStallMph, 70, 180),
        tone: seaLevelStallMph !== null && seaLevelStallMph > 125 ? "warn" : "cool",
      },
    ],
  };
}

function headlineFor(
  envelope: AircraftPerformanceEnvelope,
  topMph: number | null,
  climbFpm: number | null,
  sustainedTurnRate: number | null,
): string {
  if ((envelope.scalars.maxMach ?? 0) > 1.2 || (topMph ?? 0) > 700) return "High-speed energy fighter";
  if ((sustainedTurnRate ?? 0) > 23) return "Close-range turn fighter";
  if ((climbFpm ?? 0) > 3_400) return "Climb-and-pounce fighter";
  if ((topMph ?? 0) > 380) return "Fast escort profile";
  return "Trainer and utility envelope";
}

function operatingNote(
  envelope: AircraftPerformanceEnvelope,
  seaLevel: AltitudeEnvelopeSummary | null,
  instantaneous: TurnMetric | null,
  sustained: TurnMetric | null,
): string {
  const maxAltitude = Math.max(...envelope.config.altitudeM);
  const ceiling = envelope.serviceCeilingM ?? maxAltitude;
  const ceilingPhrase = envelope.serviceCeilingM === null ? `still climbing at ${formatInteger(maxAltitude)} m` : `ceiling near ${formatInteger(ceiling)} m`;
  const corner = seaLevel?.cornerSpeedMps ? `${formatInteger(seaLevel.cornerSpeedMps * MPH_PER_MPS)} mph corner` : "unknown corner";
  const turn = sustained ?? instantaneous;
  const turnPhrase = turn
    ? `${formatDecimal(turn.turnRateDps, 1)} deg/s turn around ${formatInteger(turn.speedMps * MPH_PER_MPS)} mph`
    : "no usable turn point";
  return `${corner}, ${turnPhrase}, ${ceilingPhrase}.`;
}

function accelerationText(segment: AircraftPerformanceEnvelope["acceleration"][number] | undefined): string {
  if (!segment) return "No acceleration window configured.";
  const from = formatInteger(segment.fromMps * MPH_PER_MPS);
  const to = formatInteger(segment.toMps * MPH_PER_MPS);
  const altitude = segment.altitudeM === 0 ? "sea level" : `${formatInteger(segment.altitudeM)} m`;
  if (segment.timeS !== null) return `${from}-${to} mph in ${formatDecimal(segment.timeS, 1)} s at ${altitude}.`;
  if (segment.limitingReason === "below-stall") return `${from}-${to} mph starts below stall at ${altitude}.`;
  return `${from}-${to} mph acceleration is power limited at ${altitude}.`;
}

function bestTopSpeed(envelope: AircraftPerformanceEnvelope): AltitudeEnvelopeSummary | null {
  return maxBy(
    envelope.summaries.filter((summary) => summary.topLevelSpeedMps !== null),
    (summary) => summary.topLevelSpeedMps ?? -Infinity,
  ) ?? null;
}

function bestClimb(envelope: AircraftPerformanceEnvelope): AltitudeEnvelopeSummary | null {
  return maxBy(
    envelope.summaries.filter((summary) => summary.bestClimbRateMps !== null),
    (summary) => summary.bestClimbRateMps ?? -Infinity,
  ) ?? null;
}

function bestTurn(
  envelope: AircraftPerformanceEnvelope,
  mode: "instantaneous" | "sustained",
): TurnMetric | null {
  const turns = envelope.summaries
    .map((summary) => mode === "instantaneous" ? summary.bestInstantaneousTurn : summary.bestSustainedTurn)
    .filter((metric): metric is TurnMetric => metric !== null);
  return maxBy(turns, (metric) => metric.turnRateDps) ?? null;
}

function summaryAt(envelope: AircraftPerformanceEnvelope, altitudeM: number): AltitudeEnvelopeSummary | undefined {
  return envelope.summaries.find((summary) => summary.altitudeM === altitudeM);
}

function speedLabel(mph: number): string {
  if (mph > 900) return "supersonic";
  if (mph > 420) return "fast";
  if (mph > 320) return "average";
  return "slow";
}

function climbLabel(fpm: number): string {
  if (fpm > 20_000) return "rocket";
  if (fpm > 3_400) return "strong";
  if (fpm > 2_000) return "steady";
  return "shallow";
}

function turnLabel(degS: number): string {
  if (degS > 24) return "knife fight";
  if (degS > 18) return "agile";
  if (degS > 12) return "wide";
  return "heavy";
}

function stallLabel(mph: number): string {
  if (mph < 82) return "forgiving";
  if (mph < 110) return "stable";
  if (mph < 145) return "fast landings";
  return "hot";
}

function mphNumber(value: number | null | undefined): number | null {
  return value === null || value === undefined ? null : value * MPH_PER_MPS;
}

function fpmNumber(value: number | null | undefined): number | null {
  return value === null || value === undefined ? null : Math.max(0, value) * FPM_PER_MPS;
}

function rating(value: number | null, min: number, max: number): number {
  if (value === null || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, (value - min) / Math.max(max - min, 1)));
}

function inverseRating(value: number | null, best: number, worst: number): number {
  if (value === null || !Number.isFinite(value)) return 0;
  return 1 - rating(value, best, worst);
}

function formatInteger(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

function formatDecimal(value: number, digits: number): string {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
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
