import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { aircraftArchetypes } from "../sim/aircraftCatalog";
import { compileAirframe } from "../sim/airframe";
import { densityAtAltitude } from "../sim/aero";
import {
  DEFAULT_ENVELOPE_CL_MAX,
  aircraftEnvelopeScalars,
  availableThrustN,
  requiredDragN,
  stallSpeedAtAltitudeMps,
} from "../sim/performanceEnvelope";
import type { AircraftModel } from "../sim/types";

const argv = process.argv.slice(2);
const outIdx = argv.indexOf("--out");
const out = outIdx >= 0 ? argv[outIdx + 1] : "reports/prop-performance-audit.md";

const G = 9.81;
const MPH_PER_MPS = 2.2369362921;
const FPM_PER_MPS = 196.8503937;

interface Benchmark {
  reference: string;
  topSpeedMph: number;
  stallMph?: number;
  climbFpm?: number;
  source: string;
}

interface AuditRow {
  id: string;
  name: string;
  role: string;
  reference: string;
  massKg: number;
  wingAreaM2: number;
  powerHp: number;
  criticalAltitudeM: number;
  thrustToWeight: number;
  wingLoadingNM2: number;
  parasiteDragAreaM2: number;
  stallMph: number;
  topSpeedMph: number;
  topSpeedAltitudeM: number;
  bestClimbFpm: number;
  bestClimbSpeedMph: number;
  referenceTopMph: number;
  topSpeedRatio: number;
  referenceStallMph?: number;
  stallRatio?: number;
  referenceClimbFpm?: number;
  climbRatio?: number;
  verdict: string;
  source: string;
}

// These are not new gameplay constants; they are rough external checks for the archetype families.
// Sources are intentionally visible in the generated report so the numbers can be argued with later.
const benchmarks: Record<string, Benchmark> = {
  "inline-escort": {
    reference: "P-51D Mustang",
    topSpeedMph: 437,
    stallMph: 100,
    climbFpm: 3200,
    source:
      "Palm Springs Air Museum (https://palmspringsairmuseum.org/p-51-mustang/) / AOPA P-51D spec sheet (https://www.aopa.org/news-and-media/all-news/2007/august/01/north-american-aviation-p-51d-mustang)",
  },
  "clipped-interceptor": {
    reference: "late Merlin Spitfire / Yak-3 family",
    topSpeedMph: 405,
    climbFpm: 3600,
    source:
      "American Heritage Museum Spitfire Mk IX notes (https://www.americanheritagemuseum.org/aircrafts/supermarine-spitfire-mk-ix/) / Military Aviation Museum Yak-3M specs (https://www.militaryaviationmuseum.org/aircraft/yakovlev-yak-3m/)",
  },
  "radial-deck-fighter": {
    reference: "F4U-4 Corsair",
    topSpeedMph: 446,
    climbFpm: 4500,
    source:
      "USS Midway Museum F4U specs (https://www.midway.org/visit/aircraft-gallery/f4u-corsair) / National Museum of World War II Aviation F4U notes (https://www.worldwariiaviation.org/aircraft/chance-vought-f4u-corsair)",
  },
  "light-turn-fighter": {
    reference: "A6M2 Zero / Yak-3 light fighter family",
    topSpeedMph: 329,
    stallMph: 69,
    climbFpm: 3600,
    source:
      "Pearl Harbor Aviation Museum Zero speed note (https://www.pearlharboraviationmuseum.org/news/blog-archives/how-fast-was-the-zero/) / Military Aviation Museum Yak-3M specs (https://www.militaryaviationmuseum.org/aircraft/yakovlev-yak-3m/)",
  },
  "twin-boom-pursuit": {
    reference: "P-38L Lightning",
    topSpeedMph: 414,
    climbFpm: 4000,
    source:
      "National Museum of the USAF P-38L specs (https://www.nationalmuseum.af.mil/Visit/Museum-Exhibits/Fact-Sheets/Display/Article/196280/lockheed-p-38l-lightning/) / Museum of Flight P-38L specs (https://www.museumofflight.org/exhibits-and-events/aircraft/lockheed-p-38l-lightning)",
  },
  "fast-wooden-twin": {
    reference: "DH.98 Mosquito",
    topSpeedMph: 415,
    climbFpm: 2800,
    source:
      "National Museum of the USAF Mosquito fact sheet (https://www.nationalmuseum.af.mil/Visit/Museum-Exhibits/Fact-Sheets/Display/Article/196281/de-havilland-dh-98-mosquito/)",
  },
  "late-attack-brute": {
    reference: "A-1H Skyraider",
    topSpeedMph: 322,
    climbFpm: 2850,
    source:
      "Tennessee Museum of Aviation A-1H specs (https://www.tnairmuseum.com/aircraft/douglas-a-1h-skyraider-lieutenant-america/) / National Naval Aviation Museum A-1H notes (https://navalaviationmuseum.org/a-1h-skyraider/)",
  },
  "trainer-mule": {
    reference: "T-6G Texan",
    topSpeedMph: 210,
    climbFpm: 1200,
    source:
      "Museum of Aviation Foundation T-6G specs (https://museumofaviation.org/portfolio/t-6g/) / Warhawk Air Museum T-6G specs (https://warhawkairmuseum.org/explore/aviation-collection/t-6g/)",
  },
};

