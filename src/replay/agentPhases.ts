import type { AgentPhaseTrace, MatchReplay } from "../protocol/schema";

const DEFAULT_TWITCH_TIME_SCALE = 0.35;

export function phasesForAgent(replay: MatchReplay, agentId: string): AgentPhaseTrace[] {
  return (replay.agentPhases ?? [])
    .filter((phase) => phase.agentId === agentId)
    .sort((a, b) => a.startTime - b.startTime || phasePriority(b.mode) - phasePriority(a.mode));
}

export function activeAgentPhase(
  replay: MatchReplay,
  agentId: string,
  time: number,
): AgentPhaseTrace | undefined {
  return phasesForAgent(replay, agentId)
    .filter((phase) => phase.startTime <= time + 1e-6 && phase.endTime >= time - 1e-6)
    .sort((a, b) => phasePriority(b.mode) - phasePriority(a.mode))[0];
}

export function playbackTimeScaleAt(replay: MatchReplay, agentId: string, time: number): number {
  const phase = activeAgentPhase(replay, agentId, time);
  if (phase?.mode !== "twitch") return 1;
  return clampTimeScale(phase.timeScale ?? DEFAULT_TWITCH_TIME_SCALE);
}

export function countAgentPhases(replay: MatchReplay, agentId: string, mode: AgentPhaseTrace["mode"]): number {
  return phasesForAgent(replay, agentId).filter((phase) => phase.mode === mode).length;
}

function phasePriority(mode: AgentPhaseTrace["mode"]): number {
  if (mode === "twitch") return 3;
  if (mode === "body") return 2;
  return 1;
}

function clampTimeScale(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_TWITCH_TIME_SCALE;
  return Math.max(0.05, Math.min(1, value));
}
