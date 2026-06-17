import type { Controller } from "../agent/controller";
import type { SensorModel } from "../agent/observation";
import type { BodyRuntimeConfig } from "../body/runtime";
import type { Evaluator } from "../eval/outcome";
import type { Action, AgentMeta, MatchReplay, Observation } from "../protocol/schema";
import type { AircraftState } from "../sim/types";
export interface AgentEntry {
  meta: AgentMeta;
  controller: Controller;
  // Legacy/body-first path: a pilot-intent action is turned into per-frame Body ticks.
  body?: BodyRuntimeConfig;
  // Motor-program path: the slow planner supplies the tape; this Body only wakes on held-action
  // interrupts such as weapons_free in a gun cone.
  reflexBody?: BodyRuntimeConfig;
  // Feed the cockpit camera-ascii@2 glyph-field to THIS controller's observation even when no Body is
  // attached. A bare planner normally flies on numbers only; this lets a no-twitch planner also see the
  // visual field (the "should the planner see the field?" experiment). Default off keeps baselines honest.
  feedField?: boolean;
  // Viewer/game playback hint for reflex windows. Physics still runs at frameDt; the replay uses this
  // to slow terminal twitch mode down for inspection without changing the recorded sim.
  reflexPlaybackTimeScale?: number;
  // Per-agent sensor model override. Defaults to MatchConfig.sensor.
  sensor?: SensorModel;
  // Actor-to-actor prompt-stream messages delivered to this agent each turn (GCI, data-link, wingman).
  messages?: string[];
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
  // Optional progress callback — called for turn start, decisions, frames, and completion.
  // When set, the caller receives live match progress instead of waiting for the full replay.
  onProgress?: (progress: MatchProgress) => void;
}

// Emitted by runMatch as the match executes. Turn 0 is the initial snapshot.
export interface MatchProgress {
  phase: "turn_start" | "decision" | "body_tick" | "simulating" | "frame" | "complete" | "error";
  turn: number;
  maxTurns: number;
  time: number;
  agentId?: string;
  agentLabel?: string;
  actionKind?: string;
  rationale?: string;
  frameIndex?: number;
  bodyTick?: { agentId: string; status: string; tick: number; feel?: string };
  replay?: MatchReplay; // only on complete
  error?: string; // only on error
}
