// Coach harness — NO-TWITCH flying. Fly a motor-program planner at a static balloon (a pure flying
// task) and emit a flight diagnostic + a per-turn "belief vs physics" digest for the coaching loop.
//
// No reflexBody is attached, so the twitch branch in match.ts never runs and the planner flies its own
// control tape end to end. We never pull the trigger; balloonMetrics' would-hit geometry scores whether
// the planner flew the plane into a position where a shot WOULD have connected. That isolates the one
// thing we're coaching here: can it fly the jet?
//
//   npm run coach                              # baseline: deepseek-v4-pro, balloon, numbers only
//   COACH_FEED_FIELD=1 npm run coach           # also feed the camera-ascii@2 cockpit field to the planner
//   COACH_SCENARIO=balloon-hard COACH_TURNS=18 npm run coach
//   COACH_TAG=after-edit npm run coach         # name the replay/digest for before/after comparisons
//   PLANNER_MODEL=deepseek/deepseek-v4-flash npm run coach   # OpenRouter slug also works
//
// Writes reports/coach/<tag>.json (replay), <tag>.md (readable diagnostic), <tag>.digest.json (machine
// digest the interview step reads back).
import { mkdirSync, writeFileSync } from "node:fs";
import { actionSpecs } from "../agent/actionSpec";
import { FLIGHT_RULES, piController, resolveOpenRouterModel } from "../agent/controllers/pi";
import { pursuitFallback } from "../agent/controllers/scripted";
import { perfectSensor } from "../agent/observation";
import { competenceEvaluator } from "../eval/outcome";
import {
  BALLOON_MAX_GUN_RANGE_M,
  balloonMetrics,
  bulletWouldHitBalloon,
} from "../eval/balloonMetrics";
import type { Competence, MatchReplay, MotorProgramAction, TurnDecision } from "../protocol/schema";
import type { MatchConfig } from "../runtime/config";
import { runMatch } from "../runtime/match";
import {
  createBalloonScenarioAircraft,
  createChallengingBalloonScenarioAircraft,
  createChallengingMissileScenarioAircraft,
  staticController,
} from "../runtime/scenario";

const PILOT_ID = "blue-1";
const BALLOON_ID = "balloon";
const RAD2DEG = 180 / Math.PI;

const plannerModel = process.env.PLANNER_MODEL ?? "deepseek-v4-pro";
const scenario = process.env.COACH_SCENARIO ?? "balloon"; // "balloon" | "balloon-hard" | "missile"
const turns = Number(process.env.COACH_TURNS ?? (scenario === "balloon" ? 14 : 18));
const maxTokens = Number(process.env.PILOT_MAX_TOKENS ?? 4_096);
const feedField = process.env.COACH_FEED_FIELD === "1" || process.env.COACH_FEED_FIELD === "true";
const tag = process.env.COACH_TAG ?? "baseline";
const decisionTimeoutMs = Number(process.env.COACH_DECISION_TIMEOUT_MS ?? 60_000);
const TURN_DURATION = 2.5;
const FRAME_DT = 0.05;

function buildConfig(): MatchConfig {
  if (scenario !== "balloon" && scenario !== "balloon-hard" && scenario !== "missile") {
    throw new Error(`unknown COACH_SCENARIO=${scenario}; expected balloon, balloon-hard, or missile`);
  }
  const aircraft =
    scenario === "missile"
      ? createChallengingMissileScenarioAircraft()
      : scenario === "balloon-hard"
        ? createChallengingBalloonScenarioAircraft()
        : createBalloonScenarioAircraft();
  const controller = piController({
    slug: plannerModel,
    spec: actionSpecs["motor-program"],
    rules: FLIGHT_RULES,
    maxTokens,
  });
  return {
    id: `coach|${scenario}|${plannerModel}|${feedField ? "field" : "numbers"}|${tag}`,
    turnDuration: TURN_DURATION,
    frameDt: FRAME_DT,
    maxTurns: turns,
    decisionTimeoutMs,
    initialAircraft: aircraft,
    sensor: perfectSensor,
    evaluator: competenceEvaluator,
    fallback: pursuitFallback,
    agents: {
      "blue-1": {
        meta: { id: "blue-1", kind: "llm", label: `${plannerModel}/motor-program` },
        controller,
        // NO reflexBody → twitch never wakes. feedField is the only optional visual seam.
        ...(feedField ? { feedField: true } : {}),
      },
      balloon: {
        meta: { id: "balloon", kind: "scripted", label: "balloon (static)" },
        controller: staticController,
      },
    },
  };
}

