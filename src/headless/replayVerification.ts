import type { BodyTickTrace, MatchReplay, TurnDecision } from "../protocol/schema";

export const DEFAULT_VERIFICATION_PILOT_ID = "blue-1";

type BodyStatus = BodyTickTrace["parsed"]["status"];

export interface ReplayVerificationSummary {
  pilotId: string;
  pilotLabel?: string;
  bodyModel?: string;
  pilotDecisionCount: number;
  pilotControllerDecisions: number;
  pilotFallbacks: number;
  pilotIntentDecisions: number;
  bodyTickCount: number;
  bodyParseableTicks: number;
  bodyFailedTicks: number;
  bodyModelErrors: number;
  bodyStatusCounts: Record<BodyStatus, number>;
  pilotCostUsd: number;
  bodyCostUsd: number;
  totalCostUsd: number;
  bodyMeanLatencyMs?: number;
  llmEnsembleReady: boolean;
  errors: string[];
}

const BODY_STATUSES: BodyStatus[] = ["ok", "clipped", "degraded", "failed"];

function usageCost(items: { usage?: { costUsd: number } }[]): number {
  return items.reduce((sum, item) => sum + (item.usage?.costUsd ?? 0), 0);
}

function asConfigValue(config: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = config?.[key];
  return typeof value === "string" ? value : undefined;
}

function mean(values: number[]): number | undefined {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : undefined;
}

function pilotDecisions(replay: MatchReplay, pilotId: string): TurnDecision[] {
  return (replay.decisions ?? []).filter((decision) => decision.agentId === pilotId);
}

function pilotBodyTicks(replay: MatchReplay, pilotId: string): BodyTickTrace[] {
  return (replay.bodyTicks ?? []).filter((tick) => tick.agentId === pilotId);
}

export function summarizeReplayVerification(
  replay: MatchReplay,
  pilotId = DEFAULT_VERIFICATION_PILOT_ID,
): ReplayVerificationSummary {
  const pilot = replay.agents?.find((agent) => agent.id === pilotId);
  const decisions = pilotDecisions(replay, pilotId);
  const bodyTicks = pilotBodyTicks(replay, pilotId);
  const statusCounts: Record<BodyStatus, number> = {
    ok: 0,
    clipped: 0,
    degraded: 0,
    failed: 0,
  };
  for (const tick of bodyTicks) statusCounts[tick.parsed.status] += 1;

  const pilotControllerDecisions = decisions.filter((decision) => decision.source === "controller").length;
  const pilotFallbacks = decisions.filter((decision) => decision.source === "fallback").length;
  const pilotIntentDecisions = decisions.filter((decision) => decision.action.kind === "pilot-intent").length;
  const bodyFailedTicks = statusCounts.failed;
  const bodyModelErrors = bodyTicks.filter((tick) => tick.modelError).length;
  const bodyParseableTicks = bodyTicks.length - bodyFailedTicks;
  const bodyModel = asConfigValue(pilot?.config, "bodyModel");
  const pilotCostUsd = usageCost(decisions);
  const bodyCostUsd = usageCost(bodyTicks);
  const latencies = bodyTicks
    .map((tick) => tick.latencyMs)
    .filter((latency): latency is number => latency !== undefined);

  const errors: string[] = [];
  if (!pilot) errors.push(`missing pilot agent ${pilotId}`);
  if (pilot && pilot.kind !== "llm") errors.push(`pilot agent ${pilotId} is ${pilot.kind}, not llm`);
  if (decisions.length === 0) errors.push(`pilot agent ${pilotId} has no decisions`);
  if (pilotFallbacks > 0) errors.push(`pilot used fallback on ${pilotFallbacks}/${decisions.length} decisions`);
  if (pilotIntentDecisions !== decisions.length) {
    errors.push(`pilot produced ${pilotIntentDecisions}/${decisions.length} pilot-intent decisions`);
  }
  if (bodyTicks.length === 0) errors.push(`pilot agent ${pilotId} has no Body ticks`);
  if (!bodyModel) errors.push(`pilot agent ${pilotId} has no recorded Body model`);
  if (bodyModel === "scripted") errors.push("Body model is scripted, not a live LLM");
  if (bodyFailedTicks > 0) errors.push(`Body parser failed on ${bodyFailedTicks}/${bodyTicks.length} ticks`);
  if (bodyModelErrors > 0) errors.push(`Body model errored on ${bodyModelErrors}/${bodyTicks.length} ticks`);
  if (bodyTicks.length > 0 && !bodyTicks.some((tick) => tick.usage)) {
    errors.push("Body ticks have no usage records, so live model execution is unproven");
  }

  return {
    pilotId,
    ...(pilot?.label ? { pilotLabel: pilot.label } : {}),
    ...(bodyModel ? { bodyModel } : {}),
    pilotDecisionCount: decisions.length,
    pilotControllerDecisions,
    pilotFallbacks,
    pilotIntentDecisions,
    bodyTickCount: bodyTicks.length,
    bodyParseableTicks,
    bodyFailedTicks,
    bodyModelErrors,
    bodyStatusCounts: statusCounts,
    pilotCostUsd,
    bodyCostUsd,
    totalCostUsd: pilotCostUsd + bodyCostUsd,
    ...(latencies.length ? { bodyMeanLatencyMs: mean(latencies) } : {}),
    llmEnsembleReady: errors.length === 0,
    errors,
  };
}

function statusText(statusCounts: Record<BodyStatus, number>): string {
  return BODY_STATUSES.filter((status) => statusCounts[status] > 0)
    .map((status) => `${status}=${statusCounts[status]}`)
    .join(" ");
}

export function formatReplayVerification(summary: ReplayVerificationSummary): string {
  const lines = [
    `pilot=${summary.pilotLabel ?? summary.pilotId} controller=${summary.pilotControllerDecisions}/${summary.pilotDecisionCount} ` +
      `intent=${summary.pilotIntentDecisions}/${summary.pilotDecisionCount} fallbacks=${summary.pilotFallbacks}`,
    `body=${summary.bodyModel ?? "unknown"} parseable=${summary.bodyParseableTicks}/${summary.bodyTickCount} ` +
      `${statusText(summary.bodyStatusCounts) || "no-status"} modelErrors=${summary.bodyModelErrors}`,
    `cost=$${summary.totalCostUsd.toFixed(4)} pilot=$${summary.pilotCostUsd.toFixed(4)} body=$${summary.bodyCostUsd.toFixed(4)}` +
      (summary.bodyMeanLatencyMs !== undefined
        ? ` bodyMeanLatency=${Math.round(summary.bodyMeanLatencyMs)}ms`
        : ""),
    summary.llmEnsembleReady ? "verification=llm-ensemble-ready" : "verification=not-ensemble-ready",
  ];
  if (!summary.llmEnsembleReady) {
    lines.push(...summary.errors.map((error) => `  - ${error}`));
  }
  return lines.join("\n");
}
