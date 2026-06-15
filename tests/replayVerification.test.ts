import { describe, expect, it } from "vitest";
import type { MatchReplay } from "../src/protocol/schema";
import { formatReplayVerification, summarizeReplayVerification } from "../src/headless/replayVerification";

function replayWith(overrides: Record<string, unknown> = {}): MatchReplay {
  return {
    id: "test",
    turnDuration: 2.4,
    frameDt: 0.16,
    frames: [],
    ...overrides,
  } as unknown as MatchReplay;
}

describe("replay verification", () => {
  it("accepts a live pilot-intent plus live Body replay", () => {
    const summary = summarizeReplayVerification(
      replayWith({
        agents: [
          {
            id: "blue-1",
            kind: "llm",
            label: "deepseek/deepseek-v4-flash/pilot-intent",
            config: { bodyModel: "deepseek/deepseek-v4-flash" },
          },
        ],
        decisions: [
          {
            agentId: "blue-1",
            source: "controller",
            action: { kind: "pilot-intent" },
            usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.001 },
          },
        ],
        bodyTicks: [
          {
            agentId: "blue-1",
            parsed: { status: "ok" },
            usage: { inputTokens: 20, outputTokens: 8, costUsd: 0.002 },
            latencyMs: 1200,
          },
          {
            agentId: "blue-1",
            parsed: { status: "degraded" },
            usage: { inputTokens: 22, outputTokens: 7, costUsd: 0.0022 },
            latencyMs: 800,
          },
        ],
      }),
    );

    expect(summary.llmEnsembleReady).toBe(true);
    expect(summary.bodyParseableTicks).toBe(2);
    expect(summary.totalCostUsd).toBeCloseTo(0.0052);
    expect(summary.bodyMeanLatencyMs).toBe(1000);
    expect(formatReplayVerification(summary)).toContain("verification=llm-ensemble-ready");
  });

  it("rejects fallback, scripted, and failed Body traces", () => {
    const summary = summarizeReplayVerification(
      replayWith({
        agents: [
          {
            id: "blue-1",
            kind: "llm",
            label: "scripted-body",
            config: { bodyModel: "scripted" },
          },
        ],
        decisions: [
          {
            agentId: "blue-1",
            source: "fallback",
            action: { kind: "flight-director" },
          },
        ],
        bodyTicks: [
          {
            agentId: "blue-1",
            parsed: { status: "failed" },
            modelError: "provider down",
          },
        ],
      }),
    );

    expect(summary.llmEnsembleReady).toBe(false);
    expect(summary.errors).toContain("Body model is scripted, not a live LLM");
    expect(summary.errors).toContain("Body parser failed on 1/1 ticks");
    expect(summary.errors).toContain("pilot used fallback on 1/1 decisions");
    expect(formatReplayVerification(summary)).toContain("verification=not-ensemble-ready");
  });
});
