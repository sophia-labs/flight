import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { aircraftArchetypes } from "../sim/aircraftCatalog";
import { compileAirframe } from "../sim/airframe";
import {
  DEFAULT_ENVELOPE_CONFIG,
  ENVELOPE_MODEL_VERSION,
  buildPerformanceEnvelope,
  type AircraftPerformanceEnvelope,
  type AltitudeEnvelopeSummary,
  type TurnMetric,
} from "../sim/performanceEnvelope";

const MPH_PER_MPS = 2.2369362921;
const FPM_PER_MPS = 196.8503937;

interface HistoricalEnvelopeTarget {
  topSpeedMph: number;
  climbFpm: number;
  serviceCeilingM: number;
}

const historicalTargets: Record<string, HistoricalEnvelopeTarget> = {
  "variable-sweep-tomcat": { topSpeedMph: 1_544, climbFpm: 45_000, serviceCeilingM: 15_200 },
  "inline-escort": { topSpeedMph: 437, climbFpm: 3_200, serviceCeilingM: 12_770 },
  "clipped-interceptor": { topSpeedMph: 405, climbFpm: 3_600, serviceCeilingM: 12_950 },
  "radial-deck-fighter": { topSpeedMph: 446, climbFpm: 4_500, serviceCeilingM: 12_650 },
  "light-turn-fighter": { topSpeedMph: 329, climbFpm: 3_600, serviceCeilingM: 10_000 },
  "twin-boom-pursuit": { topSpeedMph: 414, climbFpm: 4_000, serviceCeilingM: 12_200 },
  "fast-wooden-twin": { topSpeedMph: 415, climbFpm: 2_800, serviceCeilingM: 12_800 },
  "late-attack-brute": { topSpeedMph: 322, climbFpm: 2_850, serviceCeilingM: 8_690 },
  "trainer-mule": { topSpeedMph: 210, climbFpm: 1_200, serviceCeilingM: 7_070 },
};

const argv = process.argv.slice(2);
const jsonOut = flagValue("--json") ?? "reports/flight-envelopes.json";
const mdOut = flagValue("--md") ?? "reports/flight-envelopes.md";
const speedStepMps = numberFlag("--speed-step") ?? DEFAULT_ENVELOPE_CONFIG.speedGrid.stepMps;
const maxSpeedMps = numberFlag("--max-speed") ?? DEFAULT_ENVELOPE_CONFIG.speedGrid.maxMps;

const config = {
  ...DEFAULT_ENVELOPE_CONFIG,
  speedGrid: {
    ...DEFAULT_ENVELOPE_CONFIG.speedGrid,
    stepMps: speedStepMps,
    maxMps: maxSpeedMps,
  },
};

interface EnvelopePayload {
  version: typeof ENVELOPE_MODEL_VERSION;
  config: typeof config;
  envelopes: AircraftPerformanceEnvelope[];
}

function main(): void {
  const envelopes = aircraftArchetypes.map((archetype) =>
    buildPerformanceEnvelope(compileAirframe(archetype.airframe).model, {
      aircraftId: archetype.id,
      aircraftName: archetype.name,
      role: archetype.role,
      config,
    }),
  );
  const payload: EnvelopePayload = {
    version: ENVELOPE_MODEL_VERSION,
    config,
    envelopes,
  };
  const report = markdown(envelopes);
  write(jsonOut, `${JSON.stringify(payload, null, 2)}\n`);
  write(mdOut, report);
  console.log(report);
  console.error(`flight envelope JSON -> ${jsonOut}`);
  console.error(`flight envelope report -> ${mdOut}`);
}