function stallSpeedMps(model: AircraftModel): number {
  return stallSpeedAtAltitudeMps(model, 0, DEFAULT_ENVELOPE_CL_MAX);
}

function estimatePerformance(model: AircraftModel) {
  const stallMps = stallSpeedMps(model);
  let topSpeedMps = 0;
  let topSpeedAltitudeM = 0;

  for (const altitudeM of [0, 1_000, 2_000, 4_000, 6_000, 8_000]) {
    const densityKgM3 = densityAtAltitude(altitudeM);
    for (let speedMps = Math.max(20, Math.floor(stallMps)); speedMps <= 280; speedMps += 1) {
      if (availableThrustN(model, speedMps, densityKgM3) >= requiredDragN(model, speedMps, densityKgM3)) {
        if (speedMps > topSpeedMps) {
          topSpeedMps = speedMps;
          topSpeedAltitudeM = altitudeM;
        }
      }
    }
  }

  let bestClimbMps = -Infinity;
  let bestClimbSpeedMps = 0;
  const seaLevelDensity = densityAtAltitude(0);
  for (let speedMps = Math.max(20, Math.floor(stallMps * 1.1)); speedMps <= 240; speedMps += 1) {
    const excessThrustN =
      availableThrustN(model, speedMps, seaLevelDensity) - requiredDragN(model, speedMps, seaLevelDensity);
    const climbMps = (excessThrustN * speedMps) / (model.massKg * G);
    if (climbMps > bestClimbMps) {
      bestClimbMps = climbMps;
      bestClimbSpeedMps = speedMps;
    }
  }

  return {
    stallMph: stallMps * MPH_PER_MPS,
    topSpeedMph: topSpeedMps * MPH_PER_MPS,
    topSpeedAltitudeM,
    bestClimbFpm: Math.max(0, bestClimbMps) * FPM_PER_MPS,
    bestClimbSpeedMph: bestClimbSpeedMps * MPH_PER_MPS,
  };
}

function verdict(topSpeedRatio: number, climbRatio?: number): string {
  if (topSpeedRatio < 0.78) return "too slow";
  if (topSpeedRatio > 1.12) return "too fast";
  if (climbRatio !== undefined && climbRatio > 1.5) return "climbs hot";
  if (climbRatio !== undefined && climbRatio < 0.55) return "climbs weak";
  return "plausible";
}