// Per-turn channel summary of an authored control tape: where each axis starts and ends, its range, and
// how many times it crosses through neutral (sign flips = a tape fighting itself).
function tapeChannel(samples: MotorProgramAction["samples"], key: "pitch" | "roll" | "yaw" | "throttle") {
  const vals = samples.map((s) => s[key] as number);
  let flips = 0;
  for (let i = 1; i < vals.length; i += 1) {
    if (Math.sign(vals[i]) !== Math.sign(vals[i - 1]) && Math.sign(vals[i]) !== 0 && Math.sign(vals[i - 1]) !== 0) {
      flips += 1;
    }
  }
  return {
    start: vals[0] ?? 0,
    end: vals[vals.length - 1] ?? 0,
    min: vals.length ? Math.min(...vals) : 0,
    max: vals.length ? Math.max(...vals) : 0,
    flips,
  };
}

interface TurnRecord {
  turn: number;
  source: TurnDecision["source"];
  rationale: string;
  // belief: what the observation told the planner at decision time
  seen: {
    rangeM: number | null;
    offNoseDeg: number | null; // acos(bearingForward) — aim error to the balloon
    bearingRight: number | null;
    bearingUp: number | null;
    closureRate: number | null;
    altitude: number;
    airspeed: number;
    aoaDeg: number;
    gLoad: number;
    stalled: boolean;
  };
  // intent: the tape it authored
  tape: {
    durationMs: number;
    pitch: ReturnType<typeof tapeChannel>;
    roll: ReturnType<typeof tapeChannel>;
    yaw: ReturnType<typeof tapeChannel>;
    throttle: ReturnType<typeof tapeChannel>;
    held: string[];
  } | null;
  wouldHitDuringTurn: boolean; // did a shot fired on any frame of this turn's window connect?
}

function offNoseDeg(bearingForward: number): number {
  return Math.acos(Math.max(-1, Math.min(1, bearingForward))) * RAD2DEG;
}

function buildTurnRecords(replay: MatchReplay): TurnRecord[] {
  const decisions = (replay.decisions ?? [])
    .filter((d) => d.agentId === PILOT_ID)
    .sort((a, b) => a.turn - b.turn);

  // Frames where a shot would have connected, grouped by turn.
  const wouldHitTurns = new Set<number>();
  for (const f of replay.frames) {
    const body = f.aircraft.find((a) => a.id === PILOT_ID);
    const balloon = f.aircraft.find((a) => a.id === BALLOON_ID);
    if (body && balloon && balloon.health > 0 && bulletWouldHitBalloon(body, balloon)) {
      wouldHitTurns.add(f.turn);
    }
  }

  return decisions.map((d) => {
    const c0 = d.observation.contacts[0];
    const self = d.observation.self;
    const action = d.action.kind === "motor-program" ? (d.action as MotorProgramAction) : null;
    return {
      turn: d.turn,
      source: d.source,
      rationale: d.rationale ?? "",
      seen: {
        rangeM: c0 ? c0.range : null,
        offNoseDeg: c0 ? offNoseDeg(c0.bearingForward) : null,
        bearingRight: c0 ? c0.bearingRight : null,
        bearingUp: c0 ? c0.bearingUp : null,
        closureRate: c0 ? c0.closureRate : null,
        altitude: self.altitude,
        airspeed: self.airspeed,
        aoaDeg: self.aoaDeg,
        gLoad: self.gLoad,
        stalled: self.stalled,
      },
      tape: action
        ? {
            durationMs: action.durationMs,
            pitch: tapeChannel(action.samples, "pitch"),
            roll: tapeChannel(action.samples, "roll"),
            yaw: tapeChannel(action.samples, "yaw"),
            throttle: tapeChannel(action.samples, "throttle"),
            held: action.heldActions.map((h) => h.kind),
          }
        : null,
      wouldHitDuringTurn: wouldHitTurns.has(d.turn),
    };
  });
}

