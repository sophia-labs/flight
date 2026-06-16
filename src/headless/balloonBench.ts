// balloonBench — the FIRST benchmark of the embodied-Body flight system: which cheap LLM Body flies the
// balloon intercept best.
//
// For each slate model we run K balloon MATCHES headlessly (no video — the film renderer is skipped for
// speed/cost), varying ONLY the Body model slug. Same balloon scenario (createBalloonScenarioAircraft),
// same scripted anti-dive coaching Pilot (bodyPilotController) for everyone — the Body model is the only
// independent variable. Each run is scored by balloonMetrics (src/eval/balloonMetrics.ts), then
// aggregated per model into a leaderboard (killRate, time-on-balloon, latency, parse-rate, $/run).
//
//   npm run bench:balloon                  # the default slate, K=2
//   BENCH_K=1 BENCH_MODELS=deepseek-v4-flash,openai/gpt-4o-mini npm run bench:balloon
//
// env:
//   BENCH_K            matches per model (default 2)
//   BENCH_TURNS        max turns per match (default 8 — the kill happens ~turn 5)
//   BENCH_MODELS       comma list of Body model slugs to override the built-in slate
//   BODY_TIMEOUT_MS    per-tick Body model timeout (default 20000 — a too-slow model yields fallback
//                      ticks instead of hanging; slow SHOULD score worse, captured via parseRate+latency)
//   BENCH_OUT_DIR      output dir for the leaderboard json+md (default bench/)
//   BENCH_REPLAY_DIR   if set, every run's replay json is written there (used to film the winner)

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bodyPilotController } from "../agent/controllers/bodyPilot";
import { pursuitFallback } from "../agent/controllers/scripted";
import { perfectSensor } from "../agent/observation";
import { competenceEvaluator } from "../eval/outcome";
import {
  BALLOON_CONE_HALF_ANGLE_RAD,
  BALLOON_HIT_RADIUS_M,
  BALLOON_MAX_GUN_RANGE_M,
  balloonMetrics,
  type BalloonMetrics,
} from "../eval/balloonMetrics";
import type { MatchReplay } from "../protocol/schema";
import type { MatchConfig } from "../runtime/config";
import { runMatch } from "../runtime/match";
import {
  FRAME_DT,
  TURN_DURATION,
  createBalloonScenarioAircraft,
  staticController,
} from "../runtime/scenario";
import { createHeadlessBodyConfig } from "./bodyConfig";

// The cheap, cost-equivalent slate. All within ~an order of magnitude of the deepseek-v4-flash baseline
// ($0.14/$0.28 per 1M in/out), spanning providers, plus ONE premium reference (claude-3.5-haiku) to ask
// whether more $ buys piloting skill. Each slug is verified to resolve in pi-ai before it runs.
// (x-ai/grok-4-fast and a small Mistral 2501 did NOT resolve in the registry and were dropped.)
const DEFAULT_SLATE = [
  "deepseek-v4-flash", // direct first-party DeepSeek — the baseline ($0.14/$0.28)
  "google/gemini-2.5-flash-lite", // Gemini flash ($0.10/$0.40)
  "openai/gpt-4o-mini", // OpenAI mini ($0.15/$0.60)
  "meta-llama/llama-3.3-70b-instruct", // Llama ($0.10/$0.32)
  "mistralai/mistral-small-3.2-24b-instruct", // Mistral small ($0.075/$0.20)
  "qwen/qwen3-30b-a3b", // Qwen ($0.12/$0.50)
  "anthropic/claude-3.5-haiku", // premium reference ($0.80/$4.00)
];