function rowForArchetype(archetype: (typeof aircraftArchetypes)[number]): AuditRow {
  const model = compileAirframe(archetype.airframe).model;
  const perf = estimatePerformance(model);
  const benchmark = benchmarks[archetype.id];
  if (!benchmark) throw new Error(`missing benchmark for ${archetype.id}`);

  const powerHp = model.propulsions.reduce((sum, point) => sum + point.maxPowerW / 745.7, 0);
  const criticalAltitudeM = aircraftEnvelopeScalars(model).criticalAltitudeM;
  const topSpeedRatio = perf.topSpeedMph / benchmark.topSpeedMph;
  const stallRatio = benchmark.stallMph ? perf.stallMph / benchmark.stallMph : undefined;
  const climbRatio = benchmark.climbFpm ? perf.bestClimbFpm / benchmark.climbFpm : undefined;
  return {
    id: archetype.id,
    name: archetype.name,
    role: archetype.role,
    reference: benchmark.reference,
    massKg: model.massKg,
    wingAreaM2: model.wingAreaM2,
    powerHp,
    criticalAltitudeM,
    thrustToWeight: model.maxThrustN / (model.massKg * G),
    wingLoadingNM2: (model.massKg * G) / Math.max(model.wingAreaM2, 1),
    parasiteDragAreaM2: model.parasiteDragAreaM2,
    ...perf,
    referenceTopMph: benchmark.topSpeedMph,
    topSpeedRatio,
    referenceStallMph: benchmark.stallMph,
    stallRatio,
    referenceClimbFpm: benchmark.climbFpm,
    climbRatio,
    verdict: verdict(topSpeedRatio, climbRatio),
    source: benchmark.source,
  };
}

function formatNumber(value: number, digits = 0): string {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function formatRatio(value: number | undefined): string {
  return value === undefined ? "" : `${formatNumber(value * 100, 0)}%`;
}

function markdown(rows: AuditRow[]): string {
  const lines: string[] = [
    "# Prop Performance Audit",
    "",
    "This is a headless, point-mass estimate from the compiled airframes. It uses the same propeller sampler and approximate aerodynamic constants as the sim, then compares each archetype to a rough historical-family benchmark.",
    "",
    "| Archetype | Reference family | Sim max mph | Ref max mph | Speed | Stall mph | Ref stall | Stall | Climb fpm | Ref climb | Climb | Verdict |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
  ];
  for (const row of rows) {
    lines.push(
      `| ${row.name} | ${row.reference} | ${formatNumber(row.topSpeedMph)} @ ${formatNumber(row.topSpeedAltitudeM)} m | ${formatNumber(row.referenceTopMph)} | ${formatRatio(row.topSpeedRatio)} | ${formatNumber(row.stallMph)} | ${row.referenceStallMph ? formatNumber(row.referenceStallMph) : ""} | ${formatRatio(row.stallRatio)} | ${formatNumber(row.bestClimbFpm)} | ${row.referenceClimbFpm ? formatNumber(row.referenceClimbFpm) : ""} | ${formatRatio(row.climbRatio)} | ${row.verdict} |`,
    );
  }

  lines.push(
    "",
    "## Sim Scalars",
    "",
    "| Archetype | Mass kg | Power hp | Critical altitude m | Wing area m2 | Wing loading N/m2 | T/W | Parasite area m2 | Best climb speed mph |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  );
  for (const row of rows) {
    lines.push(
      `| ${row.name} | ${formatNumber(row.massKg)} | ${formatNumber(row.powerHp)} | ${formatNumber(row.criticalAltitudeM)} | ${formatNumber(row.wingAreaM2, 1)} | ${formatNumber(row.wingLoadingNM2)} | ${formatNumber(row.thrustToWeight, 2)} | ${formatNumber(row.parasiteDragAreaM2, 2)} | ${formatNumber(row.bestClimbSpeedMph)} |`,
    );
  }

  lines.push("", "## Benchmark Sources", "");
  for (const row of rows) {
    lines.push(`- ${row.reference}: ${row.source}.`);
  }

  lines.push(
    "",
    "## Reading",
    "",
    "- `too slow` here means the estimated max level speed is below 78% of the reference-family top speed.",
    "- `too fast` means above 112%; `climbs hot` means above 150% of the reference climb rate; `climbs weak` means below 55%.",
    "- These are ballpark checks, not flight-manual reproduction: the sim now models constant-speed pitch scheduling and a single critical-altitude power hold, but not supercharger gear changes, compressibility, detailed prop efficiency maps, or thermal limits.",
  );
  return `${lines.join("\n")}\n`;
}

function main(): void {
  const rows = aircraftArchetypes
    .filter((archetype) => benchmarks[archetype.id])
    .map(rowForArchetype);
  const report = markdown(rows);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, report);

  console.log(report);
  console.error(`prop performance audit -> ${out}`);
}

main();
