import { describe, expect, it } from "vitest";
import { aircraftArchetypes } from "../src/sim/aircraftCatalog";
import { compileAirframe } from "../src/sim/airframe";
import { buildPerformanceEnvelope, type EnvelopeConfig } from "../src/sim/performanceEnvelope";
import { performancePresentation } from "../src/studio/performancePresentation";

const PROP_CARD_CONFIG: Partial<EnvelopeConfig> = {
  altitudeM: [0, 2_000, 4_000],
  speedGrid: { minMps: 40, maxMps: 180, stepMps: 20 },
  accelerationSegments: [{ id: "60-100mps-sl", fromMps: 60, toMps: 100, altitudeM: 0 }],
};

const JET_CARD_CONFIG: Partial<EnvelopeConfig> = {
  altitudeM: [0, 10_000, 14_000],
  speedGrid: { minMps: 80, maxMps: 720, stepMps: 20 },
  accelerationSegments: [{ id: "mach0.8-1.2-10km", fromMps: 239, toMps: 359, altitudeM: 10_000 }],
};

describe("performance presentation", () => {
  it("turns envelope math into a compact player-facing flight card", () => {
    const card = presentationFor("light-turn-fighter", PROP_CARD_CONFIG);

    expect(card.cards).toHaveLength(4);
    expect(card.traits.map((trait) => trait.label)).toEqual(["speed", "climb", "turn", "low speed"]);
    expect(card.headline).toBe("Close-range turn fighter");
    expect(card.operatingNote).toContain("corner");
    expect(card.accelerationNote).toContain("mph");
  });

  it("classifies the variable-sweep jet as an energy fighter", () => {
    const card = presentationFor("variable-sweep-tomcat", JET_CARD_CONFIG);

    expect(card.headline).toBe("High-speed energy fighter");
    expect(card.traits.find((trait) => trait.label === "speed")?.value).toBe("supersonic");
    expect(card.cards.find((metric) => metric.label === "service ceiling")?.value).toContain("m");
  });
});

function presentationFor(id: string, config: Partial<EnvelopeConfig>) {
  const archetype = aircraftArchetypes.find((candidate) => candidate.id === id);
  if (!archetype) throw new Error(`missing archetype ${id}`);
  const envelope = buildPerformanceEnvelope(compileAirframe(archetype.airframe).model, {
    aircraftId: archetype.id,
    aircraftName: archetype.name,
    role: archetype.role,
    config,
  });
  return performancePresentation(envelope);
}
