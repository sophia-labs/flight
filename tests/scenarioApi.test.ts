import { describe, expect, it } from "vitest";
import { buildServerScenarioMatchConfig, stepScenarioRoundApiRequest } from "../src/server/scenarioRun";
import { inspectScenarioReplay } from "../src/server/scenarioAgent";
import {
  ScenarioDebriefRequestSchema,
  debriefScenarioReplay,
} from "../src/server/scenarioDebrief";
import { buildDebriefGrounding } from "../src/server/debriefContext";
import { aircraftArchetypes } from "../src/sim/aircraftCatalog";
import type { AircraftSnapshot, MatchReplay } from "../src/protocol/schema";
import { toObservation } from "../src/agent/observation";
import { navigationFixForAgent } from "../src/runtime/navigation";

describe("scenario API config builder", () => {
  it("builds a selected-aircraft live pilot/body match without exposing browser secrets", () => {
    const originalOpenRouter = process.env.OPENROUTER_API_KEY;
    const tomcat = aircraftArchetypes.find((candidate) => candidate.id === "variable-sweep-tomcat")!;
    process.env.OPENROUTER_API_KEY = "test-key";

    try {
      const config = buildServerScenarioMatchConfig(tomcat.airframe, {
        schemaVersion: 1,
        kind: "stern-gun",
        pilotModel: "deepseek/deepseek-v4-flash",
        bodyModel: "deepseek/deepseek-v4-flash",
        turnCount: 1,
        cameraMode: "pilot-cinema",
      });

      expect(config.maxTurns).toBe(1);
      expect(config.initialAircraft[0]?.airframe).toEqual(tomcat.airframe);
      expect(config.agents["blue-1"]?.meta).toMatchObject({
        kind: "llm",
        config: { bodyModel: "deepseek/deepseek-v4-flash" },
      });
      expect(config.id).toContain("stern-gun");
      expect(config.id).toContain("turns:1");
    } finally {
      if (originalOpenRouter === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = originalOpenRouter;
    }
  });

  it("builds a hard-balloon motor-program planner with a reflex twitch Body", () => {
    const originalDeepSeek = process.env.DEEPSEEK_API_KEY;
    const tomcat = aircraftArchetypes.find((candidate) => candidate.id === "variable-sweep-tomcat")!;
    process.env.DEEPSEEK_API_KEY = "test-key";

    try {
      const config = buildServerScenarioMatchConfig(tomcat.airframe, {
        schemaVersion: 1,
        kind: "balloon-hard",
        controlMode: "motor-program",
        pilotModel: "deepseek-v4-pro",
        bodyModel: "scripted-fixed-wing-body",
        twitchBodyModel: "deepseek-v4-flash",
        turnCount: 4,
        motorProgramTurnMs: 2_500,
        motorProgramSampleMs: 50,
        twitchTimeScale: 0.35,
        cameraMode: "pilot-cinema",
      });

      expect(config.turnDuration).toBe(2.5);
      expect(config.frameDt).toBe(0.05);
      expect(config.initialAircraft.map((ship) => ship.id)).toContain("balloon");
      expect(config.agents["blue-1"]?.body).toBeUndefined();
      expect(config.agents["blue-1"]?.reflexBody).toBeDefined();
      expect(config.agents["blue-1"]?.reflexPlaybackTimeScale).toBe(0.35);
      expect(config.agents["blue-1"]?.meta).toMatchObject({
        kind: "llm",
        label: "deepseek-v4-pro/motor-program",
        config: {
          controlMode: "motor-program",
          twitchBodyModel: "deepseek-v4-flash",
          motorProgramTurnMs: 2500,
          motorProgramSampleMs: 50,
        },
      });
    } finally {
      if (originalDeepSeek === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = originalDeepSeek;
    }
  });

  it("builds BVR intercept as a live radar-limited GPS pilot scenario", async () => {
    const originalDeepSeek = process.env.DEEPSEEK_API_KEY;
    const tomcat = aircraftArchetypes.find((candidate) => candidate.id === "variable-sweep-tomcat")!;
    process.env.DEEPSEEK_API_KEY = "test-key";

    try {
      const config = buildServerScenarioMatchConfig(tomcat.airframe, {
        schemaVersion: 1,
        kind: "bvr-intercept",
        controlMode: "body-pilot",
        pilotModel: "scripted-body-pilot",
        bodyModel: "scripted-fixed-wing-body",
        turnCount: 12,
        cameraMode: "pilot-cinema",
      });

      expect(config.id).toContain("bvr-intercept");
      expect(config.initialAircraft.map((ship) => ship.id)).toEqual(["blue-1", "prop-1"]);
      expect(config.initialAircraft[0]?.airframe).toEqual(tomcat.airframe);
      expect(config.agents["blue-1"]?.meta).toMatchObject({
        kind: "llm",
        label: "deepseek-v4-pro/pilot-intent",
      });
      const blue = config.initialAircraft[0]!;
      const observation = toObservation(
        blue,
        config.initialAircraft,
        1,
        0,
        config.agents["blue-1"]?.sensor ?? config.sensor,
      );
      const navigation = navigationFixForAgent(blue, config.initialAircraft, observation.contacts);
      const messages = await Promise.resolve(config.comms?.providers?.[0]?.({
        turn: 1,
        time: 0,
        agentId: "blue-1",
        allAgentIds: ["blue-1", "prop-1"],
        self: blue,
        world: config.initialAircraft,
        observation,
        contacts: observation.contacts,
        navigation,
      }) ?? []);
      expect(messages[0]).toMatchObject({
        from: "GCI",
        to: "blue-1",
        channel: "gci",
        content: expect.stringContaining("last GPS"),
        navigation: {
          waypoints: [
            expect.objectContaining({
              id: "bvr-target-datum",
              gps: expect.objectContaining({ lat: expect.any(Number), lon: expect.any(Number) }),
              bearingDeg: expect.any(Number),
            }),
          ],
        },
      });

      const radarContacts = config.agents["blue-1"]?.sensor?.detect(config.initialAircraft, blue) ?? [];
      expect(radarContacts.map((contact) => contact.target.id)).toEqual([]);

      // The match-level default sensor must not leak perfect omniscience into BVR agents.
      expect(config.sensor.detect(config.initialAircraft, blue)).toEqual([]);
    } finally {
      if (originalDeepSeek === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = originalDeepSeek;
    }
  });

  it("steps a scenario one agent round at a time and records operator messages", async () => {
    const tomcat = aircraftArchetypes.find((candidate) => candidate.id === "variable-sweep-tomcat")!;
    const request = {
      airframe: tomcat.airframe,
      scenario: {
        schemaVersion: 1 as const,
        kind: "stern-gun" as const,
        controlMode: "body-pilot" as const,
        pilotModel: "scripted-body-pilot",
        bodyModel: "scripted-fixed-wing-body",
        turnCount: 2,
        cameraMode: "pilot-cinema" as const,
      },
    };

    const first = await stepScenarioRoundApiRequest({
      ...request,
      message: { content: "Hold the tally and wait for a clean shot.", to: "blue-1" },
    });

    expect(first.turn).toBe(1);
    expect(first.complete).toBe(false);
    expect(first.replay.frames.length).toBeGreaterThan(1);
    expect(first.replay.comms?.[0]).toMatchObject({
      to: "blue-1",
      channel: "operator",
      content: "Hold the tally and wait for a clean shot.",
    });

    const second = await stepScenarioRoundApiRequest({
      ...request,
      sessionId: first.sessionId,
    });

    expect(second.sessionId).toBe(first.sessionId);
    expect(second.turn).toBe(2);
    expect(second.complete).toBe(true);
    expect(second.replay.outcome).toBeDefined();
    expect(second.replay.frames.length).toBeGreaterThan(first.replay.frames.length);
  });

  it("summarizes replay phase state for agent monitoring", () => {
    const summary = inspectScenarioReplay(agentReplay(), { pilotId: "blue-1", time: 1.2 });

    expect(summary.activePhase).toMatchObject({ mode: "twitch", timeScale: 0.35 });
    expect(summary.phaseCounts).toEqual({ planner: 1, body: 0, twitch: 1 });
    expect(summary.pilot.lastDecision?.action).toContain("motor-program");
    expect(summary.pilot.context).toContain("Observation text");
    expect(summary.frameIndex).toBe(1);
  });
});

describe("scenario debrief (talk to pilot)", () => {
  it("validates the request and applies defaults", () => {
    const parsed = ScenarioDebriefRequestSchema.parse({
      replay: balloonReplay(),
      messages: [{ role: "user", content: "did you overshoot?" }],
    });
    expect(parsed.pilotId).toBe("blue-1");
    expect(parsed.model).toBe("deepseek-v4-pro");
    expect(parsed.messages).toHaveLength(1);

    // Rejects malformed conversation entries.
    expect(() =>
      ScenarioDebriefRequestSchema.parse({
        replay: balloonReplay(),
        messages: [{ role: "narrator", content: "nope" }],
      }),
    ).toThrow();
    // Rejects an empty message body.
    expect(() =>
      ScenarioDebriefRequestSchema.parse({
        replay: balloonReplay(),
        messages: [{ role: "user", content: "" }],
      }),
    ).toThrow();
  });

  it("extracts grounded per-turn flight truth from a replay", () => {
    const grounding = buildDebriefGrounding(balloonReplay(), { pilotId: "blue-1" });
    expect(grounding.targetId).toBe("balloon");
    expect(grounding.turnTruth).toHaveLength(2);
    // Turn 2 dives and pulls harder than turn 1, and the balloon passes behind the nose.
    expect(grounding.peakG?.turn).toBe(2);
    expect(grounding.minAlt?.turn).toBe(2);
    expect(grounding.overshootTurn).toBe(2);
    // The trace surfaces what the pilot SAW, COMMANDED, and what ACTUALLY happened.
    const joined = grounding.traceLines.join("\n");
    expect(joined).toContain("SAW");
    expect(joined).toContain("COMMANDED");
    expect(joined).toContain("OVERSHOT");
    expect(joined).toContain("close the gap"); // the recorded rationale
  });

  it("holds a scripted, key-free debrief turn grounded only in the evidence", async () => {
    const response = await debriefScenarioReplay(balloonReplay(), {
      model: "scripted-debrief",
      messages: [{ role: "user", content: "Did you overshoot the balloon?" }],
    });

    expect(response.scripted).toBe(true);
    expect(response.model).toBe("scripted-debrief");
    expect(response.usage).toBeUndefined();
    expect(response.pilotLabel).toBe("deepseek-v4-pro/motor-program");
    expect(response.grounding.turns).toBe(2);
    expect(response.grounding.overshootTurn).toBe(2);
    // The reply is built only from the trace: it must mention the recorded overshoot turn.
    expect(response.reply).toContain("overshot on turn 2");
    expect(response.reply).toContain("Did you overshoot the balloon?");
  });

  it("admits ignorance when the replay has no per-turn decisions", async () => {
    const bare = balloonReplay();
    bare.decisions = [];
    const response = await debriefScenarioReplay(bare, { model: "scripted-debrief", messages: [] });
    // Still grounded: it reports flight truth from frames but does not invent decisions.
    expect(response.reply).toContain("scripted debrief");
    expect(response.grounding.turns).toBe(2);
  });
});

function snapshot(
  id: string,
  team: "blue" | "red",
  pos: { x: number; y: number; z: number },
  extra: Partial<AircraftSnapshot> = {},
): AircraftSnapshot {
  return {
    id,
    callsign: id,
    team,
    color: team === "blue" ? "#4da3ff" : "#ff5d5d",
    position: pos,
    velocity: { x: 0, y: 0, z: 0 },
    // Identity orientation => forward is -Z in this sim's basis.
    orientation: { x: 0, y: 0, z: 0, w: 1 },
    controls: { pitch: 0, roll: 0, yaw: 0, throttle: 0.9, trigger: false },
    airspeed: 180,
    altitude: pos.y,
    aoaDeg: 4,
    gLoad: 1,
    health: 100,
    weaponCooldown: 0,
    stalled: false,
    ...extra,
  };
}

// A two-turn hard-balloon replay with real physics frames so per-turn truth (peak G, min alt, overshoot)
// can be reconstructed. Turn 1: a clean closing pass with the balloon ahead. Turn 2: a hard low reversal
// where the balloon ends up BEHIND the nose (an overshoot) and altitude drops.
function balloonReplay(): MatchReplay {
  const balloon = { x: 0, y: 1000, z: -2000 };
  return {
    id: "debrief-test-replay",
    schemaVersion: 5,
    turnDuration: 2.5,
    frameDt: 0.05,
    frames: [
      // turn 1: balloon dead ahead (-Z), high G modest, altitude high
      {
        index: 0,
        time: 0,
        turn: 1,
        aircraft: [
          snapshot("blue-1", "blue", { x: 0, y: 1000, z: 0 }, { gLoad: 2, altitude: 1000 }),
          snapshot("balloon", "red", balloon, { static: true, gLoad: 0 }),
        ],
        events: [],
      },
      {
        index: 1,
        time: 1.2,
        turn: 1,
        aircraft: [
          snapshot("blue-1", "blue", { x: 0, y: 980, z: -800 }, { gLoad: 3, altitude: 980 }),
          snapshot("balloon", "red", balloon, { static: true, gLoad: 0 }),
        ],
        events: [],
      },
      // turn 2: blue overshoots PAST the balloon (now at +Z relative => behind the nose) and dives low
      {
        index: 2,
        time: 2.5,
        turn: 2,
        aircraft: [
          snapshot("blue-1", "blue", { x: 0, y: 400, z: -2600 }, { gLoad: 7, altitude: 400, aoaDeg: 18 }),
          snapshot("balloon", "red", balloon, { static: true, gLoad: 0 }),
        ],
        events: [],
      },
      {
        index: 3,
        time: 3.7,
        turn: 2,
        aircraft: [
          snapshot("blue-1", "blue", { x: 0, y: 200, z: -2900 }, { gLoad: 8, altitude: 200, aoaDeg: 22 }),
          snapshot("balloon", "red", balloon, { static: true, gLoad: 0 }),
        ],
        events: [],
      },
    ],
    agents: [
      {
        id: "blue-1",
        kind: "llm",
        label: "deepseek-v4-pro/motor-program",
        config: { controlMode: "motor-program", twitchBodyModel: "deepseek-v4-flash" },
      },
    ],
    agentPhases: [
      { agentId: "blue-1", turn: 1, mode: "planner", startTime: 0, endTime: 2.5, model: "deepseek-v4-pro" },
      { agentId: "blue-1", turn: 2, mode: "planner", startTime: 2.5, endTime: 5, model: "deepseek-v4-pro" },
    ],
    decisions: [
      decision(1, 0, "close the gap on the balloon, keep it on the nose"),
      decision(2, 2.5, "pull hard to bring the nose back around after the pass"),
    ],
    outcome: {
      resolved: true,
      reason: "timeout",
      winnerTeam: null,
      turnsRun: 2,
      scores: { blue: { damageDealt: 0, damageTaken: 0, survived: true } },
      finalHealth: { "blue-1": 100, balloon: 100 },
      competence: {
        "blue-1": {
          survived: true,
          damageDealt: 0,
          damageTaken: 0,
          shots: 0,
          hits: 0,
          fracStalled: 0,
          fracOnDeck: 0.25,
          minAltitude: 200,
          meanAirspeed: 180,
          energyRetainedRatio: 0.7,
          controlSmoothness: 0.8,
        },
      },
    },
  };
}

function decision(turn: number, time: number, rationale: string) {
  return {
    turn,
    agentId: "blue-1",
    observation: {
      schemaVersion: 1 as const,
      selfId: "blue-1",
      turn,
      time,
      self: {
        airspeed: 180,
        altitude: turn === 1 ? 1000 : 400,
        aoaDeg: turn === 1 ? 4 : 18,
        gLoad: turn === 1 ? 2 : 7,
        health: 100,
        weaponCooldown: 0,
        stalled: false,
      },
      contacts: [
        {
          id: "balloon",
          team: "red" as const,
          range: turn === 1 ? 2000 : 600,
          bearingForward: turn === 1 ? 0.98 : -0.4,
          bearingRight: 0,
          bearingUp: turn === 1 ? 0.05 : 0.6,
          closureRate: turn === 1 ? -300 : 120,
          health: 100,
          balloon: true,
        },
      ],
      text: "VISUAL camera-ascii@2 cockpit field.\n+",
    },
    action: {
      kind: "motor-program" as const,
      durationMs: 2500,
      sampleDtMs: 50,
      samples: [
        { tMs: 0, pitch: 0, roll: 0, yaw: 0, throttle: 0.95, trigger: false },
        { tMs: 2500, pitch: turn === 1 ? 0.1 : 0.6, roll: 0, yaw: 0, throttle: 1, trigger: false },
      ],
      heldActions: [
        { kind: "weapons_free" as const, condition: "target_in_forward_gun_cone", coneDeg: 12, rangeM: 2350 },
      ],
    },
    controlInput: { pitch: 0, roll: 0, yaw: 0, throttle: 0.95, trigger: false },
    source: "controller" as const,
    rationale,
  };
}

function agentReplay(): MatchReplay {
  return {
    id: "agent-monitor-test",
    schemaVersion: 5,
    turnDuration: 2.5,
    frameDt: 0.05,
    frames: [
      { index: 0, time: 0, turn: 1, aircraft: [], events: [] },
      { index: 1, time: 1.2, turn: 1, aircraft: [], events: [] },
    ],
    agents: [
      {
        id: "blue-1",
        kind: "llm",
        label: "deepseek-v4-pro/motor-program",
        config: { controlMode: "motor-program", twitchBodyModel: "deepseek-v4-flash" },
      },
    ],
    agentPhases: [
      {
        agentId: "blue-1",
        turn: 1,
        mode: "planner",
        startTime: 0,
        endTime: 2.5,
        model: "deepseek-v4-pro/motor-program",
        reason: "motor-program tape",
      },
      {
        agentId: "blue-1",
        turn: 1,
        mode: "twitch",
        startTime: 1,
        endTime: 1.45,
        timeScale: 0.35,
        model: "deepseek-v4-flash",
        reason: "target_in_forward_gun_cone",
      },
    ],
    decisions: [
      {
        turn: 1,
        agentId: "blue-1",
        observation: {
          schemaVersion: 1,
          selfId: "blue-1",
          turn: 1,
          time: 0,
          self: {
            airspeed: 160,
            altitude: 1200,
            aoaDeg: 2,
            gLoad: 1,
            health: 100,
            weaponCooldown: 0,
            stalled: false,
          },
          contacts: [],
          text: "VISUAL camera-ascii@2 cockpit field.\n+",
        },
        action: {
          kind: "motor-program",
          durationMs: 2500,
          sampleDtMs: 50,
          samples: [
            { tMs: 0, pitch: 0, roll: 0, yaw: 0, throttle: 0.9, trigger: false },
            { tMs: 2500, pitch: 0.1, roll: 0.2, yaw: 0, throttle: 0.95, trigger: false },
          ],
          heldActions: [
            {
              kind: "weapons_free",
              condition: "target_in_forward_gun_cone",
              coneDeg: 12,
              rangeM: 2350,
            },
          ],
        },
        controlInput: { pitch: 0, roll: 0, yaw: 0, throttle: 0.9, trigger: false },
        source: "controller",
        rationale: "smooth intercept",
      },
    ],
  };
}