const K = Number(process.env.BENCH_K ?? 2);
const TURNS = Number(process.env.BENCH_TURNS ?? 8);
const BODY_TIMEOUT_MS = Number(process.env.BODY_TIMEOUT_MS ?? 20_000);
const OUT_DIR = process.env.BENCH_OUT_DIR ?? "bench";
const REPLAY_DIR = process.env.BENCH_REPLAY_DIR;
const SLATE = (process.env.BENCH_MODELS ?? DEFAULT_SLATE.join(","))
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Build a headless balloon match config whose Body is the given model slug. This mirrors film.ts's
// FILM_SCENARIO=balloon + FILM_MODE=pilot-intent path exactly: scripted coaching Pilot (bodyPilot) on
// blue-1 with a live Body model, a static no-op balloon on red. No camera devices/rendering needed.
function buildBalloonBenchConfig(modelSlug: string, runIndex: number): MatchConfig {
  const body = createHeadlessBodyConfig({ modelSlug, timeoutMs: BODY_TIMEOUT_MS });
  return {
    id: `balloon-bench|body:${modelSlug}|run:${runIndex}`,
    turnDuration: TURN_DURATION,
    frameDt: FRAME_DT,
    maxTurns: TURNS,
    decisionTimeoutMs: 30_000, // the Pilot is scripted+instant; the Body's own per-tick timeout gates it
    initialAircraft: createBalloonScenarioAircraft(),
    sensor: perfectSensor,
    evaluator: competenceEvaluator,
    fallback: pursuitFallback,
    agents: {
      "blue-1": {
        meta: {
          id: "blue-1",
          kind: "llm",
          label: `coached-pilot/body:${modelSlug}`,
          config: { bodyId: body.manifest.bodyId, bodyModel: modelSlug },
        },
        controller: bodyPilotController(0.82),
        body,
      },
      balloon: {
        meta: { id: "balloon", kind: "scripted", label: "balloon (static)" },
        controller: staticController,
      },
    },
  };
}

export interface RunResult {
  model: string;
  run: number;
  metrics: BalloonMetrics;
  bodyTicks: number;
  fallbackTicks: number; // ticks that fell back (failed parse / model error)
  winnerTeam: string | null;
  wallMs: number;
  error?: string;
}

export interface ModelAggregate {
  model: string;
  runs: number;
  kills: number;
  killRate: number;
  meanTimeOnBalloonSec: number;
  maxTimeOnBalloonSec: number;
  meanTimeToKillSec: number | null;
  meanPeakOnNose: number;
  meanClosestRangeM: number;
  totalShots: number;
  totalHits: number;
  meanLatencyMs: number;
  meanParseRate: number;
  costPerRunUsd: number;
  totalCostUsd: number;
  errors: number;
}

