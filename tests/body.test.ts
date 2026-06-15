import { describe, expect, it } from "vitest";
import { fixedWingBodyManifest } from "../src/body/manifest";
import { parseBodyOutput } from "../src/body/parser";
import {
  createBodyRuntimeState,
  finishBodyTick,
  invalidOutputControl,
  type PendingBodyTick,
  runBodyTick,
  slewBodyControl,
} from "../src/body/runtime";
import { buildBodyPrompt, compareExpectation, encodeProprioception, snapshotKinematics } from "../src/body/telemetry";
import type { PilotIntentAction } from "../src/protocol/schema";
import { createInitialAircraft, FRAME_DT } from "../src/runtime/scenario";
import { cameraSensor } from "../src/agent/perception";
import { cameraAsciiEncoderV2 } from "../src/agent/encoders/cameraAscii";
import { selectCameraDevice } from "../src/sim/mountedSensor";

// The camera-ascii@2 glyph-field the Body now senses, computed exactly as runBodyTick does.
function fieldFor(self: ReturnType<typeof createInitialAircraft>[number], world: ReturnType<typeof createInitialAircraft>) {
  return cameraAsciiEncoderV2.encode(cameraSensor.sense(selectCameraDevice(self.devices), world, self)).text ?? "";
}

const TEST_INTENT: PilotIntentAction = {
  kind: "pilot-intent",
  goal: "turn left toward the target without losing the wing",
  urgency: 0.5,
  riskTolerance: 0.45,
  style: "controlled",
  constraints: ["avoid_stall", "keep_energy"],
  attention: ["target_left"],
  trigger: false,
};

