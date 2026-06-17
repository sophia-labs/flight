import { z } from "zod";
import { MatchReplaySchema, type Action, type MatchReplay, type TurnDecision } from "../protocol/schema";
import { activeAgentPhase, countAgentPhases } from "../replay/agentPhases";

export const ScenarioInspectRequestSchema = z.object({
  replay: MatchReplaySchema,
  pilotId: z.string().default("blue-1"),
  time: z.number().optional(),
});

export interface ScenarioInspectResponse {
  schemaVersion: 1;
  replayId: string;
  pilotId: string;
  time: number;
  durationSeconds: number;
  frameIndex: number;
  activePhase?: ReturnType<typeof activeAgentPhase>;
  phaseCounts: {
    planner: number;
    body: number;
    twitch: number;
  };
  pilot: {
    label: string;
    lastDecision?: {
      turn: number;
      source: TurnDecision["source"];
      rationale?: string;
      action: string;
      observationText?: string;
    };
    context?: string;
  };
  body?: {
    label: string;
    lastTickTime: number;
    status: string;
    solution?: string;
    feel?: string;
    field: string;
    promptText: string;
    rawOutput: string;
    context: string;
  };
  events: string[];
}

export function inspectScenarioApiRequest(input: unknown): ScenarioInspectResponse {
  const request = ScenarioInspectRequestSchema.parse(input);
  return inspectScenarioReplay(request.replay, {
    pilotId: request.pilotId,
    time: request.time,
  });
}

export function inspectScenarioReplay(
  replay: MatchReplay,
  options: { pilotId?: string; time?: number } = {},
): ScenarioInspectResponse {
  const pilotId = options.pilotId ?? "blue-1";
  const durationSeconds = replay.frames.at(-1)?.time ?? 0;
  const time = clampTime(options.time ?? durationSeconds, durationSeconds);
  const frame = closestFrame(replay, time);
  const lastDecision = lastDecisionAt(replay, pilotId, time);
  const lastTick = (replay.bodyTicks ?? [])
    .filter((tick) => tick.agentId === pilotId && tick.time <= time + 1e-6)
    .sort((a, b) => b.time - a.time)[0];
  const agent = replay.agents?.find((entry) => entry.id === pilotId);
  const pilotLabel = agent?.label ?? pilotId;
  const bodyLabel = stringConfig(agent?.config, "bodyModel") ?? stringConfig(agent?.config, "twitchBodyModel") ?? "unknown";

  return {
    schemaVersion: 1,
    replayId: replay.id,
    pilotId,
    time,
    durationSeconds,
    frameIndex: frame?.index ?? 0,
    ...(activeAgentPhase(replay, pilotId, time)
      ? { activePhase: activeAgentPhase(replay, pilotId, time) }
      : {}),
    phaseCounts: {
      planner: countAgentPhases(replay, pilotId, "planner"),
      body: countAgentPhases(replay, pilotId, "body"),
      twitch: countAgentPhases(replay, pilotId, "twitch"),
    },
    pilot: {
      label: pilotLabel,
      ...(lastDecision
        ? {
            lastDecision: {
              turn: lastDecision.turn,
              source: lastDecision.source,
              ...(lastDecision.rationale ? { rationale: lastDecision.rationale } : {}),
              action: actionSummary(lastDecision.action),
              ...(lastDecision.observation.text ? { observationText: lastDecision.observation.text } : {}),
            },
            context: pilotTalkContext(lastDecision, pilotLabel),
          }
        : {}),
    },
    ...(lastTick
      ? {
          body: {
            label: bodyLabel,
            lastTickTime: lastTick.time,
            status: lastTick.parsed.status,
            ...(lastTick.parsed.solution ? { solution: lastTick.parsed.solution } : {}),
            ...(lastTick.parsed.feel ? { feel: lastTick.parsed.feel } : {}),
            field: lastTick.proprioception.field,
            promptText: lastTick.promptText,
            rawOutput: lastTick.rawOutput,
            context: bodyTalkContext(lastTick.promptText, lastTick.rawOutput, bodyLabel),
          },
        }
      : {}),
    events: (frame?.events ?? []).map((event) => event.message),
  };
}

function closestFrame(replay: MatchReplay, time: number) {
  return replay.frames.reduce<(typeof replay.frames)[number] | undefined>((best, frame) => {
    if (!best) return frame;
    return Math.abs(frame.time - time) < Math.abs(best.time - time) ? frame : best;
  }, undefined);
}

function lastDecisionAt(replay: MatchReplay, pilotId: string, time: number): TurnDecision | undefined {
  return (replay.decisions ?? [])
    .filter((decision) => decision.agentId === pilotId && decision.observation.time <= time + 1e-6)
    .sort((a, b) => b.observation.time - a.observation.time || b.turn - a.turn)[0];
}

function actionSummary(action: Action): string {
  if (action.kind === "motor-program") {
    const weapons = action.heldActions.find((held) => held.kind === "weapons_free");
    return `motor-program ${action.durationMs}ms/${action.sampleDtMs}ms samples=${action.samples.length} weapons_free=${weapons ? `${weapons.coneDeg ?? "?"}deg/${weapons.rangeM ?? "?"}m` : "none"}`;
  }
  if (action.kind === "pilot-intent") {
    return `pilot-intent ${action.goal} urgency=${action.urgency.toFixed(2)} style=${action.style}`;
  }
  return action.kind;
}

function pilotTalkContext(decision: TurnDecision, pilotLabel: string): string {
  return [
    `Pilot model: ${pilotLabel}`,
    `Turn: ${decision.turn}`,
    `Last action: ${actionSummary(decision.action)}`,
    decision.rationale ? `Rationale: ${decision.rationale}` : undefined,
    decision.observation.text ? `Observation text:\n${decision.observation.text}` : undefined,
  ].filter(Boolean).join("\n\n");
}

function bodyTalkContext(promptText: string, rawOutput: string, bodyLabel: string): string {
  return [`Body model: ${bodyLabel}`, `Last prompt:\n${promptText}`, `Last output:\n${rawOutput}`].join("\n\n");
}

function clampTime(time: number, durationSeconds: number): number {
  if (!Number.isFinite(time)) return durationSeconds;
  return Math.max(0, Math.min(durationSeconds, time));
}

function stringConfig(config: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = config?.[key];
  return typeof value === "string" ? value : undefined;
}
