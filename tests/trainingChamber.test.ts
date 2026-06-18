import { describe, expect, it } from "vitest";
import { runTrainingChamber } from "../src/training/chamber";
import type { GardenMcpConnection, FetchLike } from "../src/garden/client";
import type { AircraftSnapshot, MatchReplay } from "../src/protocol/schema";
import type { MatchConfig } from "../src/runtime/config";
import { aircraftArchetypes } from "../src/sim/aircraftCatalog";

describe("training chamber", () => {
  it("flies, journals, reflects, and carries Garden current-state into the next sortie", async () => {
    const garden = fakeGarden();
    const tomcat = aircraftArchetypes.find((candidate) => candidate.id === "variable-sweep-tomcat")!;
    const briefings: string[] = [];

    const result = await runTrainingChamber({
      airframe: tomcat.airframe,
      connection: garden.connection,
      sorties: 2,
      runId: "test-run",
      reflectionModel: "scripted-debrief",
      scenario: {
        schemaVersion: 1,
        kind: "stern-gun",
        controlMode: "body-pilot",
        pilotModel: "scripted-body-pilot",
        bodyModel: "scripted-fixed-wing-body",
        turnCount: 1,
        cameraMode: "pilot-cinema",
      },
      async runSortie({ sortieIndex, config }) {
        const briefingProvider = config.comms?.providers?.at(-1);
        const drafts = await briefingProvider?.({
          turn: 1,
          time: 0,
          agentId: "blue-1",
          allAgentIds: ["blue-1"],
          self: {} as never,
          world: [],
          observation: {} as never,
          contacts: [],
          navigation: { self: { altitudeM: 1000 }, contacts: [] },
        });
        briefings.push(drafts?.[0]?.content ?? "");
        return replayFixture(`chamber-replay-${sortieIndex}`, sortieIndex);
      },
    });

    expect(result.sorties).toHaveLength(2);
    expect(result.runId).toBe("test-run");
    expect(result.currentStateDocumentId).toBe("flight-pilot-blue-1-current-state");
    expect(result.sorties[0]?.reflection.scripted).toBe(true);
    expect(result.sorties[1]?.reflection.scripted).toBe(true);

    expect(briefings[0]).toContain("No prior current-state");
    expect(briefings[1]).toContain("Latest Pilot Reflection");
    expect(briefings[1]).toContain("chamber-replay-1");

    const currentState = garden.documents.get(result.currentStateDocumentId);
    expect(currentState).toContain("Sortie index: 2");
    expect(currentState).toContain("Latest Pilot Reflection");
    expect(currentState).toContain("Next Briefing Delta");

    const documentIds = [...garden.documents.keys()];
    expect(documentIds.filter((id) => id.startsWith("flight-sortie-blue-1-"))).toHaveLength(2);
    expect(documentIds.filter((id) => id.startsWith("flight-reflection-blue-1-"))).toHaveLength(2);
  });

  it("can run a positive AoA/load drill as a one-aircraft Garden training sortie", async () => {
    const garden = fakeGarden();
    const tomcat = aircraftArchetypes.find((candidate) => candidate.id === "variable-sweep-tomcat")!;
    const configs: MatchConfig[] = [];
    const firstTurnMessages: string[] = [];

    const result = await runTrainingChamber({
      airframe: tomcat.airframe,
      connection: garden.connection,
      sorties: 1,
      runId: "test-drill-run",
      reflectionModel: "scripted-debrief",
      scenario: {
        schemaVersion: 1,
        kind: "bvr-intercept",
        controlMode: "motor-program",
        pilotModel: "scripted-positive-aoa-load",
        bodyModel: "scripted-fixed-wing-body",
        twitchBodyModel: "scripted-fixed-wing-body",
        turnCount: 1,
        motorProgramTurnMs: 2500,
        motorProgramSampleMs: 50,
        twitchTimeScale: 0.35,
        cameraMode: "pilot-cinema",
      },
      drill: {
        kind: "positive-aoa-load",
        pilotModel: "scripted-positive-aoa-load",
        turnCount: 1,
      },
      async runSortie({ config }) {
        configs.push(config);
        const drafts = await Promise.all(
          (config.comms?.providers ?? []).map((provider) =>
            provider({
              turn: 1,
              time: 0,
              agentId: "blue-1",
              allAgentIds: ["blue-1"],
              self: config.initialAircraft[0]!,
              world: config.initialAircraft,
              observation: {} as never,
              contacts: [],
              navigation: { self: { altitudeM: 6000 }, contacts: [] },
              history: { frames: [], decisions: [], comms: [] },
            }),
          ),
        );
        firstTurnMessages.push(...drafts.flat().map((message) => message.content));
        return ownshipReplayFixture("positive-aoa-load-replay");
      },
    });

    expect(result.sorties).toHaveLength(1);
    expect(configs[0]?.id).toContain("training-drill|positive-aoa-load");
    expect(configs[0]?.initialAircraft.map((ship) => ship.id)).toEqual(["blue-1"]);
    expect(configs[0]?.initialAircraft[0]?.model.weaponStations).toHaveLength(0);
    expect(firstTurnMessages.join("\n")).toContain("Positive AoA/load drill");
    expect(firstTurnMessages.join("\n")).toContain("No target, no radar, no weapons");

    const currentState = garden.documents.get(result.currentStateDocumentId);
    expect(currentState).toContain("Scenario: `positive-aoa-load`");
    expect(currentState).toContain("Target: peak AoA >= +2 deg and peak G >= 2.0");
    expect(currentState).toContain("Peak G: 2.4");
  });

  it("can run propeller flight camp with a distinct Garden pilot identity", async () => {
    const garden = fakeGarden();
    const dayTripper = aircraftArchetypes.find((candidate) => candidate.id === "day-tripper")!;
    const configs: MatchConfig[] = [];
    const firstTurnMessages: string[] = [];

    const result = await runTrainingChamber({
      airframe: dayTripper.airframe,
      connection: garden.connection,
      sorties: 1,
      runId: "test-prop-camp-run",
      pilotId: "prop-flash-test",
      reflectionModel: "scripted-debrief",
      scenario: {
        schemaVersion: 1,
        kind: "duel",
        controlMode: "motor-program",
        pilotModel: "scripted-prop-camp",
        bodyModel: "scripted-fixed-wing-body",
        twitchBodyModel: "scripted-fixed-wing-body",
        turnCount: 1,
        motorProgramTurnMs: 2500,
        motorProgramSampleMs: 50,
        twitchTimeScale: 0.35,
        cameraMode: "pilot-cinema",
      },
      drill: {
        kind: "prop-flight-camp",
        pilotModel: "scripted-prop-camp",
        stage: "basic-stability",
        turnCount: 1,
      },
      async runSortie({ config }) {
        configs.push(config);
        const drafts = await Promise.all(
          (config.comms?.providers ?? []).map((provider) =>
            provider({
              turn: 1,
              time: 0,
              agentId: "prop-flash-test",
              allAgentIds: ["prop-flash-test"],
              self: config.initialAircraft[0]!,
              world: config.initialAircraft,
              observation: {} as never,
              contacts: [],
              navigation: { self: { altitudeM: 2500 }, contacts: [] },
              history: { frames: [], decisions: [], comms: [] },
            }),
          ),
        );
        firstTurnMessages.push(...drafts.flat().map((message) => message.content));
        return ownshipReplayFixture("prop-flight-camp-replay", "prop-flash-test");
      },
    });

    expect(result.currentStateDocumentId).toBe("flight-pilot-prop-flash-test-current-state");
    expect(configs[0]?.id).toContain("training-drill|prop-flight-camp|basic-stability");
    expect(configs[0]?.initialAircraft.map((ship) => ship.id)).toEqual(["prop-flash-test"]);
    expect(configs[0]?.initialAircraft[0]?.model.weaponStations).toHaveLength(0);
    expect(configs[0]?.initialAircraft[0]?.metrics.airspeed).toBeGreaterThan(40);
    expect(configs[0]?.initialAircraft[0]?.metrics.airspeed).toBeLessThan(80);
    expect(firstTurnMessages.join("\n")).toContain("Propeller flight camp coach");
    expect(firstTurnMessages.join("\n")).toContain("No target, no radar, no weapons");

    const currentState = garden.documents.get(result.currentStateDocumentId);
    expect(currentState).toContain("Scenario: `prop-flight-camp`");
    expect(currentState).toContain("Target: altitude within about 150 m");
  });

  it("configures the next envelope-probe drill stages", async () => {
    const tomcatGarden = fakeGarden();
    const tomcat = aircraftArchetypes.find((candidate) => candidate.id === "variable-sweep-tomcat")!;
    const tomcatConfigs: MatchConfig[] = [];

    await runTrainingChamber({
      airframe: tomcat.airframe,
      connection: tomcatGarden.connection,
      sorties: 1,
      runId: "test-very-low-speed",
      reflectionModel: "scripted-debrief",
      scenario: {
        schemaVersion: 1,
        kind: "bvr-intercept",
        controlMode: "motor-program",
        pilotModel: "scripted-positive-aoa-load",
        bodyModel: "scripted-fixed-wing-body",
        twitchBodyModel: "scripted-fixed-wing-body",
        turnCount: 1,
        motorProgramTurnMs: 2500,
        motorProgramSampleMs: 50,
        twitchTimeScale: 0.35,
        cameraMode: "pilot-cinema",
      },
      drill: {
        kind: "positive-aoa-load",
        pilotModel: "scripted-positive-aoa-load",
        stage: "very-low-speed-pitch",
        turnCount: 1,
      },
      async runSortie({ config }) {
        tomcatConfigs.push(config);
        return ownshipReplayFixture("very-low-speed-replay");
      },
    });

    expect(tomcatConfigs[0]?.id).toContain("very-low-speed-pitch");
    expect(tomcatConfigs[0]?.initialAircraft[0]?.metrics.airspeed).toBe(280);

    const tomcatRampGarden = fakeGarden();
    const tomcatRampConfigs: MatchConfig[] = [];

    await runTrainingChamber({
      airframe: tomcat.airframe,
      connection: tomcatRampGarden.connection,
      sorties: 1,
      runId: "test-pitch-ramp-map",
      reflectionModel: "scripted-debrief",
      scenario: {
        schemaVersion: 1,
        kind: "bvr-intercept",
        controlMode: "motor-program",
        pilotModel: "scripted-positive-aoa-load",
        bodyModel: "scripted-fixed-wing-body",
        twitchBodyModel: "scripted-fixed-wing-body",
        turnCount: 1,
        motorProgramTurnMs: 2500,
        motorProgramSampleMs: 50,
        twitchTimeScale: 0.35,
        cameraMode: "pilot-cinema",
      },
      drill: {
        kind: "positive-aoa-load",
        pilotModel: "scripted-positive-aoa-load",
        stage: "pitch-ramp-map",
        turnCount: 1,
      },
      async runSortie({ config }) {
        tomcatRampConfigs.push(config);
        return ownshipReplayFixture("pitch-ramp-map-replay");
      },
    });

    expect(tomcatRampConfigs[0]?.id).toContain("pitch-ramp-map");
    expect(tomcatRampConfigs[0]?.initialAircraft[0]?.metrics.airspeed).toBe(280);

    const tomcatThrottleGarden = fakeGarden();
    const tomcatThrottleConfigs: MatchConfig[] = [];

    await runTrainingChamber({
      airframe: tomcat.airframe,
      connection: tomcatThrottleGarden.connection,
      sorties: 1,
      runId: "test-pitch-ramp-throttle-step",
      reflectionModel: "scripted-debrief",
      scenario: {
        schemaVersion: 1,
        kind: "bvr-intercept",
        controlMode: "motor-program",
        pilotModel: "scripted-positive-aoa-load",
        bodyModel: "scripted-fixed-wing-body",
        twitchBodyModel: "scripted-fixed-wing-body",
        turnCount: 1,
        motorProgramTurnMs: 2500,
        motorProgramSampleMs: 50,
        twitchTimeScale: 0.35,
        cameraMode: "pilot-cinema",
      },
      drill: {
        kind: "positive-aoa-load",
        pilotModel: "scripted-positive-aoa-load",
        stage: "pitch-ramp-throttle-step",
        turnCount: 1,
      },
      async runSortie({ config }) {
        tomcatThrottleConfigs.push(config);
        return ownshipReplayFixture("pitch-ramp-throttle-step-replay");
      },
    });

    expect(tomcatThrottleConfigs[0]?.id).toContain("pitch-ramp-throttle-step");
    expect(tomcatThrottleConfigs[0]?.initialAircraft[0]?.metrics.airspeed).toBe(280);

    const propGarden = fakeGarden();
    const dayTripper = aircraftArchetypes.find((candidate) => candidate.id === "day-tripper")!;
    const propConfigs: MatchConfig[] = [];

    await runTrainingChamber({
      airframe: dayTripper.airframe,
      connection: propGarden.connection,
      sorties: 1,
      runId: "test-slow-bank-hold",
      pilotId: "prop-stage-test",
      reflectionModel: "scripted-debrief",
      scenario: {
        schemaVersion: 1,
        kind: "duel",
        controlMode: "motor-program",
        pilotModel: "scripted-prop-camp",
        bodyModel: "scripted-fixed-wing-body",
        twitchBodyModel: "scripted-fixed-wing-body",
        turnCount: 1,
        motorProgramTurnMs: 2500,
        motorProgramSampleMs: 50,
        twitchTimeScale: 0.35,
        cameraMode: "pilot-cinema",
      },
      drill: {
        kind: "prop-flight-camp",
        pilotModel: "scripted-prop-camp",
        stage: "slow-bank-hold",
        turnCount: 1,
      },
      async runSortie({ config }) {
        propConfigs.push(config);
        return ownshipReplayFixture("slow-bank-hold-replay", "prop-stage-test");
      },
    });

    expect(propConfigs[0]?.id).toContain("slow-bank-hold");
    expect(propConfigs[0]?.initialAircraft[0]?.metrics.airspeed).toBe(35);
    expect(propConfigs[0]?.initialAircraft[0]?.metrics.altitude).toBe(3_000);

    const propTemplateGarden = fakeGarden();
    const propTemplateConfigs: MatchConfig[] = [];

    await runTrainingChamber({
      airframe: dayTripper.airframe,
      connection: propTemplateGarden.connection,
      sorties: 1,
      runId: "test-slow-bank-template",
      pilotId: "prop-template-test",
      reflectionModel: "scripted-debrief",
      scenario: {
        schemaVersion: 1,
        kind: "duel",
        controlMode: "motor-program",
        pilotModel: "scripted-prop-camp",
        bodyModel: "scripted-fixed-wing-body",
        twitchBodyModel: "scripted-fixed-wing-body",
        turnCount: 1,
        motorProgramTurnMs: 2500,
        motorProgramSampleMs: 50,
        twitchTimeScale: 0.35,
        cameraMode: "pilot-cinema",
      },
      drill: {
        kind: "prop-flight-camp",
        pilotModel: "scripted-prop-camp",
        stage: "slow-bank-template",
        turnCount: 1,
      },
      async runSortie({ config }) {
        propTemplateConfigs.push(config);
        return ownshipReplayFixture("slow-bank-template-replay", "prop-template-test");
      },
    });

    expect(propTemplateConfigs[0]?.id).toContain("slow-bank-template");
    expect(propTemplateConfigs[0]?.initialAircraft[0]?.metrics.airspeed).toBe(35);
    expect(propTemplateConfigs[0]?.initialAircraft[0]?.metrics.altitude).toBe(3_000);

    const propRecoveryGarden = fakeGarden();
    const propRecoveryConfigs: MatchConfig[] = [];

    await runTrainingChamber({
      airframe: dayTripper.airframe,
      connection: propRecoveryGarden.connection,
      sorties: 1,
      runId: "test-wings-level-recovery",
      pilotId: "prop-recovery-test",
      reflectionModel: "scripted-debrief",
      scenario: {
        schemaVersion: 1,
        kind: "duel",
        controlMode: "motor-program",
        pilotModel: "scripted-prop-camp",
        bodyModel: "scripted-fixed-wing-body",
        twitchBodyModel: "scripted-fixed-wing-body",
        turnCount: 1,
        motorProgramTurnMs: 2500,
        motorProgramSampleMs: 50,
        twitchTimeScale: 0.35,
        cameraMode: "pilot-cinema",
      },
      drill: {
        kind: "prop-flight-camp",
        pilotModel: "scripted-prop-camp",
        stage: "wings-level-recovery-template",
        turnCount: 1,
      },
      async runSortie({ config }) {
        propRecoveryConfigs.push(config);
        return ownshipReplayFixture("wings-level-recovery-replay", "prop-recovery-test");
      },
    });

    expect(propRecoveryConfigs[0]?.id).toContain("wings-level-recovery-template");
    expect(propRecoveryConfigs[0]?.initialAircraft[0]?.metrics.airspeed).toBe(35);
    expect(propRecoveryConfigs[0]?.initialAircraft[0]?.metrics.altitude).toBe(3_000);

    const propHoldoutGarden = fakeGarden();
    const propHoldoutConfigs: MatchConfig[] = [];

    await runTrainingChamber({
      airframe: dayTripper.airframe,
      connection: propHoldoutGarden.connection,
      sorties: 1,
      runId: "test-generalization-recovery",
      pilotId: "prop-holdout-test",
      reflectionModel: "scripted-debrief",
      scenario: {
        schemaVersion: 1,
        kind: "duel",
        controlMode: "motor-program",
        pilotModel: "scripted-prop-camp",
        bodyModel: "scripted-fixed-wing-body",
        twitchBodyModel: "scripted-fixed-wing-body",
        turnCount: 1,
        motorProgramTurnMs: 2500,
        motorProgramSampleMs: 50,
        twitchTimeScale: 0.35,
        cameraMode: "pilot-cinema",
      },
      drill: {
        kind: "prop-flight-camp",
        pilotModel: "scripted-prop-camp",
        stage: "generalization-recovery",
        turnCount: 1,
      },
      async runSortie({ config }) {
        propHoldoutConfigs.push(config);
        return ownshipReplayFixture("generalization-recovery-replay", "prop-holdout-test");
      },
    });

    expect(propHoldoutConfigs[0]?.id).toContain("generalization-recovery");
    expect(propHoldoutConfigs[0]?.initialAircraft[0]?.metrics.airspeed).toBeGreaterThan(40);
    expect(propHoldoutConfigs[0]?.initialAircraft[0]?.metrics.airspeed).toBeLessThan(80);
  });
});

