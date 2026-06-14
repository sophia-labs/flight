// Cross-model competence sweep. Runs (model × action-mode × repeats) matches against the scripted
// bot through a concurrency pool, streams per-match results to JSONL, and prints an aggregate
// competence-vs-cost table for the pilot seat.
//
//   tsx --env-file=.env src/headless/sweep.ts            # live cross-model sweep (needs OPENROUTER_API_KEY)
//   tsx src/headless/sweep.ts --scripted                 # free dev pass: validate the pipeline, no key
//
// Tunables via env: SWEEP_REPEATS, SWEEP_CONCURRENCY, SWEEP_TURNS.
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { actionSpecs, type ActionMode } from "../agent/actionSpec";
import { FLIGHT_RULES, piController, resolveOpenRouterModel } from "../agent/controllers/pi";
import { defensiveController, pursuitController, pursuitFallback } from "../agent/controllers/scripted";
import { perfectSensor } from "../agent/observation";
import { competenceEvaluator } from "../eval/outcome";
import type { Competence, MatchSummary } from "../protocol/schema";
import type { MatchConfig } from "../runtime/config";
import { runBatch, type BatchJob } from "../runtime/batch";
import { FRAME_DT, TURN_DURATION, createInitialAircraft } from "../runtime/scenario";

const SCRIPTED = process.argv.includes("--scripted");
const PILOT_ID = "blue-1";
const OUT = "sweep-results.jsonl";
const MATCHES_DIR = "public/matches"; // served by Vite for the in-browser match browser

function safeId(model: string, mode: string, repeat: number): string {
  return `${model.replace(/[^a-z0-9.]+/gi, "-")}__${mode}__${repeat}`;
}

const MODELS = SCRIPTED
  ? ["scripted-pursuit"]
  : [
      "anthropic/claude-haiku-4.5",
      "openai/gpt-4o-mini",
      "google/gemini-2.5-flash",
      "deepseek/deepseek-chat-v3.1",
    ];
const MODES: ActionMode[] = SCRIPTED ? ["flight-director"] : ["raw-stick", "setpoint", "flight-director"];
const REPEATS = Number(process.env.SWEEP_REPEATS ?? 3);
const CONCURRENCY = Number(process.env.SWEEP_CONCURRENCY ?? 12);
const MAX_TURNS = Number(process.env.SWEEP_TURNS ?? 28);

interface Key {
  model: string;
  mode: ActionMode;
  repeat: number;
}

function buildConfig(model: string, mode: ActionMode, repeat: number): MatchConfig {
  const blue = SCRIPTED
    ? pursuitController(0.82)
    : piController({ slug: model, spec: actionSpecs[mode], rules: FLIGHT_RULES });
  return {
    id: `${model}|${mode}|${repeat}`,
    turnDuration: TURN_DURATION,
    frameDt: FRAME_DT,
    maxTurns: MAX_TURNS,
    decisionTimeoutMs: 30_000,
    initialAircraft: createInitialAircraft(),
    sensor: perfectSensor,
    evaluator: competenceEvaluator,
    fallback: pursuitFallback,
    agents: {
      "blue-1": { meta: { id: "blue-1", kind: SCRIPTED ? "scripted" : "llm", label: `${model}/${mode}` }, controller: blue },
      "red-1": { meta: { id: "red-1", kind: "scripted", label: "defensive" }, controller: defensiveController(0.64) },
    },
  };
}

function pilotCost(decisions: { agentId: string; usage?: { costUsd: number } }[]): number {
  return decisions
    .filter((d) => d.agentId === PILOT_ID)
    .reduce((sum, d) => sum + (d.usage?.costUsd ?? 0), 0);
}

