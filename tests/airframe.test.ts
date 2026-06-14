import { describe, expect, it } from "vitest";
import { AirframeSchema, SensorDeviceSchema, type WingPart } from "../src/protocol/schema";
import {
  airframeReport,
  compileAirframe,
  defaultAirframe,
  noseCamera,
} from "../src/sim/airframe";
import { DEFAULT_MODEL } from "../src/sim/flight";

describe("airframe compiler", () => {
  it("compiles the default airframe to the calibration baseline + frozen derived rigid-body fields", () => {
    const m = compileAirframe(defaultAirframe()).model;
    // Base scalars — the intended calibration values (the rate ratio anchors the default to these).
    expect(m.massKg).toBe(9_200);
    expect(m.wingAreaM2).toBeCloseTo(22.5, 9);
    expect(m.maxThrustN).toBe(74_000);
    expect(m.maxRollRate).toBeCloseTo(1.75, 9);
    expect(m.maxPitchRate).toBeCloseTo(0.92, 9);
    expect(m.maxYawRate).toBeCloseTo(0.34, 9);
    expect(m.stallAoARad).toBeCloseTo(0.42, 9);
    // Derived rigid-body fields — frozen so a change to the geometry fold is caught (determinism anchor).
    expect(Math.round(m.inertia.roll)).toBe(23_605);
    expect(Math.round(m.inertia.pitch)).toBe(100_714);
    expect(Math.round(m.inertia.yaw)).toBe(122_032);
    expect(Number(m.staticMarginM.toFixed(4))).toBe(0.0625); // > 0 ⇒ CoM ahead of AC ⇒ statically stable
    expect(m.aspectRatio).toBeCloseTo(7.511, 3);
    expect(m.dryMassKg).toBe(9_200);
    expect(m.fuelCapacityKg).toBe(0);
    // DEFAULT_MODEL is the compiled default, so it carries these too.
    expect(DEFAULT_MODEL.staticMarginM).toBe(m.staticMarginM);
  });

  it("mounts the default airframe's sensor part as a device", () => {
    expect(compileAirframe(defaultAirframe()).devices).toEqual([noseCamera()]);
  });

  it("is a pure fold — two compiles of the same airframe are identical", () => {
    expect(compileAirframe(defaultAirframe())).toEqual(compileAirframe(defaultAirframe()));
  });

  it("round-trips through the Zod schemas (a part serializes now)", () => {
    expect(() => AirframeSchema.parse(defaultAirframe())).not.toThrow();
    expect(() => SensorDeviceSchema.parse(noseCamera())).not.toThrow();
  });

  // The levers must move the way the EXISTING sim actually rewards (per the design review): handling
  // comes from control-surface size + thrust, NOT from wing area (which only adds drag).
  it("bigger ailerons → faster roll; more thrust adds up; smaller wing → less lift area", () => {
    const base = compileAirframe(defaultAirframe()).model;

    const biggerAilerons = defaultAirframe();
    const wing = biggerAilerons.parts.find((p) => p.id === "main-wing") as WingPart;
    wing.control = { axis: "roll", area: wing.control!.area * 2 };
    expect(compileAirframe(biggerAilerons).model.maxRollRate).toBeGreaterThan(base.maxRollRate);

    const twinEngine = defaultAirframe();
    const engine = twinEngine.parts.find((p) => p.id === "engine");
    if (engine && engine.kind === "engine") twinEngine.parts.push({ ...engine, id: "engine-2" });
    expect(compileAirframe(twinEngine).model.maxThrustN).toBe(base.maxThrustN + 74_000);

    const stubby = defaultAirframe();
    const w = stubby.parts.find((p) => p.id === "main-wing") as WingPart;
    w.planform = { ...w.planform, span: w.planform.span / 2 };
    expect(compileAirframe(stubby).model.wingAreaM2).toBeLessThan(base.wingAreaM2);
  });

  it("floors rate ratios so a control-surface-free build is sluggish but not dead", () => {
    const noControl = defaultAirframe();
    for (const p of noControl.parts) if (p.kind === "wing") p.control = undefined;
    const model = compileAirframe(noControl).model;
    expect(model.maxRollRate).toBeGreaterThan(0); // not zeroed
    expect(model.maxRollRate).toBeLessThan(DEFAULT_MODEL.maxRollRate); // but clearly worse
  });

  it("reports flyability against the real sim constants and flags broken builds", () => {
    const ok = airframeReport(compileAirframe(defaultAirframe()).model);
    expect(ok.warnings).toEqual([]);
    expect(ok.thrustToWeight).toBeGreaterThan(0.3);

    const noWing = defaultAirframe();
    noWing.parts = noWing.parts.filter((p) => p.kind !== "wing");
    const broken = airframeReport(compileAirframe(noWing).model);
    expect(broken.warnings.some((w) => w.includes("no wing area"))).toBe(true);
  });
});
