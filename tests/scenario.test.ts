import { describe, expect, it } from "vitest";
import {
  buildScenarioMatchConfig,
  createBalloonScenarioAircraft,
} from "../src/runtime/scenario";
import { aircraftArchetypes } from "../src/sim/aircraftCatalog";

describe("scenario runtime", () => {
  it("uses the selected airframe for the balloon scenario body aircraft", () => {
    const tomcat = aircraftArchetypes.find((candidate) => candidate.id === "variable-sweep-tomcat")!;
    const aircraft = createBalloonScenarioAircraft(tomcat.airframe);

    expect(aircraft[0]?.id).toBe("blue-1");
    expect(aircraft[0]?.airframe).toEqual(tomcat.airframe);
    expect(aircraft[1]?.id).toBe("balloon");
    expect(aircraft[1]?.static).toBe(true);
  });

  it("builds scenario-specific match configs from the selected airframe", () => {
    const tomcat = aircraftArchetypes.find((candidate) => candidate.id === "variable-sweep-tomcat")!;
    const sternGun = buildScenarioMatchConfig(tomcat.airframe, { kind: "stern-gun", turnCount: 200 });
    const balloon = buildScenarioMatchConfig(tomcat.airframe, { kind: "balloon", turnCount: 16 });

    expect(sternGun.id).toBe("stern-gun-start-001");
    expect(sternGun.maxTurns).toBe(80);
    expect(sternGun.initialAircraft[0]?.airframe).toEqual(tomcat.airframe);
    expect(balloon.id).toBe("balloon-hunt-001");
    expect(balloon.initialAircraft[0]?.airframe).toEqual(tomcat.airframe);
  });
});