function fakeGarden(): {
  documents: Map<string, string>;
  connection: GardenMcpConnection;
} {
  const documents = new Map<string, string>();
  const fetchImpl: FetchLike = async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const name = body.params?.name;
    const args = body.params?.arguments ?? {};
    if (name === "read_document") {
      const documentId = String(args.documentId);
      const content = documents.get(documentId);
      if (content === undefined) {
        return jsonResponse({ jsonrpc: "2.0", id: body.id, error: { code: -32000, message: "not found" } });
      }
      return jsonResponse({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          content: [{ type: "text", text: JSON.stringify({ content }) }],
        },
      });
    }
    if (name === "write_document") {
      const documentId = String(args.documentId);
      documents.set(documentId, String(args.content ?? ""));
      return jsonResponse({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({ success: true, documentId, blockIds: [`${documentId}:b1`] }),
            },
          ],
        },
      });
    }
    return jsonResponse({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: `unknown tool ${name}` } });
  };

  return {
    documents,
    connection: {
      mcpUrl: "http://127.0.0.1:8086/mcp",
      token: "test-token",
      graphId: "flight-training",
      source: "env",
      timeoutMs: 5_000,
      fetchImpl,
    },
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function replayFixture(id: string, sortieIndex: number): MatchReplay {
  return {
    id,
    schemaVersion: 5,
    turnDuration: 2.5,
    frameDt: 0.05,
    frames: [
      {
        index: 0,
        time: 0,
        turn: 1,
        aircraft: [
          snapshot("blue-1", "blue", { x: 0, y: 1000, z: 0 }, { gLoad: 1.1 }),
          snapshot("target-1", "red", { x: 0, y: 1000, z: -1600 }, { gLoad: 0 }),
        ],
        events: [],
      },
      {
        index: 1,
        time: 2.5,
        turn: 1,
        aircraft: [
          snapshot("blue-1", "blue", { x: 0, y: 940 - sortieIndex * 10, z: -500 }, { gLoad: 2.5 + sortieIndex }),
          snapshot("target-1", "red", { x: 0, y: 1000, z: -1600 }, { gLoad: 0 }),
        ],
        events: [],
      },
    ],
    agents: [{ id: "blue-1", kind: "llm", label: "test-pilot/motor-program" }],
    agentPhases: [
      { agentId: "blue-1", turn: 1, mode: "planner", startTime: 0, endTime: 2.5 },
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
            airspeed: 180,
            altitude: 1000,
            aoaDeg: 4,
            gLoad: 1.1,
            health: 100,
            weaponCooldown: 0,
            stalled: false,
          },
          contacts: [
            {
              id: "target-1",
              team: "red",
              range: 1600,
              bearingForward: 0.98,
              bearingRight: 0.05,
              bearingUp: 0,
              closureRate: -80,
              health: 100,
            },
          ],
        },
        action: {
          kind: "motor-program",
          durationMs: 2500,
          sampleDtMs: 50,
          samples: [
            { tMs: 0, pitch: 0.1, roll: 0.2, yaw: 0, throttle: 0.95, trigger: false },
            { tMs: 2500, pitch: 0.3, roll: 0.4, yaw: 0, throttle: 1, trigger: false },
          ],
          heldActions: [],
        },
        controlInput: { pitch: 0.1, roll: 0.2, yaw: 0, throttle: 0.95, trigger: false },
        source: "controller",
        rationale: `sortie ${sortieIndex} test maneuver`,
      },
    ],
  };
}

