import type { Controller } from "../agent/controller";
import type { BodyRuntimeConfig } from "../body/runtime";
import type { SensorModel } from "../agent/observation";
import type { Evaluator } from "../eval/outcome";
import type { Action, AgentMeta, Observation } from "../protocol/schema";
import type { AircraftState } from "../sim/types";

export interface AgentEntry {
  meta: AgentMeta;
  controller: Controller;
  body?: BodyRuntimeConfig;
}

export interface MatchConfig {
  id: string;
  turnDuration: number;
  frameDt: number;
  maxTurns: number;
  decisionTimeoutMs: number;
  initialAircraft: AircraftState[];
  agents: Record<string, AgentEntry>; // keyed by aircraft id
  sensor: SensorModel;
  evaluator: Evaluator;
  // Used when a controller throws, times out, or is aborted. Receives the same observation the
  // controller saw, so a maneuvering fallback (e.g. scripted pursuit) keeps the match watchable.
  fallback: (observation: Observation) => Action;
}
