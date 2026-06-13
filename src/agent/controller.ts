import type { Action, AgentMeta, Observation } from "../protocol/schema";

export type { AgentMeta };

// What the runner hands a controller each turn besides the percept.
export interface ControllerContext {
  turn: number;
  agentId: string;
  deadlineMs: number; // latency budget; the controller should resolve before this
  signal: AbortSignal; // aborted on timeout — long-running controllers should bail
}

// A decision, not a bare Action: carries the expressed intent plus optional audit trail.
export interface ControllerDecision {
  action: Action;
  rationale?: string; // free-text "why" (LLM); recorded into the replay
  raw?: unknown; // raw provider response, kept in-memory for debugging (not persisted)
}

// The seam. Async from day one even for scripted agents (they resolve immediately), so an
// LLM controller — a network round-trip — drops in without changing the runtime.
export type Controller = (
  observation: Observation,
  context: ControllerContext,
) => Promise<ControllerDecision>;