function ownshipReplayFixture(id: string, pilotId = "blue-1"): MatchReplay {
  return {
    id,
    schemaVersion: 5,
    turnDuration: 2.5,
    frameDt: 0.05,
    frames: [
      {
        index: 0,
        time: 0,
        turn: 0,
        aircraft: [snapshot(pilotId, "blue", { x: 0, y: 6000, z: 0 }, { gLoad: 1, aoaDeg: 0 })],
        events: [],
      },
      {
        index: 1,
        time: 0.05,
        turn: 1,
        aircraft: [snapshot(pilotId, "blue", { x: 20, y: 6000, z: 0 }, { gLoad: 1.2, aoaDeg: 1 })],
        events: [],
      },
      {
        index: 2,
        time: 2.5,
        turn: 1,
        aircraft: [snapshot(pilotId, "blue", { x: 600, y: 5920, z: 0 }, { gLoad: 2.4, aoaDeg: 4 })],
        events: [],
      },
    ],
    agents: [{ id: pilotId, kind: "llm", label: "scripted-positive-aoa-load/positive-aoa-load" }],
    agentPhases: [
      { agentId: pilotId, turn: 1, mode: "planner", startTime: 0, endTime: 2.5 },
    ],
    decisions: [
      {
        turn: 1,
        agentId: pilotId,
        observation: {
          schemaVersion: 1,
          selfId: pilotId,
          turn: 1,
          time: 0,
          self: {
            airspeed: 420,
            altitude: 6000,
            aoaDeg: 0,
            gLoad: 1,
            health: 100,
            weaponCooldown: 0,
            stalled: false,
          },
          contacts: [],
        },
        action: {
          kind: "motor-program",
          durationMs: 2500,
          sampleDtMs: 50,
          samples: [
            { tMs: 0, pitch: 0.2, roll: 0, yaw: 0, throttle: 0.98, trigger: false },
            { tMs: 2500, pitch: 0.42, roll: 0.04, yaw: 0, throttle: 0.98, trigger: false },
          ],
          heldActions: [],
        },
        controlInput: { pitch: 0.2, roll: 0, yaw: 0, throttle: 0.98, trigger: false },
        source: "controller",
        rationale: "test positive pull",
      },
    ],
  };
}

function snapshot(
  id: string,
  team: "blue" | "red",
  position: { x: number; y: number; z: number },
  extra: Partial<AircraftSnapshot> = {},
): AircraftSnapshot {
  return {
    id,
    callsign: id,
    team,
    color: team === "blue" ? "#4da3ff" : "#ff5d5d",
    position,
    velocity: { x: 0, y: 0, z: 0 },
    orientation: { x: 0, y: 0, z: 0, w: 1 },
    controls: { pitch: 0, roll: 0, yaw: 0, throttle: 0.95, trigger: false },
    airspeed: 180,
    altitude: position.y,
    aoaDeg: 4,
    gLoad: 1,
    health: 100,
    weaponCooldown: 0,
    stalled: false,
    ...extra,
  };
}