function ch(c: ReturnType<typeof tapeChannel>): string {
  const f = (x: number) => (x >= 0 ? "+" : "") + x.toFixed(2);
  return `${f(c.start)}→${f(c.end)}[${f(c.min)},${f(c.max)}]${c.flips ? ` flips=${c.flips}` : ""}`;
}

function num(x: number | null, digits = 0): string {
  return x === null ? "  -" : x.toFixed(digits);
}

function diagnostic(replay: MatchReplay, records: TurnRecord[]): string {
  const bm = balloonMetrics(replay);
  const comp = (replay.outcome?.competence?.[PILOT_ID] ?? {}) as Partial<Competence>;
  const blueDec = (replay.decisions ?? []).filter((d) => d.agentId === PILOT_ID);
  const fallbacks = blueDec.filter((d) => d.source === "fallback").length;
  const pilotCost = blueDec.reduce((s, d) => s + (d.usage?.costUsd ?? 0), 0);
  const peakOffNoseDeg = offNoseDeg(bm.peakOnNose);
  const wouldHitTurns = records.filter((r) => r.wouldHitDuringTurn).map((r) => r.turn);

  const L: string[] = [];
  L.push(`# Coach diagnostic — ${tag}`);
  L.push("");
  L.push(`planner=${plannerModel}  scenario=${scenario}  field=${feedField ? "ON" : "off"}  turns≤${turns}`);
  L.push(
    `decisions=${blueDec.length}  fallbacks=${fallbacks}  pilotCost=$${pilotCost.toFixed(4)}  ` +
      `replay=reports/coach/${tag}.json`,
  );
  L.push("");
  L.push("## Flying score (no shots fired — would-hit geometry)");
  L.push(
    `closestRange=${bm.closestRangeM.toFixed(0)}m   peak alignment=${peakOffNoseDeg.toFixed(1)}° off nose ` +
      `(1.0=dead-on → ${bm.peakOnNose.toFixed(3)})`,
  );
  L.push(
    `would-hit time=${bm.timeOnBalloonBeforeKillSec.toFixed(2)}s   ` +
      `first firing position=${bm.timeToFirstSolutionSec === null ? "NEVER" : bm.timeToFirstSolutionSec.toFixed(1) + "s"}   ` +
      `would-hit on turns=[${wouldHitTurns.join(",") || "none"}]`,
  );
  L.push(`(a round reaches ${BALLOON_MAX_GUN_RANGE_M}m; within 42m of the axis = a hit)`);
  L.push("");
  if (scenario === "missile") {
    let launchT: number | null = null;
    let lockT: number | null = null;
    for (const f of replay.frames) {
      for (const p of f.projectiles ?? []) {
        if (p.kind !== "missile") continue;
        if (launchT === null) launchT = f.time;
        if (p.lockState === "acquired" && lockT === null) lockT = f.time;
      }
    }
    L.push("## Missile engagement (AIM-9 FOX-2)");
    L.push(
      `launched=${launchT === null ? "NEVER" : launchT.toFixed(1) + "s"}   ` +
        `lock=${lockT === null ? "no" : lockT.toFixed(1) + "s"}   ` +
        `balloon killed=${bm.killed ? (bm.timeToKillSec?.toFixed(1) ?? "yes") + "s" : "NO"}   ` +
        `shots=${bm.shots} hits=${bm.hits}`,
    );
    L.push("");
  }
  L.push("## Energy & control (competenceEvaluator)");
  L.push(
    `energyRetained=${(comp.energyRetainedRatio ?? NaN).toFixed(2)}   ` +
      `meanAirspeed=${(comp.meanAirspeed ?? NaN).toFixed(0)}m/s   minAlt=${(comp.minAltitude ?? NaN).toFixed(0)}m`,
  );
  L.push(
    `fracStalled=${(comp.fracStalled ?? NaN).toFixed(2)}   fracOnDeck=${(comp.fracOnDeck ?? NaN).toFixed(2)}   ` +
      `controlSmoothness=${(comp.controlSmoothness ?? NaN).toFixed(2)}`,
  );
  L.push("");
  L.push("## Per turn — what it SAW, what it COMMANDED");
  L.push("turn src  rng off° R     U     clo   | alt  spd aoa  g   st | tape (start→end[min,max])");
  for (const r of records) {
    const s = r.seen;
    const src = r.source === "fallback" ? "FB " : "ok ";
    const wh = r.wouldHitDuringTurn ? " ◄would-hit" : "";
    const head =
      `${String(r.turn).padStart(2)}  ${src} ` +
      `${num(s.rangeM).padStart(4)} ${num(s.offNoseDeg).padStart(3)} ` +
      `${num(s.bearingRight, 2).padStart(5)} ${num(s.bearingUp, 2).padStart(5)} ${num(s.closureRate).padStart(5)} | ` +
      `${s.altitude.toFixed(0).padStart(4)} ${s.airspeed.toFixed(0).padStart(3)} ${s.aoaDeg.toFixed(0).padStart(3)} ` +
      `${s.gLoad.toFixed(1).padStart(3)} ${s.stalled ? "S" : "."}`;
    L.push(head + (r.tape ? ` | p${ch(r.tape.pitch)} r${ch(r.tape.roll)} thr${ch(r.tape.throttle)}` : " | (no tape)") + wh);
    if (r.tape && (r.tape.yaw.flips > 0 || Math.abs(r.tape.yaw.start) > 0.05 || Math.abs(r.tape.yaw.end) > 0.05)) {
      L.push(`        yaw ${ch(r.tape.yaw)}  held=[${r.tape.held.join(",")}]`);
    }
    if (r.rationale) L.push(`        “${r.rationale}”`);
  }
  return L.join("\n");
}

