// Resumable stepping CLI — exposes the turn loop as a file-backed state machine so ANY external
// pilot (a Claude subagent, or a human) can fly one seat without an API key or the SDK. The
// pilot sees ONLY the observation the CLI prints each turn, which honours the observation
// contract more strictly than an in-process controller could.
//
//   tsx src/headless/turn.ts init                         -> prints { turn, observation }
//   tsx src/headless/turn.ts step '{"reason":"...","pitch":0.2,"roll":-0.4,"yaw":0,"throttle":0.9,"trigger":false}'
//                                                          -> prints next { observation } or { done, outcome }
//   tsx src/headless/turn.ts finish                       -> writes match.json
//
// Blue (PILOT_ID) is the external pilot; every other aircraft flies the scripted defensive
// controller; physics is the same stepSimulation the in-process runtime uses.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { rawStickAdapter } from "../agent/action";
import { defensiveController } from "../agent/controllers/scripted";
import { perfectSensor, toObservation } from "../agent/observation";
import { minimalEvaluator } from "../eval/outcome";
import {
  MatchReplaySchema,
  type Action,
  type AgentMeta,
  type ControlInput,
  type MatchReplay,
  type ReplayEvent,
  type ReplayFrame,
  type TurnDecision,
} from "../protocol/schema";
import { stepSimulation } from "../sim/flight";
import { toSnapshot, type AircraftState } from "../sim/types";
import { FRAME_DT, TURN_DURATION, createInitialAircraft } from "../runtime/scenario";

const STATE_PATH = "match-state.json";
const OUTPUT_PATH = "match.json";
const PILOT_ID = "blue-1";
const MAX_TURNS = 28;
const STEPS_PER_TURN = Math.round(TURN_DURATION / FRAME_DT);

interface MatchState {
  id: string;
  turn: number; // turns completed
  time: number;
  frameIndex: number;
  aircraft: AircraftState[];
  frames: ReplayFrame[];
  decisions: TurnDecision[];
  done: boolean;
}

function buildFrame(
  index: number,
  time: number,
  turn: number,
  aircraft: AircraftState[],
  events: ReplayEvent[],
): ReplayFrame {
  return { index, time, turn, aircraft: aircraft.map(toSnapshot), events };
}

function loadState(): MatchState {
  if (!existsSync(STATE_PATH)) throw new Error(`no ${STATE_PATH} found — run "init" first`);
  return JSON.parse(readFileSync(STATE_PATH, "utf8")) as MatchState;
}

function saveState(state: MatchState): void {
  writeFileSync(STATE_PATH, JSON.stringify(state));
}

