import { describe, expect, it } from "vitest";
import type { Controller } from "../src/agent/controller";
import { perfectSensor } from "../src/agent/observation";
import { minimalEvaluator } from "../src/eval/outcome";
import type { Observation } from "../src/protocol/schema";
import { createAgentMessageBus } from "../src/runtime/comms";
import type { MatchConfig, MatchProgress } from "../src/runtime/config";
import { startLiveMatch } from "../src/runtime/live";
import { runMatch } from "../src/runtime/match";
import { createPhysicsCoachProvider } from "../src/runtime/physicsCoach";
import { FRAME_DT, createInitialAircraft } from "../src/runtime/scenario";
import { compassBearingDeg, compassPoint } from "../src/runtime/navigation";

function rawStickController(onObservation?: (observation: Observation) => void): Controller {
  return async (observation) => {
    onObservation?.(observation);
    return {
      action: {
        kind: "raw-stick",
        pitch: 0,
        roll: 0,
        yaw: 0,
        throttle: 0.8,
        trigger: false,
      },
      rationale: "hold attitude",
    };
  };
}

function configFor(onBlueObservation?: (observation: Observation) => void): MatchConfig {
  const aircraft = createInitialAircraft();
  return {
    id: "comms-test",
    turnDuration: FRAME_DT,
    frameDt: FRAME_DT,
    maxTurns: 1,
    decisionTimeoutMs: 1_000,
    initialAircraft: aircraft,
    sensor: perfectSensor,
    evaluator: minimalEvaluator,
    fallback: () => ({
      kind: "raw-stick",
      pitch: 0,
      roll: 0,
      yaw: 0,
      throttle: 0.8,
      trigger: false,
    }),
    agents: {
      "blue-1": {
        meta: { id: "blue-1", kind: "scripted", label: "blue test" },
        controller: rawStickController(onBlueObservation),
      },
      "red-1": {
        meta: { id: "red-1", kind: "scripted", label: "red test" },
        controller: rawStickController(),
      },
    },
  };
}

describe("agent comms and navigation", () => {
  it("uses compass bearings consistent with the local-world navigation frame", () => {
    expect(compassBearingDeg({ x: 0, z: -1 })).toBeCloseTo(0);
    expect(compassBearingDeg({ x: 1, z: 0 })).toBeCloseTo(90);
    expect(compassBearingDeg({ x: 0, z: 1 })).toBeCloseTo(180);
    expect(compassPoint(315)).toBe("NW");
  });

  it("pipes queued messages into the pilot observation, progress stream, and replay", async () => {
    const bus = createAgentMessageBus();
    bus.send({
      id: "operator-turn-north",
      from: "operator",
      to: "blue-1",
      channel: "operator",
      priority: "priority",
      content: "Turn north and hold energy.",
      includeNavigation: true,
    });
    let observation: Observation | undefined;
    const progress: MatchProgress[] = [];

    const replay = await runMatch({
      ...configFor((seen) => {
        observation = seen;
      }),
      comms: { buses: [bus] },
      onProgress(event) {
        progress.push(event);
      },
    });

    expect(observation?.comms?.[0]).toMatchObject({
      from: "operator",
      to: "blue-1",
      channel: "operator",
      content: "Turn north and hold energy.",
    });
    expect(observation?.messages?.[0]).toContain("Turn north");
    expect(observation?.comms?.[0]?.navigation?.self.headingDeg).toBeTypeOf("number");
    expect(progress.some((event) => event.phase === "message" && event.message?.id.startsWith("operator-turn-north"))).toBe(true);
    expect(replay.schemaVersion).toBe(6);
    expect(replay.comms?.[0]?.content).toBe("Turn north and hold energy.");
  });

  it("lets a live watcher inject a message before the next agent decision", async () => {
    let observation: Observation | undefined;
    const session = startLiveMatch(configFor((seen) => {
      observation = seen;
    }), { preDecisionMessageWindowMs: 20 });

    session.sendMessage({
      id: "gci-vector",
      from: "GCI",
      to: "blue-1",
      channel: "gci",
      content: "Vector 315, intercept hot contact.",
    });

    const phases: string[] = [];
    for await (const event of session.progress) phases.push(event.phase);
    const replay = await session.done;

    expect(phases).toContain("turn_start");
    expect(phases).toContain("message");
    expect(observation?.comms?.[0]?.content).toContain("Vector 315");
    expect(replay.comms?.[0]?.channel).toBe("gci");
  });

  it("can coach the next decision from recorded physics history", async () => {
    const seen: Observation[] = [];
    const replay = await runMatch({
      ...configFor((observation) => {
        if (observation.selfId === "blue-1") seen.push(observation);
      }),
      maxTurns: 2,
      comms: {
        providers: [createPhysicsCoachProvider({ agentId: "blue-1", targetId: "red-1" })],
      },
    });

    const coach = replay.comms?.find((message) => message.channel === "coach");
    expect(coach?.turn).toBe(2);
    expect(coach?.content).toContain("Physics coach after turn 1");
    expect(coach?.content).toContain("last tape");
    expect(coach?.content).toContain("peakG");
    expect(seen[1]?.comms?.some((message) => message.channel === "coach")).toBe(true);
    expect(seen[1]?.messages?.some((message) => message.includes("Physics coach after turn 1"))).toBe(true);
  });
});
