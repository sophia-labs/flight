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
import { createBalloonScenarioAircraft, createInitialAircraft, FRAME_DT } from "../src/runtime/scenario";
import { cameraSensor } from "../src/agent/perception";
import { cameraAsciiEncoderV2 } from "../src/agent/encoders/cameraAscii";
import { selectCameraDevice } from "../src/sim/mountedSensor";
import { targetInReticle } from "../src/sim/flight";
import { quatLookRotation, sub, vec3 } from "../src/sim/math";

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

    expect(prompt).toContain("Return exactly these six lines and nothing else");
    expect(prompt).toContain("MUSCLE ROLL=<int -5..5> PITCH=<int -5..5> YAW=<int -5..5> PUSH=<int 0..5>");
    expect(prompt).toContain("SOLUTION <cold|warming|hot|now>");
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
    expect(field).toContain("65x31"); // the @2 grid header (legend line 1) — v0.9.x aiming-loop acuity
    expect(field).toContain("FOV"); // legend carries FOV
    expect(field.split("\n").filter((l) => l.startsWith("|"))).toHaveLength(31); // 31 grid rows
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
      // Even with the Pilot weapons-free, a FAILED Body must not fire: the assisted sear needs a
      // SOLUTION=now from a live Body, and an errored Body emits none. The trigger stays safe.
      pilotIntent: { ...TEST_INTENT, trigger: true, armedFire: true },
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
    expect(tick.controlInput.trigger).toBe(false); // sear blocks firing without a live SOLUTION=now
  });
});

