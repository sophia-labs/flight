import { describe, expect, it } from "vitest";
import { buildServerScenarioMatchConfig } from "../src/server/scenarioRun";
import { aircraftArchetypes } from "../src/sim/aircraftCatalog";

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
        turnCount: 0,
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
});
