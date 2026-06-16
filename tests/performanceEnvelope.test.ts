import { describe, expect, it } from "vitest";
import { aircraftArchetypes } from "../src/sim/aircraftCatalog";
import { compileAirframe } from "../src/sim/airframe";
import {
  ENVELOPE_MODEL_VERSION,
  buildPerformanceEnvelope,
  type EnvelopeConfig,
} from "../src/sim/performanceEnvelope";

const TEST_CONFIG: Partial<EnvelopeConfig> = {
  altitudeM: [0, 4_000],
  speedGrid: { minMps: 40, maxMps: 180, stepMps: 20 },
  accelerationSegments: [{ id: "test-60-100", fromMps: 60, toMps: 100, altitudeM: 0 }],
};
const JET_TEST_CONFIG: Partial<EnvelopeConfig> = {
  altitudeM: [0, 10_000, 14_000],
  speedGrid: { minMps: 80, maxMps: 720, stepMps: 20 },
  accelerationSegments: [{ id: "jet-250-450", fromMps: 250, toMps: 450, altitudeM: 6_000 }],
};
const MPH_PER_MPS = 2.2369362921;
const FPM_PER_MPS = 196.8503937;

function envelopeFor(id: string) {
  const archetype = aircraftArchetypes.find((candidate) => candidate.id === id);
  if (!archetype) throw new Error(`missing archetype ${id}`);
  return buildPerformanceEnvelope(compileAirframe(archetype.airframe).model, {
    aircraftId: archetype.id,
    aircraftName: archetype.name,
    role: archetype.role,
    config: TEST_CONFIG,
  });
}

describe("performance envelope", () => {
  it("builds a repeatable altitude-speed data contract", () => {
    const envelope = envelopeFor("inline-escort");
    const speedCount = 8; // 40, 60, ... 180

    expect(envelope.version).toBe(ENVELOPE_MODEL_VERSION);
    expect(envelope.level).toHaveLength(TEST_CONFIG.altitudeM!.length * speedCount);
    expect(envelope.turn).toHaveLength(envelope.level.length);
    expect(envelope.summaries).toHaveLength(TEST_CONFIG.altitudeM!.length);
    expect(envelope.scalars.massKg).toBeGreaterThan(0);
    expect(envelope.scalars.wingLoadingNM2).toBeGreaterThan(0);
    expect(envelope.acceleration).toHaveLength(1);
  });

  it("keeps level-flight feasibility tied to specific excess power", () => {
    const envelope = envelopeFor("radial-deck-fighter");

    for (const point of envelope.level) {
      if (point.specificExcessPowerMps === null) {
        expect(point.levelFlight).toBe(false);
      } else {
        expect(point.levelFlight).toBe(point.specificExcessPowerMps >= 0);
      }
    }
  });

  it("does not let sustained turn exceed instantaneous turn at the same point", () => {
    const envelope = envelopeFor("clipped-interceptor");

    for (const point of envelope.turn) {
      if (point.sustainedLoadG === null) continue;
      expect(point.sustainedLoadG).toBeLessThanOrEqual(point.instantaneousLoadG + 1e-6);
      if (point.sustainedTurnRateDps !== null && point.instantaneousTurnRateDps !== null) {
        expect(point.sustainedTurnRateDps).toBeLessThanOrEqual(point.instantaneousTurnRateDps + 1e-6);
      }
    }
  });

  it("captures recognizable low-speed turn differences between archetypes", () => {
    const turnFighter = envelopeFor("light-turn-fighter");
    const twinBoom = envelopeFor("twin-boom-pursuit");

    const turnFighterSeaLevel = turnFighter.summaries.find((summary) => summary.altitudeM === 0);
    const twinBoomSeaLevel = twinBoom.summaries.find((summary) => summary.altitudeM === 0);
    expect(turnFighterSeaLevel?.stallSpeedMps).toBeLessThan(twinBoomSeaLevel?.stallSpeedMps ?? Infinity);
    expect(turnFighterSeaLevel?.bestInstantaneousTurn?.turnRateDps).toBeGreaterThan(
      twinBoomSeaLevel?.bestInstantaneousTurn?.turnRateDps ?? Infinity,
    );
  });

  it("models the Super Tomcat as an afterburning variable-sweep jet that outclasses props", () => {
    const tomcat = aircraftArchetypes.find((candidate) => candidate.id === "variable-sweep-tomcat");
    const prop = aircraftArchetypes.find((candidate) => candidate.id === "radial-deck-fighter");
    if (!tomcat || !prop) throw new Error("missing comparison archetype");

    const tomcatEnvelope = buildPerformanceEnvelope(compileAirframe(tomcat.airframe).model, {
      aircraftId: tomcat.id,
      aircraftName: tomcat.name,
      role: tomcat.role,
      config: JET_TEST_CONFIG,
    });
    const propEnvelope = buildPerformanceEnvelope(compileAirframe(prop.airframe).model, {
      aircraftId: prop.id,
      aircraftName: prop.name,
      role: prop.role,
      config: JET_TEST_CONFIG,
    });
    const tomcatTop = Math.max(...tomcatEnvelope.summaries.map((summary) => summary.topLevelSpeedMps ?? 0));
    const propTop = Math.max(...propEnvelope.summaries.map((summary) => summary.topLevelSpeedMps ?? 0));
    const tomcatClimb = Math.max(...tomcatEnvelope.summaries.map((summary) => summary.bestClimbRateMps ?? 0));
    const supersonicPoint = tomcatEnvelope.level.find(
      (point) => point.altitudeM === 14_000 && point.speedMps === 600,
    );

    expect(tomcatEnvelope.scalars.jetAfterburnerThrustN).toBeGreaterThan(200_000);
    expect(tomcatEnvelope.scalars.maxMach).toBeGreaterThan(2);
    expect(tomcatEnvelope.scalars.sweepRangeDeg).toBe("20-68");
    expect(tomcatTop * MPH_PER_MPS).toBeGreaterThan(1_400);
    expect(tomcatTop).toBeGreaterThan(propTop * 3);
    expect(tomcatClimb * FPM_PER_MPS).toBeGreaterThan(40_000);
    expect(supersonicPoint?.mach).toBeGreaterThan(1.8);
    expect(supersonicPoint?.sweepDeg).toBeGreaterThan(60);
  });
});
