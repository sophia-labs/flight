// Cross-model competence sweep. Runs (model × action-mode × repeats) matches against the scripted
// bot through a concurrency pool, streams per-match results to JSONL, and prints an aggregate
// competence-vs-cost table for the pilot seat.
//
//   tsx --env-file=.env src/headless/sweep.ts            # live cross-model sweep (needs OPENROUTER_API_KEY)
//   tsx src/headless/sweep.ts --scripted                 # free dev pass: validate the pipeline, no key
//
// Tunables via env: SWEEP_REPEATS, SWEEP_CONCURRENCY, SWEEP_TURNS, SWEEP_MODES.
// For embodied runs: SWEEP_MODES=pilot-intent SWEEP_BODY_MODEL=scripted|<openrouter slug>.
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { actionSpecs, type ActionMode } from "../agent/actionSpec";
import { bodyPilotController } from "../agent/controllers/bodyPilot";
import { FLIGHT_RULES, piController, resolveOpenRouterModel } from "../agent/controllers/pi";
import { defensiveController, pursuitController, pursuitFallback } from "../agent/controllers/scripted";
import { perfectSensor } from "../agent/observation";
import { competenceEvaluator } from "../eval/outcome";
import type { Competence, MatchSummary } from "../protocol/schema";
import type { MatchConfig } from "../runtime/config";
import { runBatch, type BatchJob } from "../runtime/batch";
import { FRAME_DT, TURN_DURATION, createInitialAircraft } from "../runtime/scenario";
import {
  SCRIPTED_BODY_MODEL,
  bodyModelLabel,
  createHeadlessBodyConfig,
} from "./bodyConfig";

const SCRIPTED = process.argv.includes("--scripted");
const PILOT_ID = "blue-1";
const OUT = "sweep-results.jsonl";
const MATCHES_DIR = "public/matches"; // served by Vite for the in-browser match browser

function safeId(model: string, mode: string, bodyModel: string | undefined, repeat: number): string {
  const body = bodyModel ? `__body-${bodyModel.replace(/[^a-z0-9.]+/gi, "-")}` : "";
  return `${model.replace(/[^a-z0-9.]+/gi, "-")}__${mode}${body}__${repeat}`;
}

const MODELS = SCRIPTED
  ? ["scripted-pursuit"]
  : [
      "anthropic/claude-haiku-4.5",
      "openai/gpt-4o-mini",
      "google/gemini-2.5-flash",
      "deepseek/deepseek-v4-flash",
      "deepseek/deepseek-chat-v3.1",
    ];
function parseActionMode(raw: string): ActionMode {
  if (raw in actionSpecs) return raw as ActionMode;
  throw new Error(`unknown action mode "${raw}"; expected ${Object.keys(actionSpecs).join("|")}`);
}

function parseActionModes(raw: string | undefined, fallback: ActionMode[]): ActionMode[] {
  if (!raw) return fallback;
  const modes = raw
    .split(",")
    .map((mode) => mode.trim())
    .filter(Boolean)
    .map(parseActionMode);
  if (modes.length === 0) throw new Error("SWEEP_MODES did not contain any action modes");
  return modes;
}

const BODY_MODEL = process.env.SWEEP_BODY_MODEL ?? SCRIPTED_BODY_MODEL;
const DEFAULT_MODES: ActionMode[] = SCRIPTED
  ? ["flight-director"]
  : process.env.SWEEP_BODY_MODEL
    ? ["pilot-intent"]
    : ["raw-stick", "setpoint", "flight-director"];
