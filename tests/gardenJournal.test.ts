import { describe, expect, it } from "vitest";
import { resolveGardenConnection, type FetchLike } from "../src/garden/client";
import {
  buildSortieJournalDocument,
  journalScenarioReplay,
  maybeJournalScenarioReplay,
} from "../src/garden/sortieJournal";
import type { AircraftSnapshot, MatchReplay } from "../src/protocol/schema";

describe("Garden sortie journal", () => {
  it("stays disabled until a Garden graph id is configured", async () => {
    const result = await maybeJournalScenarioReplay(replayFixture(), { env: {} });

    expect(result).toMatchObject({
      enabled: false,
      status: "disabled",
    });
    expect(result.enabled).toBe(false);
    if (!result.enabled) {
      expect(result.reason).toContain("FLIGHT_GARDEN_GRAPH_ID");
    }
  });

  it("renders a replay-grounded Markdown document for a pilot journal", () => {
    const document = buildSortieJournalDocument(replayFixture(), { pilotId: "blue-1" });

    expect(document.documentId).toMatch(/^flight-sortie-blue-1-/);
    expect(document.title.length).toBeLessThanOrEqual(96);
    expect(document.content).toContain("# Flight sortie");
    expect(document.content).toContain("## Coach Evidence");
    expect(document.content).toContain("SAW");
    expect(document.content).toContain("COMMANDED");
    expect(document.content).toContain("ACTUAL");
    expect(document.content).toContain("Reflection Prompt");
    expect(document.content).toContain('"turnTruth"');
  });

  it("keeps Garden document titles within the local title limit", () => {
    const replay = replayFixture();
    replay.id = "studio-scenario|bvr-intercept|motor:2500x50|deepseek-v4-pro|deepseek-v4-flash|turns:8|chamber:deepseek-v4-pro-bvr-5:s1";
    replay.agents = [{ id: "blue-1", kind: "llm", label: "deepseek-v4-pro/motor-program-with-a-long-training-label" }];

    const document = buildSortieJournalDocument(replay, { pilotId: "blue-1" });

    expect(document.title.length).toBeLessThanOrEqual(96);
    expect(document.content.split("\n")[0]?.length).toBeLessThanOrEqual(98); // "# " + title
  });

  it("writes through Garden MCP write_document with explicit connection settings", async () => {
    const calls: Array<{ url: string; body: unknown; auth?: string }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({
        url,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        auth: String((init?.headers as Record<string, string> | undefined)?.authorization ?? ""),
      });
      return new Response(
        JSON.stringify({
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({ success: true, documentId: "doc-1", blockIds: ["b1", "b2"] }),
              },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const result = await journalScenarioReplay(replayFixture(), {
      connection: {
        mcpUrl: "http://127.0.0.1:8086/mcp",
        token: "secret",
        graphId: "flight-training",
        source: "env",
        timeoutMs: 5_000,
        fetchImpl,
      },
    });

    expect(result).toMatchObject({
      enabled: true,
      status: "written",
      graphId: "flight-training",
      blockIds: ["b1", "b2"],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.auth).toBe("Bearer secret");
    expect(calls[0]?.body).toMatchObject({
      method: "tools/call",
      params: {
        name: "write_document",
        arguments: {
          graphId: "flight-training",
          format: "markdown",
          awaitDurable: true,
        },
      },
    });
  });
});

describe("Garden connection resolution", () => {
  it("accepts an explicit MCP URL and token for headless cells or gateway routes", async () => {
    const result = await resolveGardenConnection({
      FLIGHT_GARDEN_GRAPH_ID: "flight-training",
      FLIGHT_GARDEN_MCP_URL: "http://localhost:8080/g/flight-training/mcp",
      FLIGHT_GARDEN_TOKEN: "dev-token",
    });

    expect(result).toMatchObject({
      enabled: true,
      connection: {
        mcpUrl: "http://localhost:8080/g/flight-training/mcp",
        token: "dev-token",
        graphId: "flight-training",
        source: "env",
      },
    });
  });
});

function replayFixture(): MatchReplay {
  return {
    id: "garden-journal-test",
    schemaVersion: 5,
    turnDuration: 2.5,
    frameDt: 0.05,
    frames: [
      {
        index: 0,
        time: 0,
        turn: 1,
        aircraft: [
          snapshot("blue-1", "blue", { x: 0, y: 1000, z: 0 }, { gLoad: 1.2 }),
          snapshot("target-1", "red", { x: 0, y: 1000, z: -1800 }, { gLoad: 0 }),
        ],
        events: [],
      },
      {
        index: 1,
        time: 2.5,
        turn: 1,
        aircraft: [
          snapshot("blue-1", "blue", { x: 0, y: 900, z: -400 }, { gLoad: 3.4, aoaDeg: 9 }),
          snapshot("target-1", "red", { x: 0, y: 1000, z: -1800 }, { gLoad: 0 }),
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
            gLoad: 1.2,
            health: 100,
            weaponCooldown: 0,
            stalled: false,
          },
          contacts: [
            {
              id: "target-1",
              team: "red",
              range: 1800,
              bearingForward: 0.99,
              bearingRight: 0,
              bearingUp: 0,
              closureRate: -120,
              health: 100,
            },
          ],
          text: "VISUAL camera-ascii@2 cockpit field.\n+",
        },
        action: {
          kind: "motor-program",
          durationMs: 2500,
          sampleDtMs: 50,
          samples: [
            { tMs: 0, pitch: 0.1, roll: 0.2, yaw: 0, throttle: 0.95, trigger: false },
            { tMs: 2500, pitch: 0.4, roll: 0.35, yaw: 0, throttle: 1, trigger: false },
          ],
          heldActions: [],
        },
        controlInput: { pitch: 0.1, roll: 0.2, yaw: 0, throttle: 0.95, trigger: false },
        source: "controller",
        rationale: "bank right and pull toward the datum",
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
