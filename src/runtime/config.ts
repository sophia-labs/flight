import type { Controller } from "../agent/controller";
import type { SensorModel } from "../agent/observation";
import type { BodyRuntimeConfig } from "../body/runtime";
import type { Evaluator } from "../eval/outcome";
import type {
  Action,
  AgentMessage,
  AgentMeta,
  AgentNavigationFix,
  ContactPercept,
  MatchReplay,
  Observation,
  SelfPercept,
} from "../protocol/schema";
import type { AircraftState } from "../sim/types";
import type { AgentComms } from "./comms";
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
  // Legacy actor-to-agent prompt-stream messages delivered to this agent each turn. Prefer MatchConfig.comms
  // for typed, schedulable messages that are also recorded in progress/replays.
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
  // Typed communications delivered before each agent decision. This is the operator/GCI/data-link seam:
  // callers can schedule scenario traffic, attach a live message bus, and optionally include nav fixes.
  comms?: AgentComms;
  // Optional progress callback — called for turn start, decisions, frames, and completion.
  // When set, the caller receives live match progress instead of waiting for the full replay.
  onProgress?: (progress: MatchProgress) => void;
}

// Emitted by runMatch as the match executes. Turn 0 is the initial snapshot.
export interface MatchProgress {
  phase:
    | "turn_start"
    | "message"
    | "decision"
    | "body_tick"
    | "simulating"
    | "frame"
    | "complete"
    | "garden_journal"
    | "error";
  turn: number;
  maxTurns: number;
  time: number;
  agentId?: string;
  agentLabel?: string;
  actionKind?: string;
  rationale?: string;
  message?: AgentMessage;
  messages?: AgentMessage[];
  navigation?: AgentNavigationFix;
  contacts?: ContactPercept[];
  self?: SelfPercept;
  frameIndex?: number;
  bodyTick?: { agentId: string; status: string; tick: number; feel?: string };
  replay?: MatchReplay; // only on complete
  gardenJournal?: unknown; // server-only optional side effect report
  error?: string; // only on error
}