// v0.9.x held-action firing: the Body owns the shot via a SOLUTION line; the assisted sear fires only on
// two keys (Pilot armed + Body SOLUTION=now) AND a real target in the reticle. Credential-free: a
// scripted Body model drives every case, so this is a deterministic smoke of the whole firing loop.
describe("held-action firing — SOLUTION grammar + assisted sear (two-key)", () => {
  // A scripted Body model that returns a fixed output line block (so we can drive the SOLUTION value).
  function fixedBody(solution: string) {
    return async () =>
      [
        "MUSCLE ROLL=0 PITCH=0 YAW=0 PUSH=3",
        "TONE hold 1",
        "EXPECT ROLL=stable PITCH=stable SPEED=stable MARGIN=safe",
        `SOLUTION ${solution}`,
        "FEEL lined up",
        "MEM gun run",
      ].join("\n");
  }

  // Body aimed dead at the balloon, placed ~1 km away (inside the round's reach) so a SOLUTION=now is a
  // REAL solution that the geometric reticle key accepts.
  function aimedScenario() {
    const [self, balloon] = createBalloonScenarioAircraft();
    // Put the body 1 km from the balloon, nose dead-on (well inside the 2900 m round reach).
    self.position = { x: balloon.position.x, y: balloon.position.y, z: balloon.position.z + 1000 };
    self.orientation = quatLookRotation(sub(balloon.position, self.position));
    return { self, balloon, world: [self, balloon] };
  }

  it("parses the SOLUTION line and never errors when it is omitted", () => {
    const withSolution = parseBodyOutput(
      [
        "MUSCLE ROLL=0 PITCH=0 YAW=0 PUSH=3",
        "TONE hold 1",
        "EXPECT ROLL=stable PITCH=stable SPEED=stable MARGIN=safe",
        "SOLUTION now",
        "FEEL on the boresight",
        "MEM fire",
      ].join("\n"),
      fixedWingBodyManifest,
    );
    expect(withSolution.solution).toBe("now");
    expect(withSolution.status).toBe("ok");

    // Omitting SOLUTION is not an error (it is an aiming verb, not a law) — status still ok.
    const noSolution = parseBodyOutput(
      [
        "MUSCLE ROLL=0 PITCH=0 YAW=0 PUSH=3",
        "TONE hold 1",
        "EXPECT ROLL=stable PITCH=stable SPEED=stable MARGIN=safe",
        "FEEL searching",
        "MEM none",
      ].join("\n"),
      fixedWingBodyManifest,
    );
    expect(noSolution.solution).toBeUndefined();
    expect(noSolution.status).toBe("ok");
    expect(noSolution.errors).not.toContain("body_chatter");
  });

  it("the OUTPUT_CONTRACT prompts the Body to call its own shot with SOLUTION", () => {
    const { self, world } = aimedScenario();
    const intent: PilotIntentAction = { ...TEST_INTENT, armedFire: true };
    const proprioception = encodeProprioception(self, createBodyRuntimeState(self.controls), fieldFor(self, world));
    const prompt = buildBodyPrompt(fixedWingBodyManifest, intent, proprioception);
    expect(prompt).toContain("SOLUTION <cold|warming|hot|now>");
    expect(prompt).toContain("call your own shot"); // weapons-free coaching
    expect(prompt).toContain("weapons: FREE"); // the armed/weapons-free line in PILOT_WANT
  });

  it("fires only with BOTH keys: Pilot armed AND Body SOLUTION=now (and a real target in the reticle)", async () => {
    async function fire(opts: { armed: boolean; solution: string }): Promise<boolean> {
      const { self, world } = aimedScenario();
      const state = createBodyRuntimeState(self.controls);
      const pending = await runBodyTick({
        config: { manifest: fixedWingBodyManifest, model: fixedBody(opts.solution) },
        state,
        turn: 1,
        agentId: self.id,
        time: 0,
        dt: FRAME_DT,
        self,
        aircraft: world,
        pilotIntent: { ...TEST_INTENT, armedFire: opts.armed, trigger: opts.armed },
      });
      return pending.controlInput.trigger;
    }

    // The real target is in the reticle (dead-on). The two keys gate the shot:
    expect(await fire({ armed: true, solution: "now" })).toBe(true); // both keys → FIRES
    expect(await fire({ armed: false, solution: "now" })).toBe(false); // Pilot not armed → safe
    expect(await fire({ armed: true, solution: "hot" })).toBe(false); // Body hasn't called now → safe
    expect(await fire({ armed: true, solution: "cold" })).toBe(false); // cold → safe
  });

  it("the sear blocks a SOLUTION=now at EMPTY SKY (no target in the reticle)", async () => {
    // Same Body + same armed Pilot + SOLUTION=now, but the nose points 90deg AWAY from the balloon, so
    // no target sits in the reticle. The geometric key fails → the sear stays safe.
    const [self, balloon] = createBalloonScenarioAircraft();
    self.orientation = quatLookRotation(vec3(0, 0, -1)); // arbitrary heading, not at the balloon
    const world = [self, balloon];
    expect(targetInReticle(self, world)).toBe(false); // nothing in the reticle

    const state = createBodyRuntimeState(self.controls);
    const pending = await runBodyTick({
      config: { manifest: fixedWingBodyManifest, model: fixedBody("now") },
      state,
      turn: 1,
      agentId: self.id,
      time: 0,
      dt: FRAME_DT,
      self,
      aircraft: world,
      pilotIntent: { ...TEST_INTENT, armedFire: true, trigger: true },
    });
    expect(pending.controlInput.trigger).toBe(false); // armed + now, but empty sky → no shot
  });

  it("the reticle is WIDER than the hit radius — being in it does not guarantee a hit (skill stays)", () => {
    // A target just inside the reticle but off-centre: targetInReticle is true (the Body may call now),
    // yet a round fired along the nose would pass OUTSIDE the hit radius. The sear permits the shot; the
    // physics still misses. The sear gates empty sky, it does not aim.
    const self = {
      ...createBalloonScenarioAircraft()[0],
      position: vec3(0, 1000, 0),
      orientation: quatLookRotation(vec3(0, 0, -1)),
    };
    // Balloon 800 m ahead but offset ~55 m to the side: 55 m is OUTSIDE the 42 m hit radius, but at
    // 800 m it is within the ~3.4deg reticle (tan(3.4deg)*800 ≈ 48 m + the balloon's own size).
    const balloon = { ...createBalloonScenarioAircraft()[1], position: vec3(55, 1000, -800) };
    const world = [self, balloon];
    expect(targetInReticle(self, world)).toBe(true); // in the reticle — the Body may call now...
    // ...but the gun axis misses: perp distance (55 m) exceeds the 42 m hit radius. (Proven by the
    // sim weapon tests: a round fired here would not connect.) Skill — centring — still decides the hit.
  });
});