function markdown(envelopes: AircraftPerformanceEnvelope[]): string {
  const lines: string[] = [
    "# Flight Envelope Audit",
    "",
    "This is a deterministic point-mass envelope sweep over the compiled aircraft models. It uses the same propulsion samplers, clean drag scalars, induced-drag approximation, Mach drag-rise model, variable-sweep schedule, and lift limit as the sim.",
    "",
    "## Data Contract",
    "",
    "- `scalars`: mass, wing loading, prop power, jet thrust, thrust-to-weight, drag area, critical altitude, fuel, sweep/Mach limits, and control-authority descriptors.",
    "- `level[]`: altitude-speed samples with Mach, sweep, dynamic pressure, required lift coefficient, thrust, drag, excess thrust, specific excess power, climb rate, and level-flight feasibility.",
    "- `turn[]`: altitude-speed samples with Mach, sweep, instantaneous load/rate/radius and sustained load/rate/radius.",
    "- `summaries[]`: per-altitude stall speed, top level speed, best climb, corner speed, and best/minimum turn metrics.",
    "- `acceleration[]`: deterministic level-flight acceleration windows; unavailable windows report the limiting reason.",
    "",
    "## Aircraft Summary",
    "",
    "| Aircraft | Stall mph | Top mph | Best climb | Service ceiling | Inst turn | Sust turn | Corner mph | 60-100 m/s |",
    "| --- | ---: | ---: | ---: | ---: | --- | --- | ---: | ---: |",
  ];

  for (const envelope of envelopes) {
    const seaLevel = summaryAt(envelope, 0) ?? envelope.summaries[0];
    const top = bestTopSpeed(envelope);
    const climb = bestClimb(envelope);
    const inst = bestTurn(envelope, "instantaneous");
    const sust = bestTurn(envelope, "sustained");
    const accel = envelope.acceleration.find((segment) => segment.id === "60-100mps-sl");
    lines.push(
      `| ${envelope.aircraftName} | ${mph(seaLevel?.stallSpeedMps)} | ${top ? `${mph(top.topLevelSpeedMps)} @ ${formatNumber(top.altitudeM)} m` : "n/a"} | ${climb ? `${fpm(climb.bestClimbRateMps)} @ ${mph(climb.bestClimbSpeedMps)}` : "n/a"} | ${ceiling(envelope.serviceCeilingM, envelope)} | ${turnText(inst)} | ${turnText(sust)} | ${mph(seaLevel?.cornerSpeedMps)} | ${accelText(accel)} |`,
    );
  }

  lines.push(
    "",
    "## Historical Target Comparison",
    "",
    "| Aircraft | Top speed | Climb | Service ceiling |",
    "| --- | ---: | ---: | ---: |",
  );
  for (const envelope of envelopes) {
    const target = historicalTargets[envelope.aircraftId];
    const top = bestTopSpeed(envelope);
    const climb = bestClimb(envelope);
    lines.push(
      `| ${envelope.aircraftName} | ${targetText(mphNumber(top?.topLevelSpeedMps), target?.topSpeedMph, "mph")} | ${targetText(fpmNumber(climb?.bestClimbRateMps), target?.climbFpm, "fpm")} | ${ceilingTargetText(envelope, target?.serviceCeilingM)} |`,
    );
  }

  lines.push(
    "",
    "## Per-Altitude Summaries",
    "",
  );

  for (const envelope of envelopes) {
    lines.push(
      `### ${envelope.aircraftName}`,
      "",
      "| Alt m | Stall mph | Top mph | Best climb fpm | Inst turn | Sust turn | Corner mph |",
      "| ---: | ---: | ---: | ---: | --- | --- | ---: |",
    );
    for (const summary of envelope.summaries) {
      lines.push(
        `| ${formatNumber(summary.altitudeM)} | ${mph(summary.stallSpeedMps)} | ${mph(summary.topLevelSpeedMps)} | ${fpm(summary.bestClimbRateMps)} | ${turnText(summary.bestInstantaneousTurn)} | ${turnText(summary.bestSustainedTurn)} | ${mph(summary.cornerSpeedMps)} |`,
      );
    }
    lines.push("");
  }

  lines.push(
    "## Reading",
    "",
    "- Instantaneous turn is limited by lift and the configured structural load limit.",
    "- Sustained turn is the highest load factor that still has non-negative excess power at that speed and altitude.",
    "- Corner speed is the speed where the lift limit reaches the configured structural load limit; it may sit above practical level speed for some aircraft.",
    "- Service ceiling uses the conventional 100 ft/min climb threshold. A `>` ceiling means the aircraft still exceeds the threshold at the top of the configured altitude grid.",
    "- This now includes first-order compressibility, wave drag, afterburning jet thrust lapse, q/Mach limits, and automatic sweep effects, but not detailed inlet maps, trim drag, compressor-stall probability, structural damage, prop torque/P-factor, or thermal limits.",
  );

  return `${lines.join("\n")}\n`;
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

function turnText(metric: TurnMetric | null): string {
  if (!metric) return "n/a";
  return `${formatNumber(metric.turnRateDps, 1)} deg/s @ ${mph(metric.speedMps)}, R ${formatNumber(metric.turnRadiusM)} m`;
}

function accelText(segment: { timeS: number | null; limitingReason: string } | undefined): string {
  if (!segment) return "n/a";
  return segment.timeS === null ? segment.limitingReason : `${formatNumber(segment.timeS, 1)} s`;
}

function ceiling(valueM: number | null, envelope: AircraftPerformanceEnvelope): string {
  if (valueM !== null) return `${formatNumber(valueM)} m`;
  const maxAltitude = Math.max(...envelope.config.altitudeM);
  return `>${formatNumber(maxAltitude)} m`;
}

function mph(value: number | null | undefined): string {
  return value === null || value === undefined ? "n/a" : formatNumber(value * MPH_PER_MPS);
}

function fpm(value: number | null | undefined): string {
  return value === null || value === undefined ? "n/a" : formatNumber(Math.max(0, value) * FPM_PER_MPS);
}

function mphNumber(value: number | null | undefined): number | null {
  return value === null || value === undefined ? null : value * MPH_PER_MPS;
}

function fpmNumber(value: number | null | undefined): number | null {
  return value === null || value === undefined ? null : Math.max(0, value) * FPM_PER_MPS;
}

function targetText(actual: number | null | undefined, target: number | undefined, unit: string): string {
  if (actual === null || actual === undefined) return "n/a";
  if (target === undefined) return `${formatNumber(actual)} ${unit}`;
  const ratio = actual / target;
  const sign = actual >= target ? "+" : "";
  return `${formatNumber(actual)} / ${formatNumber(target)} ${unit} (${sign}${formatNumber((ratio - 1) * 100)}%)`;
}

function ceilingTargetText(envelope: AircraftPerformanceEnvelope, target: number | undefined): string {
  if (envelope.serviceCeilingM !== null) return targetText(envelope.serviceCeilingM, target, "m");
  const maxAltitude = Math.max(...envelope.config.altitudeM);
  if (target === undefined) return `>${formatNumber(maxAltitude)} m`;
  return `>${formatNumber(maxAltitude)} / ${formatNumber(target)} m (exceeds target)`;
}

function formatNumber(value: number, digits = 0): string {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function flagValue(name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function numberFlag(name: string): number | undefined {
  const raw = flagValue(name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a finite number`);
  return value;
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

main();
