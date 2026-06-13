import { toObservation } from "../agent/observation";
import type { Controller, ControllerContext } from "../agent/controller";
import {
  MatchReplaySchema,
  type AgentMeta,
  type ControlInput,
  type MatchReplay,
  type Observation,
  type ReplayEvent,
  type ReplayFrame,
  type TurnDecision,
} from "../protocol/schema";
import { stepSimulation } from "../sim/flight";
import { toSnapshot, type AircraftState } from "../sim/types";
import type { AgentEntry, MatchConfig } from "./config";

function snapshot(
  index: number,
  time: number,
  turn: number,
  aircraft: AircraftState[],
  events: ReplayEvent[],
): ReplayFrame {
  return {
    index,
    time,
    turn,
    aircraft: aircraft.map(toSnapshot),
    events,
  };
}

interface DecisionOutcome {
  action: TurnDecision["action"];
  rationale?: string;
  source: TurnDecision["source"];
}

// Race the controller against its latency budget; abort + fall back on timeout or throw.
// No wall-clock is read here, so a match with deterministic controllers is itself deterministic.
async function decide(
  entry: AgentEntry,
  observation: Observation,
  context: ControllerContext,
  fallback: MatchConfig["fallback"],
): Promise<DecisionOutcome> {
  const aborter = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      aborter.abort();
      reject(new Error("controller timeout"));
    }, context.deadlineMs);
  });

  try {
    const decision = await Promise.race([
      entry.controller(observation, { ...context, signal: aborter.signal }),
      timeout,
    ]);
    return { action: decision.action, rationale: decision.rationale, source: "controller" };
  } catch {
    return { action: fallback(observation), source: "fallback" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// The generalized match runner: today's generateDemoMatch with the four fused concerns
// (decide / step / outcome / assemble) inverted into injected config. The physics substrate
// (stepSimulation + the per-turn step loop) is unchanged.
export async function runMatch(config: MatchConfig): Promise<MatchReplay> {
  const aircraft = config.initialAircraft;
  const stepsPerTurn = Math.round(config.turnDuration / config.frameDt);
  const frames: ReplayFrame[] = [];
  const decisions: TurnDecision[] = [];
  let time = 0;
  let frameIndex = 0;
  let turnsRun = 0;

  frames.push(snapshot(frameIndex, time, 0, aircraft, []));
  frameIndex += 1;

  for (let turn = 1; turn <= config.maxTurns; turn += 1) {
    turnsRun = turn;
    const controlsById: Record<string, ControlInput> = {};

    for (const ship of aircraft) {
      if (ship.health <= 0) continue;
      const entry = config.agents[ship.id];
      if (!entry) continue;

      const observation = toObservation(ship, aircraft, turn, time, config.sensor);
      const context: ControllerContext = {
        turn,
        agentId: ship.id,
        deadlineMs: config.decisionTimeoutMs,
        signal: new AbortController().signal,
      };
      const outcome = await decide(entry, observation, context, config.fallback);
      const controlInput = entry.adapter.toControlInput(outcome.action, ship);
      controlsById[ship.id] = controlInput;

      const decision: TurnDecision = {
        turn,
        agentId: ship.id,
        observation,
        action: outcome.action,
        controlInput,
        source: outcome.source,
      };
      if (outcome.rationale !== undefined) decision.rationale = outcome.rationale;
      decisions.push(decision);
    }

    for (let s = 0; s < stepsPerTurn; s += 1) {
      const result = stepSimulation(aircraft, controlsById, config.frameDt);
      time += config.frameDt;
      frames.push(snapshot(frameIndex, time, turn, result.aircraft, result.events));
      frameIndex += 1;
    }

    if (aircraft.some((ship) => ship.health <= 0)) break;
  }

  const outcome = config.evaluator.evaluate(aircraft, decisions, turnsRun);
  const agents: AgentMeta[] = Object.values(config.agents).map((entry) => entry.meta);

  return MatchReplaySchema.parse({
    id: config.id,
    schemaVersion: 2,
    turnDuration: config.turnDuration,
    frameDt: config.frameDt,
    frames,
    agents,
    decisions,
    outcome,
  });
}