async function main(): Promise<void> {
  resolveOpenRouterModel(plannerModel); // fail fast on a bad slug before spending a run
  mkdirSync("reports/coach", { recursive: true });
  console.error(
    `coach: ${plannerModel} motor-program (NO twitch), ${scenario}, field=${feedField ? "ON" : "off"}, ` +
      `${turns} turns @ ${TURN_DURATION}s/turn dt=${FRAME_DT}s, tag=${tag}`,
  );

  const replay = await runMatch(buildConfig());
  const replayPath = `reports/coach/${tag}.json`;
  writeFileSync(replayPath, JSON.stringify(replay));

  const records = buildTurnRecords(replay);
  const report = diagnostic(replay, records);
  writeFileSync(`reports/coach/${tag}.md`, report + "\n");
  writeFileSync(
    `reports/coach/${tag}.digest.json`,
    JSON.stringify(
      {
        tag,
        planner: plannerModel,
        scenario,
        feedField,
        turns,
        metrics: balloonMetrics(replay),
        competence: replay.outcome?.competence?.[PILOT_ID] ?? null,
        records,
      },
      null,
      2,
    ),
  );

  console.log("\n" + report + "\n");
  console.error(`wrote ${replayPath}, reports/coach/${tag}.md, reports/coach/${tag}.digest.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