// Fraction of the pilot's turns that fell back to the safety controller (timeout, parse failure,
// provider error). A high rate means the model wasn't really flying — guards study validity.
function fallbackStats(decisions: { agentId: string; source: string; rationale?: string }[]) {
  const mine = decisions.filter((d) => d.agentId === PILOT_ID);
  const fb = mine.filter((d) => d.source === "fallback");
  return { rate: mine.length ? fb.length / mine.length : 0, reason: fb[0]?.rationale };
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

async function main(): Promise<void> {
  const models = SCRIPTED
    ? MODELS
    : MODELS.filter((m) => {
        try {
          resolveOpenRouterModel(m);
          return true;
        } catch {
          console.error(`skip (not in pi-ai registry): ${m}`);
          return false;
        }
      });

  const jobs: BatchJob<Key>[] = [];
  for (const model of models) {
    for (const mode of MODES) {
      for (let r = 0; r < REPEATS; r += 1) {
        jobs.push({ key: { model, mode, repeat: r }, config: buildConfig(model, mode, r) });
      }
    }
  }

  writeFileSync(OUT, "");
  rmSync(MATCHES_DIR, { recursive: true, force: true });
  mkdirSync(MATCHES_DIR, { recursive: true });
  const manifest: MatchSummary[] = [];
  console.error(
    `${SCRIPTED ? "[scripted dev] " : ""}sweep: ${models.length} models × ${MODES.length} modes × ${REPEATS} repeats = ${jobs.length} matches @ concurrency ${CONCURRENCY}`,
  );

  const t0 = Date.now();
  const results = await runBatch(jobs, {
    concurrency: CONCURRENCY,
    onResult: (res, done, total) => {
      const rec: Record<string, unknown> = { ...res.key };
      let tag: string;
      if (res.error || !res.replay) {
        rec.error = res.error;
        tag = `ERR ${res.error}`;
      } else {
        const comp = res.replay.outcome?.competence?.[PILOT_ID];
        const fb = fallbackStats(res.replay.decisions ?? []);
        const cost = pilotCost(res.replay.decisions ?? []);
        rec.competence = comp;
        rec.costUsd = cost;
        rec.winner = res.replay.outcome?.winnerTeam ?? null;
        rec.fallbackRate = fb.rate;
        if (fb.reason) rec.fallbackReason = fb.reason;

        const file = `${safeId(res.key.model, res.key.mode, res.key.repeat)}.json`;
        writeFileSync(`${MATCHES_DIR}/${file}`, JSON.stringify(res.replay));
        manifest.push({
          id: res.replay.id,
          file,
          model: res.key.model,
          mode: res.key.mode,
          repeat: res.key.repeat,
          winnerTeam: res.replay.outcome?.winnerTeam ?? null,
          costUsd: cost,
          fallbackRate: fb.rate,
          competence: comp,
        });

        tag =
          `win=${res.replay.outcome?.winnerTeam ?? "draw"} hits=${comp?.hits ?? "?"} ` +
          `stall=${comp ? comp.fracStalled.toFixed(2) : "?"} fb=${fb.rate.toFixed(2)}` +
          (fb.rate > 0 ? ` (${fb.reason ?? "?"})` : "");
      }
      appendFileSync(OUT, `${JSON.stringify(rec)}\n`);
      console.error(`[${done}/${total}] ${res.key.model} ${res.key.mode} #${res.key.repeat}: ${tag}`);
    },
  });

  writeFileSync(`${MATCHES_DIR}/index.json`, JSON.stringify(manifest));

  // Aggregate per (model, mode).
  const groups = new Map<
    string,
    { n: number; errors: number; comps: Competence[]; cost: number; wins: number; fbRates: number[] }
  >();
  for (const res of results) {
    const gk = `${res.key.model} · ${res.key.mode}`;
    const g = groups.get(gk) ?? { n: 0, errors: 0, comps: [], cost: 0, wins: 0, fbRates: [] };
    g.n += 1;
    if (res.error || !res.replay) {
      g.errors += 1;
    } else {
      const c = res.replay.outcome?.competence?.[PILOT_ID];
      if (c) g.comps.push(c);
      g.cost += pilotCost(res.replay.decisions ?? []);
      g.fbRates.push(fallbackStats(res.replay.decisions ?? []).rate);
      if (res.replay.outcome?.winnerTeam === "blue") g.wins += 1;
    }
    groups.set(gk, g);
  }

  const rows = [...groups.entries()].map(([config, g]) => ({
    config,
    n: g.n,
    err: g.errors,
    fbRate: mean(g.fbRates).toFixed(2),
    winRate: (g.wins / g.n).toFixed(2),
    hits: mean(g.comps.map((c) => c.hits)).toFixed(2),
    stalled: mean(g.comps.map((c) => c.fracStalled)).toFixed(2),
    onDeck: mean(g.comps.map((c) => c.fracOnDeck)).toFixed(2),
    energyKept: mean(g.comps.map((c) => c.energyRetainedRatio)).toFixed(2),
    smooth: mean(g.comps.map((c) => c.controlSmoothness)).toFixed(2),
    costUsd: g.cost.toFixed(4),
  }));

  console.error(`\n=== competence sweep (pilot ${PILOT_ID}) — ${((Date.now() - t0) / 1000).toFixed(1)}s ===`);
  console.table(rows);
  console.error(`per-match results: ${OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