const MODES: ActionMode[] = parseActionModes(process.env.SWEEP_MODES, DEFAULT_MODES);
const REPEATS = Number(process.env.SWEEP_REPEATS ?? 3);
const CONCURRENCY = Number(process.env.SWEEP_CONCURRENCY ?? 12);
const MAX_TURNS = Number(process.env.SWEEP_TURNS ?? 28);
const BODY_TIMEOUT_MS = Number(process.env.SWEEP_BODY_TIMEOUT_MS ?? 15_000);
const BODY_MAX_TOKENS = Number(process.env.SWEEP_BODY_MAX_TOKENS ?? 96);
const BODY_MAX_RETRIES = Number(process.env.SWEEP_BODY_MAX_RETRIES ?? 2);
const BODY_EMPTY_RETRIES = Number(process.env.SWEEP_BODY_EMPTY_RETRIES ?? 1);

interface Key {
  model: string;
  mode: ActionMode;
  repeat: number;
  bodyModel?: string;
}

function buildConfig(model: string, mode: ActionMode, repeat: number): MatchConfig {
  const usesBody = mode === "pilot-intent";
  const body = usesBody
    ? createHeadlessBodyConfig({
        modelSlug: BODY_MODEL,
        maxTokens: BODY_MAX_TOKENS,
        maxRetries: BODY_MAX_RETRIES,
        emptyRetries: BODY_EMPTY_RETRIES,
        timeoutMs: BODY_TIMEOUT_MS,
      })
    : undefined;
  const blue = SCRIPTED
    ? usesBody
      ? bodyPilotController(0.82)
      : pursuitController(0.82)
    : piController({ slug: model, spec: actionSpecs[mode], rules: FLIGHT_RULES });
  return {
    id: `${model}|${mode}${usesBody ? `|body:${bodyModelLabel(BODY_MODEL)}` : ""}|${repeat}`,
    turnDuration: TURN_DURATION,
    frameDt: FRAME_DT,
    maxTurns: MAX_TURNS,
    decisionTimeoutMs: 30_000,
    initialAircraft: createInitialAircraft(),
    sensor: perfectSensor,
    evaluator: competenceEvaluator,
    fallback: pursuitFallback,
    agents: {
      "blue-1": {
        meta: {
          id: "blue-1",
          kind: SCRIPTED ? "scripted" : "llm",
          label: `${model}/${mode}`,
          ...(body
            ? { config: { bodyId: body.manifest.bodyId, bodyModel: bodyModelLabel(BODY_MODEL) } }
            : {}),
        },
        controller: blue,
        ...(body ? { body } : {}),
      },
      "red-1": { meta: { id: "red-1", kind: "scripted", label: "defensive" }, controller: defensiveController(0.64) },
    },
  };
}

function pilotCost(decisions: { agentId: string; usage?: { costUsd: number } }[]): number {
  return decisions
    .filter((d) => d.agentId === PILOT_ID)
    .reduce((sum, d) => sum + (d.usage?.costUsd ?? 0), 0);
}

function bodyCost(bodyTicks: { agentId: string; usage?: { costUsd: number } }[]): number {
  return bodyTicks
    .filter((tick) => tick.agentId === PILOT_ID)
    .reduce((sum, tick) => sum + (tick.usage?.costUsd ?? 0), 0);
}