describe("Body motor grammar", () => {
  it("prompts live Body models with the strict output contract", () => {
    const prompt = buildBodyPrompt(
      fixedWingBodyManifest,
      TEST_INTENT,
      {
        attitude: "bank_level; nose_level",
        motion: "roll_rate_0.00 pitch_rate_0.00 vertical_0.0",
        energy: "good",
        stallMargin: "safe",
        authority: { pitch: "ok", roll: "ok", yaw: "ok", thrust: "strong_lagging" },
        terrain: "ground_safe",
        field: " cockpit-cam  33x15  FOV 60deg\n+---------------------------------+\n|                                 |\n+---------------------------------+\n own  spd 180  alt 1000  bank +0  pitch +0\n (no contacts in view)",
        pain: { wingBuffet: 0, pitchMush: 0, overG: 0, groundRush: 0 },
        affordances: ["can_roll_left", "can_roll_right", "can_pull_gently"],
      },
    );

    expect(prompt).toContain("Return exactly these five lines and nothing else");
    expect(prompt).toContain("MUSCLE ROLL=<int -5..5> PITCH=<int -5..5> YAW=<int -5..5> PUSH=<int 0..5>");
    expect(prompt).toContain("Never use word-values like gentle_right or throttle_up");
    expect(prompt).toContain("controls are rate-limited");
    expect(prompt).toContain("Only use TONE reverse");
  });

  // FIELD-FEED: the Body's primary spatial SENSE is now the camera-ascii@2 glyph-field, not a single
  // `target` token. The assembled prompt must carry that field (grid + legend) and must NOT carry the
  // old `target:` line. The field is computed exactly as runBodyTick computes it from the live world.
  it("feeds the camera-ascii@2 glyph-field into the Body prompt and drops the target token", () => {
    const aircraft = createInitialAircraft();
    const self = aircraft[0];
    const state = createBodyRuntimeState(self.controls);
    const field = fieldFor(self, aircraft);
    const proprioception = encodeProprioception(self, state, field);

    // The encoded proprioception carries the field verbatim and no longer carries a `target` token.
    expect(proprioception.field).toBe(field);
    expect(proprioception).not.toHaveProperty("target");

    const prompt = buildBodyPrompt(fixedWingBodyManifest, TEST_INTENT, proprioception, state.memory);

    // The whole @2 field — its grid AND its legend — is present in the prompt.
    expect(field).toContain("33x15"); // the @2 grid header (legend line 1)
    expect(field).toContain("FOV"); // legend carries FOV
    expect(field.split("\n").filter((l) => l.startsWith("|"))).toHaveLength(15); // 15 grid rows
    expect(prompt).toContain(field);
    expect(prompt).toContain("FIELD (what you see");

    // The old single spatial token is gone from the prompt entirely.
    expect(prompt).not.toContain("\ntarget: ");
    expect(prompt).not.toMatch(/^target:/m);
  });

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

  it("slews parsed muscle commands toward the requested posture", () => {
    const parsed = parseBodyOutput(
      [
        "MUSCLE ROLL=5 PITCH=5 YAW=5 PUSH=5",
        "TONE hold 1",
        "EXPECT ROLL=right+ PITCH=up SPEED=stable MARGIN=safe",
        "FEEL easing toward the stop",
        "MEM slew",
      ].join("\n"),
      fixedWingBodyManifest,
    );
    const control = slewBodyControl(
      { pitch: 0, roll: 0, yaw: 0, throttle: 0.2, trigger: false },
      { pitch: 1, roll: 1, yaw: 1, throttle: 1, trigger: true },
      parsed,
    );

    expect(control.pitch).toBeGreaterThan(0);
    expect(control.pitch).toBeLessThan(1);
    expect(control.roll).toBeGreaterThan(0);
    expect(control.roll).toBeLessThan(1);
    expect(control.yaw).toBeGreaterThan(0);
    expect(control.yaw).toBeLessThan(1);
    expect(control.throttle).toBeGreaterThan(0.2);
    expect(control.throttle).toBeLessThan(1);
    expect(control.trigger).toBe(true);
  });

  it("passes control sign changes through neutral unless the Body asks for reverse", () => {
    const hold = parseBodyOutput(
      [
        "MUSCLE ROLL=-5 PITCH=-5 YAW=-5 PUSH=5",
        "TONE brace 3",
        "EXPECT ROLL=left+ PITCH=down SPEED=stable MARGIN=safe",
        "FEEL unloading before reversing",
        "MEM neutral first",
      ].join("\n"),
      fixedWingBodyManifest,
    );
    const blocked = slewBodyControl(
      { pitch: 0.22, roll: 0.24, yaw: 0.2, throttle: 1, trigger: false },
      { pitch: -1, roll: -1, yaw: -1, throttle: 1, trigger: false },
      hold,
    );

    expect(blocked.pitch).toBe(0);
    expect(blocked.roll).toBe(0);
    expect(blocked.yaw).toBe(0);

    const reverse = parseBodyOutput(
      [
        "MUSCLE ROLL=-5 PITCH=-5 YAW=-5 PUSH=5",
        "TONE reverse 3",
        "EXPECT ROLL=left+ PITCH=down SPEED=stable MARGIN=safe",
        "FEEL reversing now",
        "MEM reverse now",
      ].join("\n"),
      fixedWingBodyManifest,
    );
    const crossed = slewBodyControl(
      { pitch: 0.22, roll: 0.24, yaw: 0.2, throttle: 1, trigger: false },
      { pitch: -1, roll: -1, yaw: -1, throttle: 1, trigger: false },
      reverse,
    );

    expect(crossed.pitch).toBeLessThan(0);
    expect(crossed.roll).toBeLessThan(0);
    expect(crossed.yaw).toBeLessThan(0);
  });

  it("does not count a rate-limited first response as a Body expectation mismatch", () => {
    const actual = { roll: "stable", pitch: "stable", speed: "stable", margin: "safe" };

    expect(
      compareExpectation(
        { roll: "right+", pitch: "up", speed: "rising", margin: "safe" },
        actual,
        { pitch: 0.12, roll: 0.24, yaw: 0, throttle: 1, trigger: false },
      ),
    ).toEqual([]);

    expect(
      compareExpectation(
        { roll: "right+", pitch: "up", speed: "rising", margin: "safe" },
        actual,
        { pitch: -0.2, roll: -0.24, yaw: 0, throttle: 0.3, trigger: false },
      ),
    ).toEqual(["roll_mismatch", "pitch_mismatch", "speed_mismatch"]);
  });

  it("carries repeated Body mismatch streaks into the next prompt", () => {
    const aircraft = createInitialAircraft();
    const self = aircraft[0];
    const state = createBodyRuntimeState(self.controls);
    const pending = (tick: number): PendingBodyTick => ({
      turn: 1,
      tick,
      agentId: self.id,
      time: tick * FRAME_DT,
      dt: FRAME_DT,
      reason: "regular_tick",
      manifestId: fixedWingBodyManifest.bodyId,
      pilotIntent: TEST_INTENT,
      proprioception: encodeProprioception(self, state, fieldFor(self, aircraft)),
      promptText: "",
      rawOutput: "",
      parsed: {
        status: "ok",
        muscle: { roll: 0, pitch: 2, yaw: 0, push: 2 },
        tone: { mode: "hold", intensity: 1 },
        expect: { roll: "stable", pitch: "stable", speed: "rising", margin: "safe" },
        errors: [],
        clipped: false,
      },
      controlInput: { pitch: 0.4, roll: 0, yaw: 0, throttle: 0.4, trigger: false },
      before: snapshotKinematics(self),
    });

    finishBodyTick(pending(1), state, self);
    finishBodyTick(pending(2), state, self);
    const prompt = buildBodyPrompt(
      fixedWingBodyManifest,
      TEST_INTENT,
      encodeProprioception(self, state, fieldFor(self, aircraft)),
      state.memory,
    );

    expect(state.mismatchStreaks.speed_mismatch).toBe(2);
    expect(prompt).toContain("mismatch_streaks: speed_mismatchx2");
    expect(prompt).toContain("speed_mismatch_streak: match last ACTUAL speed trend");
  });

  it("records usage returned by a Body model", async () => {
    const aircraft = createInitialAircraft();
    const self = aircraft[0];
    const state = createBodyRuntimeState(self.controls);
    const pending = await runBodyTick({
      config: {
        manifest: fixedWingBodyManifest,
        model: async () => ({
          output: [
            "MUSCLE ROLL=-2 PITCH=-1 YAW=-1 PUSH=4",
            "TONE hold 1",
            "EXPECT ROLL=left+ PITCH=down SPEED=stable MARGIN=stable",
            "FEEL easing left",
            "MEM left ease",
          ].join("\n"),
          usage: { inputTokens: 90, outputTokens: 24, costUsd: 0.00042 },
        }),
      },
      state,
      turn: 1,
      agentId: self.id,
      time: 0,
      dt: FRAME_DT,
      self,
      aircraft,
      pilotIntent: TEST_INTENT,
    });

    const tick = finishBodyTick(pending, state, self);
    expect(tick.usage).toEqual({ inputTokens: 90, outputTokens: 24, costUsd: 0.00042 });
    expect(tick.modelError).toBeUndefined();
    expect(tick.controlInput.roll).toBeLessThan(0);
    expect(Math.abs(tick.controlInput.roll)).toBeLessThan(0.4);
  });

  it("turns Body model errors into invalid recovery ticks", async () => {
    const aircraft = createInitialAircraft();
    const self = aircraft[0];
    const state = createBodyRuntimeState({
      pitch: 0.5,
      roll: -0.5,
      yaw: 0.25,
      throttle: 0.9,
      trigger: false,
    });

    const pending = await runBodyTick({
      config: {
        manifest: fixedWingBodyManifest,
        model: async () => {
          throw new Error("provider down");
        },
      },
      state,
      turn: 1,
      agentId: self.id,
      time: 0,
      dt: FRAME_DT,
      self,
      aircraft,
      pilotIntent: { ...TEST_INTENT, trigger: true },
    });
    const tick = finishBodyTick(pending, state, self);

    expect(tick.reason).toBe("invalid_recovery");
    expect(tick.modelError).toBe("provider down");
    expect(tick.parsed.status).toBe("failed");
    expect(tick.parsed.errors).toContain("model_error: provider down");
    expect(tick.controlInput.roll).toBeCloseTo(-0.21);
    expect(tick.controlInput.pitch).toBeCloseTo(0.21);
    expect(tick.controlInput.yaw).toBeCloseTo(0.105);
    expect(tick.controlInput.throttle).toBeCloseTo(0.648);
    expect(tick.controlInput.trigger).toBe(true);
  });
});
