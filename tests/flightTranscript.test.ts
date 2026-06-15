import { describe, expect, it } from "vitest";
import {
  activeFlightTranscriptMomentIndex,
  buildFlightTranscriptMoments,
  formatFlightTranscript,
} from "../src/transcript/flightTranscript";
import type { MatchReplay } from "../src/protocol/schema";

function replay(): MatchReplay {
  return {
    id: "transcript-test",
    turnDuration: 2.4,
    frameDt: 0.16,
    frames: [
      {
        index: 0,
        time: 0,
        turn: 1,
        events: [],
        aircraft: [
          {
            id: "blue-1",
            callsign: "Blue",
            team: "blue",
            color: "#4da3ff",
            position: { x: 0, y: 1000, z: 0 },
            velocity: { x: 0, y: 0, z: -100 },
            orientation: { x: 0, y: 0, z: 0, w: 1 },
            controls: { pitch: 0.4, roll: 0, yaw: 0, throttle: 0.4, trigger: false },
            airspeed: 160,
            altitude: 1000,
            aoaDeg: 2,
            gLoad: 1,
            health: 100,
            weaponCooldown: 0,
            stalled: false,
          },
          {
            id: "red-1",
            callsign: "Red",
            team: "red",
            color: "#ff6b6b",
            position: { x: 0, y: 1000, z: -1000 },
            velocity: { x: 0, y: 0, z: 100 },
            orientation: { x: 0, y: 0, z: 0, w: 1 },
            controls: { pitch: 0, roll: 0, yaw: 0, throttle: 1, trigger: false },
            airspeed: 160,
            altitude: 1000,
            aoaDeg: 2,
            gLoad: 1,
            health: 100,
            weaponCooldown: 0,
            stalled: false,
          },
        ],
      },
    ],
    agents: [
      {
        id: "blue-1",
        kind: "llm",
        label: "deepseek/deepseek-v4-flash/pilot-intent",
        config: { bodyModel: "deepseek/deepseek-v4-flash" },
      },
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
            airspeed: 160,
            altitude: 1000,
            aoaDeg: 2,
            gLoad: 1,
            health: 100,
            weaponCooldown: 0,
            stalled: false,
          },
          contacts: [],
        },
        action: {
          kind: "pilot-intent",
          goal: "Point nose at bandit and close",
          urgency: 0.7,
          riskTolerance: 0.4,
          style: "controlled",
          constraints: ["avoid_stall"],
          attention: ["bandit_forward"],
          trigger: false,
        },
        controlInput: { pitch: 0, roll: 0, yaw: 0, throttle: 1, trigger: false },
        source: "controller",
        rationale: "bandit is forward and inside the nose cone",
        usage: { inputTokens: 100, outputTokens: 25, costUsd: 0.0002 },
      },
    ],
    bodyTicks: [
      {
        turn: 1,
        tick: 1,
        agentId: "blue-1",
        time: 0,
        dt: 0.16,
        reason: "regular_tick",
        manifestId: "fixed_wing.trainer.v1",
        pilotIntent: {
          kind: "pilot-intent",
          goal: "Point nose at bandit and close",
          urgency: 0.7,
          riskTolerance: 0.4,
          style: "controlled",
          constraints: ["avoid_stall"],
          attention: ["bandit_forward"],
          trigger: false,
        },
        proprioception: {
          attitude: "bank_level; nose_level",
          motion: "roll_rate_0.00 pitch_rate_0.00 vertical_0.0",
          energy: "good",
          stallMargin: "safe",
          authority: { pitch: "ok", roll: "ok", yaw: "ok", thrust: "strong_lagging" },
          terrain: "ground_safe",
          target: "center_0 level_0 ahead 1000m",
          pain: { wingBuffet: 0, pitchMush: 0, overG: 0, groundRush: 0 },
          affordances: ["can_pull_gently"],
          last: {
            mismatch: ["speed_mismatch"],
            mismatchStreaks: { speed_mismatch: 2 },
          },
        },
        promptText:
          "mismatch_streaks: speed_mismatchx2\nspeed_mismatch_streak: predict SPEED=stable until ACTUAL speed changes",
        rawOutput: "",
        parsed: {
          status: "ok",
          muscle: { roll: 0, pitch: 2, yaw: 0, push: 2 },
          tone: { mode: "hold", intensity: 1 },
          expect: { roll: "stable", pitch: "stable", speed: "rising", margin: "safe" },
          feel: "trying to accelerate",
          memory: "close",
          errors: [],
          clipped: false,
        },
        controlInput: { pitch: 0.4, roll: 0, yaw: 0, throttle: 0.4, trigger: false },
        actual: { roll: "stable", pitch: "stable", speed: "stable", margin: "safe" },
        mismatch: [],
        usage: { inputTokens: 90, outputTokens: 20, costUsd: 0.0001 },
      },
    ],
  };
}

describe("flight transcript", () => {
  it("formats a replay as a moment-by-moment reading surface", () => {
    const text = formatFlightTranscript(replay());

    expect(text).toContain("# Flight Transcript: transcript-test");
    expect(text).toContain("Point nose at bandit and close");
    expect(text).toContain("geometry: range=1000m nose=0.0deg cooldown_ready=yes firing_window=yes near_window=yes");
    expect(text).toContain("control_motion: delta=n/a flips=none requested_reverse=none buffered_reverse=none tone=hold");
    expect(text).toContain("mismatch: speed_mismatch; prompt_streaks_seen=speed_mismatchx2");
    expect(text).toContain("calibration_prompt: mismatch_streaks: speed_mismatchx2");
    expect(text).toContain("Body predicted speed movement before airspeed actually changed enough");

    const [moment] = buildFlightTranscriptMoments(replay());
    expect(moment.geometry.firingWindow).toBe(true);
    expect(moment.mismatch).toEqual(["speed_mismatch"]);
    expect(moment.controlMotionText).toBe("delta=n/a flips=none requested_reverse=none buffered_reverse=none tone=hold");
    expect(activeFlightTranscriptMomentIndex([moment], 0)).toBe(0);
    expect(activeFlightTranscriptMomentIndex([moment], -0.1)).toBe(-1);
  });

  it("calls out Body reversal requests separately from actual control flips", () => {
    const subject = replay();
    const previous = subject.bodyTicks?.[0];
    if (!previous) throw new Error("expected body tick fixture");
    subject.bodyTicks?.push({
      ...previous,
      tick: 2,
      time: 0.16,
      proprioception: {
        ...previous.proprioception,
        last: {
          muscle: previous.parsed.muscle,
          expect: previous.parsed.expect,
          actual: previous.actual,
          mismatch: ["speed_mismatch"],
          mismatchStreaks: { speed_mismatch: 3 },
        },
      },
      parsed: {
        ...previous.parsed,
        muscle: { roll: 0, pitch: -2, yaw: 0, push: 2 },
        tone: { mode: "hold", intensity: 1 },
        expect: { roll: "stable", pitch: "stable", speed: "stable", margin: "safe" },
      },
      controlInput: { pitch: 0, roll: 0, yaw: 0, throttle: 0.4, trigger: false },
      actual: { roll: "stable", pitch: "stable", speed: "stable", margin: "safe" },
      mismatch: [],
    });

    const [, moment] = buildFlightTranscriptMoments(subject);

    expect(moment.controlMotionText).toBe(
      "delta=0.40 flips=none requested_reverse=pitch buffered_reverse=pitch tone=hold",
    );
    expect(moment.read).toContain("Body requested pitch sign reversal without TONE reverse (buffered pitch)");
  });
});
