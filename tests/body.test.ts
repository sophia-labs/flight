import { describe, expect, it } from "vitest";
import { fixedWingBodyManifest } from "../src/body/manifest";
import { parseBodyOutput } from "../src/body/parser";
import { createBodyRuntimeState, invalidOutputControl } from "../src/body/runtime";

describe("Body motor grammar", () => {
  it("parses a complete fixed-wing Body output", () => {
    const parsed = parseBodyOutput(
      [
        "MUSCLE ROLL=-5 PITCH=-2 YAW=-1 PUSH=5",
        "TONE brace 2",
        "EXPECT ROLL=left++ PITCH=down SPEED=recover MARGIN=better",
        "FEEL pushing nose down before I bite",
        "MEM left_turn unload wait_pull",
      ].join("\n"),
      fixedWingBodyManifest,
    );

    expect(parsed.status).toBe("ok");
    expect(parsed.muscle).toEqual({ roll: -5, pitch: -2, yaw: -1, push: 5 });
    expect(parsed.tone).toEqual({ mode: "brace", intensity: 2 });
    expect(parsed.expect?.speed).toBe("recover");
    expect(parsed.feel).toBe("pushing nose down before I bite");
    expect(parsed.memory).toBe("left_turn unload wait_pull");
  });

  it("clips out-of-range muscles without hiding the command", () => {
    const parsed = parseBodyOutput(
      [
        "MUSCLE ROLL=-8 PITCH=7 YAW=0 PUSH=9",
        "TONE hold 0",
        "EXPECT ROLL=left++ PITCH=up SPEED=stable MARGIN=stable",
        "FEEL overreaching but still parseable",
        "MEM overreach",
      ].join("\n"),
      fixedWingBodyManifest,
    );

    expect(parsed.status).toBe("clipped");
    expect(parsed.clipped).toBe(true);
    expect(parsed.muscle).toEqual({ roll: -5, pitch: 5, yaw: 0, push: 5 });
    expect(parsed.errors).toContain("clipped ROLL");
    expect(parsed.errors).toContain("clipped PITCH");
    expect(parsed.errors).toContain("clipped PUSH");
  });

  it("degrades but executes when embodiment fields are sparse", () => {
    const parsed = parseBodyOutput("MUSCLE ROLL=1 PITCH=0 YAW=0 PUSH=3", fixedWingBodyManifest);

    expect(parsed.status).toBe("degraded");
    expect(parsed.muscle).toEqual({ roll: 1, pitch: 0, yaw: 0, push: 3 });
    expect(parsed.errors).toContain("missing EXPECT");
    expect(parsed.errors).toContain("missing FEEL");
  });

  it("fails when MUSCLE is missing, then invalid policy decays the prior body control", () => {
    const parsed = parseBodyOutput("FEEL I forgot how limbs work", fixedWingBodyManifest);
    const state = createBodyRuntimeState({
      pitch: 0.6,
      roll: -0.8,
      yaw: 0.4,
      throttle: 1,
      trigger: false,
    });

    expect(parsed.status).toBe("failed");
    const control = invalidOutputControl(state, true);
    expect(control.pitch).toBeCloseTo(0.252);
    expect(control.roll).toBeCloseTo(-0.336);
    expect(control.yaw).toBeCloseTo(0.168);
    expect(control.throttle).toBeCloseTo(0.72);
    expect(control.trigger).toBe(true);
  });
});