async function runOne(model: string, run: number): Promise<RunResult> {
  const started = Date.now();
  try {
    const replay = await runMatch(buildBalloonBenchConfig(model, run));
    if (REPLAY_DIR) {
      mkdirSync(REPLAY_DIR, { recursive: true });
      const safe = model.replace(/[^\w.-]+/g, "_");
      writeFileSync(join(REPLAY_DIR, `${safe}-run${run}.json`), JSON.stringify(replay));
    }
    const metrics = balloonMetrics(replay);
    const ticks = (replay.bodyTicks ?? []).filter((t) => t.agentId === "blue-1");
    const fallbackTicks = ticks.filter((t) => t.parsed.status === "failed").length;
    return {
      model,
      run,
      metrics,
      bodyTicks: ticks.length,
      fallbackTicks,
      winnerTeam: replay.outcome?.winnerTeam ?? null,
      wallMs: Date.now() - started,
    };
  } catch (err) {
    return {
      model,
      run,
      metrics: emptyMetrics(),
      bodyTicks: 0,
      fallbackTicks: 0,
      winnerTeam: null,
      wallMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function emptyMetrics(): BalloonMetrics {
  return {
    timeOnBalloonSec: 0,
    killed: false,
    timeToKillSec: null,
    timeToFirstSolutionSec: null,
    timeOnBalloonBeforeKillSec: 0,
    peakOnNose: 0,
    closestRangeM: Infinity,
    shots: 0,
    hits: 0,
    parseRate: 0,
    meanLatencyMs: 0,
    costUsd: 0,
  };
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function aggregate(model: string, runs: RunResult[]): ModelAggregate {
  const ok = runs.filter((r) => !r.error);
  const kills = ok.filter((r) => r.metrics.killed).length;
  const killTimes = ok
    .map((r) => r.metrics.timeToKillSec)
    .filter((x): x is number => typeof x === "number");
  const totalCost = runs.reduce((s, r) => s + r.metrics.costUsd, 0);
  return {
    model,
    runs: runs.length,
    kills,
    killRate: runs.length ? kills / runs.length : 0,
    meanTimeOnBalloonSec: mean(ok.map((r) => r.metrics.timeOnBalloonSec)),
    maxTimeOnBalloonSec: ok.length ? Math.max(...ok.map((r) => r.metrics.timeOnBalloonSec)) : 0,
    meanTimeToKillSec: killTimes.length ? mean(killTimes) : null,
    meanPeakOnNose: mean(ok.map((r) => r.metrics.peakOnNose)),
    meanClosestRangeM: mean(ok.map((r) => r.metrics.closestRangeM).filter(Number.isFinite)),
    totalShots: runs.reduce((s, r) => s + r.metrics.shots, 0),
    totalHits: runs.reduce((s, r) => s + r.metrics.hits, 0),
    meanLatencyMs: mean(ok.map((r) => r.metrics.meanLatencyMs).filter((x) => x > 0)),
    meanParseRate: mean(ok.map((r) => r.metrics.parseRate)),
    costPerRunUsd: runs.length ? totalCost / runs.length : 0,
    totalCostUsd: totalCost,
    errors: runs.filter((r) => r.error).length,
  };
}

// Leaderboard order: killRate desc, then mean time-on-balloon desc (the tie-break the brief asks for).
function rank(a: ModelAggregate, b: ModelAggregate): number {
  if (b.killRate !== a.killRate) return b.killRate - a.killRate;
  return b.meanTimeOnBalloonSec - a.meanTimeOnBalloonSec;
}

function fmt(n: number, d = 2): string {
  return Number.isFinite(n) ? n.toFixed(d) : "-";
}

function leaderboardMarkdown(board: ModelAggregate[], meta: BenchMeta): string {
  const lines: string[] = [];
  lines.push(`# Balloon-intercept benchmark — embodied Body leaderboard`);
  lines.push("");
  lines.push(
    `Same balloon scenario + same scripted anti-dive coaching Pilot for all; the Body model is the only variable.`,
  );
  lines.push(
    `K=${meta.k} matches/model, ${meta.turns} turns max, BODY_TIMEOUT=${meta.timeoutMs}ms. ` +
      `On-solution = a REAL bullet fired that frame would intercept the balloon — the gun axis passes ` +
      `within the balloon's ${meta.hitRadiusM} m hit radius (≈ within atan(${meta.hitRadiusM}/range) of ` +
      `dead-on) AND range ≤ ${meta.maxGunRangeM} m. This mirrors the v0.9.x projectile hit test in ` +
      `resolveWeapons/stepProjectiles — far tighter than the old 0.42 rad (~24°) hitscan cone.`,
  );
  lines.push("");
  lines.push(`| # | model | kills/K | mean t-on-balloon (s) | mean latency (s) | parse-rate | $/run |`);
  lines.push(`|---|-------|---------|-----------------------|------------------|------------|-------|`);
  board.forEach((m, i) => {
    lines.push(
      `| ${i + 1} | \`${m.model}\` | ${m.kills}/${meta.k} | ${fmt(m.meanTimeOnBalloonSec)} | ` +
        `${fmt(m.meanLatencyMs / 1000)} | ${fmt(m.meanParseRate, 2)} | $${fmt(m.costPerRunUsd, 4)} |`,
    );
  });
  lines.push("");
  lines.push(`Total benchmark cost: $${fmt(meta.totalCostUsd, 4)}  ·  wall-clock: ${fmt(meta.wallSec, 1)}s`);
  lines.push("");
  lines.push(`## Per-model detail`);
  lines.push("");
  lines.push(
    `| model | runs | kills | maxTOB (s) | meanTTK (s) | peakOnNose | closest (m) | shots | hits | latency (s) | parse | $/run | errors |`,
  );
  lines.push(`|---|---|---|---|---|---|---|---|---|---|---|---|---|`);
  for (const m of board) {
    lines.push(
      `| \`${m.model}\` | ${m.runs} | ${m.kills} | ${fmt(m.maxTimeOnBalloonSec)} | ` +
        `${m.meanTimeToKillSec === null ? "-" : fmt(m.meanTimeToKillSec)} | ${fmt(m.meanPeakOnNose, 3)} | ` +
        `${fmt(m.meanClosestRangeM, 0)} | ${m.totalShots} | ${m.totalHits} | ${fmt(m.meanLatencyMs / 1000)} | ` +
        `${fmt(m.meanParseRate, 2)} | $${fmt(m.costPerRunUsd, 4)} | ${m.errors} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

interface BenchMeta {
  k: number;
  turns: number;
  timeoutMs: number;
  coneHalfAngleRad: number;
  hitRadiusM: number;
  maxGunRangeM: number;
  totalCostUsd: number;
  wallSec: number;
}

async function main(): Promise<void> {
  // Fail fast on any slug that doesn't resolve in pi-ai, BEFORE flying anything.
  const resolvable: string[] = [];
  for (const slug of SLATE) {
    try {
      createHeadlessBodyConfig({ modelSlug: slug, timeoutMs: BODY_TIMEOUT_MS });
      resolvable.push(slug);
    } catch (err) {
      console.error(`SKIP ${slug}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.error(
    `balloonBench: ${resolvable.length} models x K=${K} x ${TURNS} turns ` +
      `(timeout ${BODY_TIMEOUT_MS}ms) -> ${OUT_DIR}/`,
  );

  const benchStart = Date.now();
  const allRuns: RunResult[] = [];
  const board: ModelAggregate[] = [];

  for (const model of resolvable) {
    const runs: RunResult[] = [];
    for (let k = 0; k < K; k += 1) {
      console.error(`  [${model}] run ${k + 1}/${K} ...`);
      const result = await runOne(model, k);
      runs.push(result);
      allRuns.push(result);
      const m = result.metrics;
      console.error(
        `    ${result.error ? `ERROR ${result.error.slice(0, 80)}` : `kill=${m.killed} tob=${fmt(m.timeOnBalloonSec)}s ` +
          `ttk=${m.timeToKillSec === null ? "-" : fmt(m.timeToKillSec) + "s"} ` +
          `peak=${fmt(m.peakOnNose, 2)} closest=${fmt(m.closestRangeM, 0)}m shots=${m.shots} hits=${m.hits} ` +
          `parse=${fmt(m.parseRate, 2)} lat=${fmt(m.meanLatencyMs / 1000)}s $${fmt(m.costUsd, 4)}`} ` +
          `(${fmt(result.wallMs / 1000, 1)}s wall)`,
      );
    }
    board.push(aggregate(model, runs));
  }

  board.sort(rank);
  const totalCostUsd = allRuns.reduce((s, r) => s + r.metrics.costUsd, 0);
  const wallSec = (Date.now() - benchStart) / 1000;
  const meta: BenchMeta = {
    k: K,
    turns: TURNS,
    timeoutMs: BODY_TIMEOUT_MS,
    coneHalfAngleRad: BALLOON_CONE_HALF_ANGLE_RAD,
    hitRadiusM: BALLOON_HIT_RADIUS_M,
    maxGunRangeM: BALLOON_MAX_GUN_RANGE_M,
    totalCostUsd,
    wallSec,
  };

  mkdirSync(OUT_DIR, { recursive: true });
  const md = leaderboardMarkdown(board, meta);
  writeFileSync(join(OUT_DIR, "balloon-leaderboard.md"), md);
  writeFileSync(
    join(OUT_DIR, "balloon-leaderboard.json"),
    JSON.stringify({ meta, leaderboard: board, runs: allRuns }, null, 2),
  );

  console.error("");
  console.error(md);
  console.error(`\nwrote ${OUT_DIR}/balloon-leaderboard.{md,json}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