function bodyStats(bodyTicks: { agentId: string; parsed: { status: string } }[]) {
  const mine = bodyTicks.filter((tick) => tick.agentId === PILOT_ID);
  const ok = mine.filter((tick) => tick.parsed.status !== "failed").length;
  return {
    count: mine.length,
    parseRate: mine.length ? ok / mine.length : undefined,
  };
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
        jobs.push({
          key: { model, mode, repeat: r, ...(mode === "pilot-intent" ? { bodyModel: bodyModelLabel(BODY_MODEL) } : {}) },
          config: buildConfig(model, mode, r),
        });
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
  if (MODES.includes("pilot-intent")) {
    console.error(`body: ${bodyModelLabel(BODY_MODEL)} timeout=${BODY_TIMEOUT_MS}ms`);
  }

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
        const pCost = pilotCost(res.replay.decisions ?? []);
        const bCost = bodyCost(res.replay.bodyTicks ?? []);
        const cost = pCost + bCost;
        const body = bodyStats(res.replay.bodyTicks ?? []);
        rec.competence = comp;
        rec.costUsd = cost;
        rec.pilotCostUsd = pCost;
        rec.bodyCostUsd = bCost;
        rec.bodyTicks = body.count;
        if (body.parseRate !== undefined) rec.bodyParseRate = body.parseRate;
        rec.winner = res.replay.outcome?.winnerTeam ?? null;
        rec.fallbackRate = fb.rate;
        if (fb.reason) rec.fallbackReason = fb.reason;

        const file = `${safeId(res.key.model, res.key.mode, res.key.bodyModel, res.key.repeat)}.json`;
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
          ...(bCost > 0 ? { bodyCostUsd: bCost } : {}),
          ...(body.parseRate !== undefined ? { bodyParseRate: body.parseRate } : {}),
          competence: comp,
        });

        tag =
          `win=${res.replay.outcome?.winnerTeam ?? "draw"} hits=${comp?.hits ?? "?"} ` +
          `stall=${comp ? comp.fracStalled.toFixed(2) : "?"} fb=${fb.rate.toFixed(2)}` +
          (body.count > 0 ? ` body=${body.parseRate?.toFixed(2) ?? "?"}/${body.count}` : "") +
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
    {
      n: number;
      errors: number;
      comps: Competence[];
      cost: number;
      bodyCost: number;
      wins: number;
      fbRates: number[];
      bodyParseRates: number[];
    }
  >();
  for (const res of results) {
    const gk = `${res.key.model} · ${res.key.mode}${res.key.bodyModel ? ` · body ${res.key.bodyModel}` : ""}`;
    const g = groups.get(gk) ?? {
      n: 0,
      errors: 0,
      comps: [],
      cost: 0,
      bodyCost: 0,
      wins: 0,
      fbRates: [],
      bodyParseRates: [],
    };
    g.n += 1;
    if (res.error || !res.replay) {
      g.errors += 1;
    } else {
      const c = res.replay.outcome?.competence?.[PILOT_ID];
      if (c) g.comps.push(c);
      g.cost += pilotCost(res.replay.decisions ?? []) + bodyCost(res.replay.bodyTicks ?? []);
      g.bodyCost += bodyCost(res.replay.bodyTicks ?? []);
      g.fbRates.push(fallbackStats(res.replay.decisions ?? []).rate);
      const body = bodyStats(res.replay.bodyTicks ?? []);
      if (body.parseRate !== undefined) g.bodyParseRates.push(body.parseRate);
      if (res.replay.outcome?.winnerTeam === "blue") g.wins += 1;
    }
    groups.set(gk, g);
  }

  const rows = [...groups.entries()].map(([config, g]) => ({
    config,
    n: g.n,
    err: g.errors,
    fbRate: mean(g.fbRates).toFixed(2),
    bodyParse: g.bodyParseRates.length ? mean(g.bodyParseRates).toFixed(2) : "—",
    winRate: (g.wins / g.n).toFixed(2),
    hits: mean(g.comps.map((c) => c.hits)).toFixed(2),
    stalled: mean(g.comps.map((c) => c.fracStalled)).toFixed(2),
    onDeck: mean(g.comps.map((c) => c.fracOnDeck)).toFixed(2),
    energyKept: mean(g.comps.map((c) => c.energyRetainedRatio)).toFixed(2),
    smooth: mean(g.comps.map((c) => c.controlSmoothness)).toFixed(2),
    costUsd: g.cost.toFixed(4),
    bodyCostUsd: g.bodyCost > 0 ? g.bodyCost.toFixed(4) : "—",
  }));

  console.error(`\n=== competence sweep (pilot ${PILOT_ID}) — ${((Date.now() - t0) / 1000).toFixed(1)}s ===`);
  console.table(rows);
  console.error(`per-match results: ${OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