function emit(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

// Percept the pilot acts on for the upcoming turn.
function pilotObservation(state: MatchState) {
  const blue = state.aircraft.find((a) => a.id === PILOT_ID);
  if (!blue) throw new Error(`pilot ${PILOT_ID} not found`);
  return toObservation(blue, state.aircraft, state.turn + 1, state.time, perfectSensor);
}

function init(): void {
  const aircraft = createInitialAircraft();
  const state: MatchState = {
    id: "pilot-duel-001",
    turn: 0,
    time: 0,
    frameIndex: 1,
    aircraft,
    frames: [buildFrame(0, 0, 0, aircraft, [])],
    decisions: [],
    done: false,
  };
  saveState(state);
  emit({ turn: 1, maxTurns: MAX_TURNS, observation: pilotObservation(state) });
}

async function step(actionJson: string): Promise<void> {
  const state = loadState();
  if (state.done) {
    emit({ done: true, note: 'match already finished — run "finish"' });
    return;
  }

  let cmd: Record<string, unknown>;
  try {
    cmd = JSON.parse(actionJson) as Record<string, unknown>;
  } catch {
    emit({ error: "action must be a JSON object" });
    process.exitCode = 1;
    return;
  }
  for (const field of ["pitch", "roll", "yaw", "throttle"]) {
    if (typeof cmd[field] !== "number" || !Number.isFinite(cmd[field])) {
      emit({ error: `field "${field}" must be a finite number` });
      process.exitCode = 1;
      return;
    }
  }

  const nextTurn = state.turn + 1;
  const pilotAction: Action = {
    kind: "raw-stick",
    pitch: cmd.pitch as number,
    roll: cmd.roll as number,
    yaw: cmd.yaw as number,
    throttle: cmd.throttle as number,
    trigger: Boolean(cmd.trigger),
  };

  const controlsById: Record<string, ControlInput> = {};

  const blue = state.aircraft.find((a) => a.id === PILOT_ID);
  if (blue && blue.health > 0) {
    const observation = toObservation(blue, state.aircraft, nextTurn, state.time, perfectSensor);
    const controlInput = rawStickAdapter.toControlInput(pilotAction, blue);
    controlsById[blue.id] = controlInput;
    const decision: TurnDecision = {
      turn: nextTurn,
      agentId: blue.id,
      observation,
      action: pilotAction,
      controlInput,
      source: "controller",
    };
    if (typeof cmd.reason === "string") decision.rationale = cmd.reason;
    state.decisions.push(decision);
  }

  // Scripted opponents.
  for (const ship of state.aircraft) {
    if (ship.id === PILOT_ID || ship.health <= 0) continue;
    const observation = toObservation(ship, state.aircraft, nextTurn, state.time, perfectSensor);
    const decision = await defensiveController(0.64)(observation, {
      turn: nextTurn,
      agentId: ship.id,
      deadlineMs: 5_000,
      signal: new AbortController().signal,
    });
    const controlInput = rawStickAdapter.toControlInput(decision.action, ship);
    controlsById[ship.id] = controlInput;
    const record: TurnDecision = {
      turn: nextTurn,
      agentId: ship.id,
      observation,
      action: decision.action,
      controlInput,
      source: "controller",
    };
    if (decision.rationale !== undefined) record.rationale = decision.rationale;
    state.decisions.push(record);
  }

  for (let s = 0; s < STEPS_PER_TURN; s += 1) {
    const result = stepSimulation(state.aircraft, controlsById, FRAME_DT);
    state.time += FRAME_DT;
    state.frames.push(buildFrame(state.frameIndex, state.time, nextTurn, result.aircraft, result.events));
    state.frameIndex += 1;
  }
  state.turn = nextTurn;

  if (state.aircraft.some((a) => a.health <= 0) || nextTurn >= MAX_TURNS) {
    state.done = true;
    saveState(state);
    const outcome = minimalEvaluator.evaluate(state.aircraft, state.decisions, nextTurn);
    emit({ done: true, turn: nextTurn, outcome });
    return;
  }

  saveState(state);
  emit({ done: false, turn: nextTurn + 1, observation: pilotObservation(state) });
}

function finish(): void {
  const state = loadState();
  const outcome = minimalEvaluator.evaluate(state.aircraft, state.decisions, state.turn);
  const agents: AgentMeta[] = [
    { id: PILOT_ID, kind: "llm", label: "subagent-pilot" },
    ...state.aircraft
      .filter((a) => a.id !== PILOT_ID)
      .map((a) => ({ id: a.id, kind: "scripted" as const, label: "defensive" })),
  ];
  const replay: MatchReplay = MatchReplaySchema.parse({
    id: state.id,
    schemaVersion: 2,
    turnDuration: TURN_DURATION,
    frameDt: FRAME_DT,
    frames: state.frames,
    agents,
    decisions: state.decisions,
    outcome,
  });
  writeFileSync(OUTPUT_PATH, JSON.stringify(replay));

  const shots = state.frames.reduce(
    (n, f) => n + f.events.filter((e) => e.type === "shot").length,
    0,
  );
  const hits = state.frames.reduce((n, f) => n + f.events.filter((e) => e.type === "hit").length, 0);
  console.error(
    `wrote ${OUTPUT_PATH}: ${state.frames.length} frames, ${shots} shots, ${hits} hits, ` +
      `winner=${outcome.winnerTeam ?? "draw"} (${outcome.reason})`,
  );
  emit({ wrote: OUTPUT_PATH, frames: state.frames.length, outcome });
}

const command = process.argv[2];
const actionArg = process.argv[3];

(async () => {
  if (command === "init") {
    init();
  } else if (command === "step") {
    if (!actionArg) {
      emit({ error: "step requires a JSON action argument" });
      process.exitCode = 1;
      return;
    }
    await step(actionArg);
  } else if (command === "finish") {
    finish();
  } else {
    console.error("usage: turn.ts <init | step '{json}' | finish>");
    process.exitCode = 1;
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
