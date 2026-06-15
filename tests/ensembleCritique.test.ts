import { describe, expect, it } from "vitest";
import type { MatchReplay } from "../src/protocol/schema";
import { critiqueReplay, formatCritique } from "../src/headless/ensembleCritique";

function replay(): MatchReplay {
  return {
    id: "critique-test",
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
            controls: { pitch: 0, roll: 0, yaw: 0, throttle: 1, trigger: false },
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
            position: { x: 0, y: 1000, z: -2000 },
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
      {
        index: 1,
        time: 0.16,
        turn: 1,
        events: [],
        aircraft: [
          {
            id: "blue-1",
            callsign: "Blue",
            team: "blue",
            color: "#4da3ff",
            position: { x: 0, y: 1000, z: 10 },
            velocity: { x: 0, y: 0, z: -100 },
            orientation: { x: 0, y: 0, z: 0, w: 1 },
            controls: { pitch: 0.8, roll: 0.8, yaw: 0.4, throttle: 1, trigger: false },
            airspeed: 155,
            altitude: 1000,
            aoaDeg: 2,
            gLoad: 1.4,
            health: 100,
            weaponCooldown: 0,
            stalled: false,
          },
          {
            id: "red-1",
            callsign: "Red",
            team: "red",
            color: "#ff6b6b",
            position: { x: 0, y: 1000, z: -2020 },
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
          self: { airspeed: 160, altitude: 1000, aoaDeg: 2, gLoad: 1, health: 100, weaponCooldown: 0, stalled: false },
          contacts: [],
        },
        action: {
          kind: "pilot-intent",
          goal: "Maintain energy and position to engage.",
          urgency: 0.6,
          riskTolerance: 0.3,
          style: "patient",
          constraints: ["avoid_stall"],
          attention: ["enemy_position"],
          trigger: false,
        },
        controlInput: { pitch: 0, roll: 0, yaw: 0, throttle: 1, trigger: false },
        source: "controller",
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
          goal: "Maintain energy and position to engage.",
          urgency: 0.6,
          riskTolerance: 0.3,
          style: "patient",
          constraints: ["avoid_stall"],
          attention: ["enemy_position"],
          trigger: false,
        },
        proprioception: {
          attitude: "bank_level; nose_level",
          motion: "roll_rate_0.00 pitch_rate_0.00 vertical_0.0",
          energy: "good",
          stallMargin: "safe",
          authority: { pitch: "ok", roll: "ok", yaw: "ok", thrust: "strong_lagging" },
          terrain: "ground_safe",
          field: " cockpit-cam  33x15  FOV 60deg\n bandit  1 o'clock level  rng 2000  beam-R  hp 100",
          pain: { wingBuffet: 0, pitchMush: 0, overG: 0, groundRush: 0 },
          affordances: ["can_pull_gently"],
        },
        promptText: "",
        rawOutput: "",
        parsed: {
          status: "ok",
          muscle: { roll: 4, pitch: 2, yaw: 1, push: 5 },
          errors: [],
          clipped: false,
        },
        controlInput: { pitch: 0.4, roll: 0.8, yaw: 0.2, throttle: 1, trigger: false },
        actual: { roll: "stable", pitch: "stable", speed: "stable", margin: "safe" },
        mismatch: ["roll_mismatch"],
        usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.0001 },
      },
    ],
    outcome: {
      resolved: true,
      reason: "draw",
      winnerTeam: null,
      turnsRun: 1,
      scores: {
        blue: { damageDealt: 0, damageTaken: 0, survived: true },
        red: { damageDealt: 0, damageTaken: 0, survived: true },
      },
      finalHealth: { "blue-1": 100, "red-1": 100 },
      competence: {
        "blue-1": {
          survived: true,
          damageDealt: 0,
          damageTaken: 0,
          shots: 0,
          hits: 0,
          fracStalled: 0,
          fracOnDeck: 0,
          minAltitude: 1000,
          meanAirspeed: 158,
          energyRetainedRatio: 0.95,
          controlSmoothness: 0.8,
        },
      },
    },
  };
}

describe("ensemble critique", () => {
  it("does not blame trigger discipline when no firing window exists", () => {
    const critique = critiqueReplay(replay());
    const text = formatCritique(critique);

    expect(critique.verificationReady).toBe(true);
    expect(critique.summary.firingWindowFrames).toBe(0);
    expect(text).toContain("The run never created a valid firing window");
    expect(text).toContain("Pilot intent is generic");
    expect(text).not.toContain("The pilot never fired.");
  });

  it("flags missed trigger opportunities inside valid weapon geometry", () => {
    const subject = replay();
    for (const frame of subject.frames) {
      const red = frame.aircraft.find((ship) => ship.id === "red-1");
      if (red) red.position = { x: 0, y: 1000, z: -900 };
    }

    const critique = critiqueReplay(subject);
    const text = formatCritique(critique);

    expect(critique.summary.firingWindowFrames).toBe(2);
    expect(critique.summary.triggeredInWindowFrames).toBe(0);
    expect(text).toContain("The pilot missed 2 valid firing-window frames without firing.");
    expect(text).toContain("Add a tactical harness cue for weapon employment");
  });

  it("reports repeated control sign flips separately from mean delta", () => {
    const subject = replay();
    const previous = subject.frames[1];
    subject.frames.push({
      ...previous,
      index: 2,
      time: 0.32,
      aircraft: previous.aircraft.map((ship) =>
        ship.id === "blue-1"
          ? { ...ship, controls: { pitch: -0.8, roll: -0.8, yaw: -0.4, throttle: 1, trigger: false } }
          : ship,
      ),
    });

    const critique = critiqueReplay(subject);
    const text = formatCritique(critique);

    expect(critique.summary.controlSignFlips).toBe(3);
    expect(critique.summary.pitchSignFlips).toBe(1);
    expect(critique.summary.rollSignFlips).toBe(1);
    expect(critique.summary.yawSignFlips).toBe(1);
    expect(text).toContain("Frame-level control sign flips are frequent");
  });

  it("reports Body reversal requests and slew buffering", () => {
    const subject = replay();
    const previous = subject.bodyTicks?.[0];
    if (!previous) throw new Error("expected body tick fixture");
    subject.bodyTicks?.push({
      ...previous,
      tick: 2,
      time: 0.16,
      parsed: {
        ...previous.parsed,
        muscle: { roll: 4, pitch: -2, yaw: 1, push: 5 },
        tone: { mode: "hold", intensity: 1 },
      },
      controlInput: { pitch: 0, roll: 0.8, yaw: 0.2, throttle: 1, trigger: false },
      actual: { roll: "stable", pitch: "stable", speed: "stable", margin: "safe" },
    });

    const critique = critiqueReplay(subject);
    const text = formatCritique(critique);

    expect(critique.summary.bodyRequestedSignReversals).toBe(1);
    expect(critique.summary.bodyBufferedSignReversals).toBe(1);
    expect(critique.summary.bodyUnannouncedSignReversals).toBe(1);
    expect(critique.summary.bodyControlSignFlips).toBe(0);
    expect(text).toContain("Body requested 1 pitch/roll/yaw sign reversals without TONE reverse.");
    expect(text).toContain("Slew buffering intercepted 1 Body reversal requests before an immediate sign flip.");
  });
});
