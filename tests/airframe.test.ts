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
  it("compiles the default airframe to EXACTLY DEFAULT_MODEL (byte-identity anchor)", () => {
    // This is the determinism guarantee: same model ⇒ same physics ⇒ all existing replays byte-identical.
    expect(compileAirframe(defaultAirframe()).model).toEqual(DEFAULT_MODEL);
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
