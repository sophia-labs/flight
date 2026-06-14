import { adapterFor } from "../agent/action";
import { toObservation } from "../agent/observation";
import { senseAndEncode } from "../agent/perception";
import type { ControllerContext } from "../agent/controller";
import {
  MatchReplaySchema,
  type Action,
  type AgentMeta,
  type Airframe,
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
  usage?: TurnDecision["usage"];
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
    const pending = entry.controller(observation, { ...context, signal: aborter.signal });
    pending.catch(() => {}); // swallow a late rejection if the deadline wins the race
    const decision = await Promise.race([pending, timeout]);
    return {
      action: decision.action,
      rationale: decision.rationale,
      usage: decision.usage,
      source: "controller",
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { action: fallback(observation), source: "fallback", rationale: message.slice(0, 160) };
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
    const actionsById: Record<string, Action> = {};

    // Decide once per turn, per living agent.
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
      actionsById[ship.id] = outcome.action;

      const decision: TurnDecision = {
        turn,
        agentId: ship.id,
        observation,
        action: outcome.action,
        controlInput: adapterFor(outcome.action.kind).controlFor(outcome.action, ship),
        source: outcome.source,
      };
      if (outcome.rationale !== undefined) decision.rationale = outcome.rationale;
      if (outcome.usage !== undefined) decision.usage = outcome.usage;

      // Record each mounted sensor's percept (pre-step world, same state the observation saw). This
      // is recorded for the viewer / as a capability proof — it does NOT feed the controller.
      const percepts = (ship.devices ?? []).map((device) => senseAndEncode(device, aircraft, ship));
      if (percepts.length > 0) decision.percepts = percepts;

      decisions.push(decision);
    }

    // Re-derive each held action into a control EVERY frame, so a setpoint adapter can track
    // the evolving state (raw-stick returns a constant, identical to holding the stick).
    for (let s = 0; s < stepsPerTurn; s += 1) {
      const controlsById: Record<string, ControlInput> = {};
      for (const ship of aircraft) {
        const action = actionsById[ship.id];
        if (action) controlsById[ship.id] = adapterFor(action.kind).controlFor(action, ship);
      }
      const result = stepSimulation(aircraft, controlsById, config.frameDt);
      time += config.frameDt;
      frames.push(snapshot(frameIndex, time, turn, result.aircraft, result.events));
      frameIndex += 1;
    }

    if (aircraft.some((ship) => ship.health <= 0)) break;
  }

  const outcome = config.evaluator.evaluate(aircraft, frames, decisions, turnsRun);
  const agents: AgentMeta[] = Object.values(config.agents).map((entry) => entry.meta);

  // Record the airframe each aircraft flew (config metadata, not per-frame state) so the viewer can
  // render the plane that was built. Omitted entirely when no aircraft carries one (keeps legacy-shaped
  // replays clean and the field optional).
  const airframes: Record<string, Airframe> = {};
  for (const ship of aircraft) {
    if (ship.airframe) airframes[ship.id] = ship.airframe;
  }

  return MatchReplaySchema.parse({
    id: config.id,
    schemaVersion: 2,
    turnDuration: config.turnDuration,
    frameDt: config.frameDt,
    frames,
    agents,
    decisions,
    outcome,
    ...(Object.keys(airframes).length > 0 ? { airframes } : {}),
  });
}
