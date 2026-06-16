import { describe, expect, it } from "vitest";
import {
  BALLOON_CONE_HALF_ANGLE_RAD,
  BALLOON_MAX_GUN_RANGE_M,
  balloonMetrics,
} from "../src/eval/balloonMetrics";
import { quatLookRotation, vec3 } from "../src/sim/math";
import type { AircraftSnapshot, MatchReplay, ReplayEvent, ReplayFrame } from "../src/protocol/schema";

// A balloon parked ahead on -Z. We point the Body's nose by giving it a look-rotation toward a chosen
// aim vector, so onNose = cos(angle between nose and the line to the balloon) is exactly controllable.
const BALLOON_POS = vec3(0, 1000, -1000); // 1000 m dead ahead, inside the 2900 m gun range

function body(aimAt: { x: number; y: number; z: number }, health = 100, pos = vec3(0, 1000, 0)): AircraftSnapshot {
  return {
    id: "blue-1",
    callsign: "Blue",
    team: "blue",
    color: "#4da3ff",
    position: pos,
    velocity: vec3(0, 0, -150),
    orientation: quatLookRotation({ x: aimAt.x - pos.x, y: aimAt.y - pos.y, z: aimAt.z - pos.z }),
    controls: { pitch: 0, roll: 0, yaw: 0, throttle: 0.9, trigger: false },
    airspeed: 150,
    altitude: pos.y,
    aoaDeg: 0,
    gLoad: 1,
    health,
    weaponCooldown: 0,
    stalled: false,
  };
}

function balloon(health: number): AircraftSnapshot {
  return {
    id: "balloon",
    callsign: "Red Balloon",
    team: "red",
    color: "#ff5da3",
    position: BALLOON_POS,
    velocity: vec3(0, 0, 0),
    orientation: { x: 0, y: 0, z: 0, w: 1 },
    controls: { pitch: 0, roll: 0, yaw: 0, throttle: 0, trigger: false },
    airspeed: 0,
    altitude: BALLOON_POS.y,
    aoaDeg: 0,
    gLoad: 1,
    health,
    weaponCooldown: 0,
    stalled: false,
    static: true,
  };
}

function frame(index: number, aircraft: AircraftSnapshot[], events: ReplayEvent[] = []): ReplayFrame {
  return { index, time: index * 0.16, turn: 1 + Math.floor(index / 15), aircraft, events };
}

function replay(frames: ReplayFrame[], bodyTicks?: MatchReplay["bodyTicks"]): MatchReplay {
  return {
    id: "balloon-test",
    turnDuration: 2.4,
    frameDt: 0.16,
    frames,
    ...(bodyTicks ? { bodyTicks } : {}),
  };
}

describe("balloonMetrics", () => {
  it("exposes the exact balloon weapon envelope it scores against", () => {
    expect(BALLOON_CONE_HALF_ANGLE_RAD).toBe(0.42);
    expect(BALLOON_MAX_GUN_RANGE_M).toBe(2_900);
  });

  it("counts only dead-on, in-range frames as time-on-balloon", () => {
    const onNose = body(BALLOON_POS); // nose straight at the balloon -> onNose = 1
    const offNose = body(vec3(2000, 1000, 0)); // nose 90deg off to the right -> way outside the cone
    const m = balloonMetrics(
      replay([frame(0, [onNose, balloon(12)]), frame(1, [offNose, balloon(12)])]),
    );
    // exactly one on-solution frame * frameDt(0.16)
    expect(m.timeOnBalloonSec).toBeCloseTo(0.16, 6);
    expect(m.peakOnNose).toBeCloseTo(1, 5);
    expect(m.closestRangeM).toBeCloseTo(1000, 3);
    expect(m.timeToFirstSolutionSec).toBe(0);
    expect(m.killed).toBe(false);
  });

  it("excludes frames beyond the max gun range even when dead-on", () => {
    const far = body(BALLOON_POS, 100, vec3(0, 1000, BALLOON_MAX_GUN_RANGE_M + 500)); // dead-on but too far
    const m = balloonMetrics(replay([frame(0, [far, balloon(12)])]));
    expect(m.timeOnBalloonSec).toBe(0);
    expect(m.timeToFirstSolutionSec).toBeNull();
    expect(m.peakOnNose).toBeCloseTo(1, 5); // still aligned, just out of range
  });

  it("detects the kill, time-to-kill, and counts shots/hits from events", () => {
    const aim = body(BALLOON_POS);
    const m = balloonMetrics(
      replay([
        frame(0, [aim, balloon(12)], [
          { type: "shot", actorId: "blue-1", targetId: "balloon", message: "fires" },
          { type: "hit", actorId: "blue-1", targetId: "balloon", message: "hit" },
        ]),
        frame(1, [aim, balloon(0)]), // balloon now dead
      ]),
    );
    expect(m.shots).toBe(1);
    expect(m.hits).toBe(1);
    expect(m.killed).toBe(true);
    expect(m.timeToKillSec).toBeCloseTo(0.16, 6);
  });

  it("computes parseRate, latency, and cost from bodyTicks", () => {
    const aim = body(BALLOON_POS);
    const tick = (status: "ok" | "failed", latencyMs: number, cost: number) =>
      ({
        turn: 1,
        tick: 0,
        agentId: "blue-1",
        time: 0,
        dt: 0.16,
        reason: "regular_tick" as const,
        manifestId: "fixed-wing",
        pilotIntent: {
          kind: "pilot-intent" as const,
          goal: "g",
          urgency: 0.5,
          riskTolerance: 0.5,
          style: "s",
          constraints: [],
          attention: [],
          trigger: false,
        },
        proprioception: {} as never,
        promptText: "",
        rawOutput: "",
        parsed: { status, errors: [], clipped: false },
        controlInput: { pitch: 0, roll: 0, yaw: 0, throttle: 0.9, trigger: false },
        actual: { roll: "", pitch: "", speed: "", margin: "" },
        mismatch: [],
        latencyMs,
        usage: { inputTokens: 10, outputTokens: 5, costUsd: cost },
      });
    const m = balloonMetrics(
      replay(
        [frame(0, [aim, balloon(12)])],
        // 3 ok + 1 failed -> parseRate 0.75; latencies 100,200,300,400 -> mean 250
        [tick("ok", 100, 0.001), tick("ok", 200, 0.001), tick("ok", 300, 0.001), tick("failed", 400, 0)],
      ),
    );
    expect(m.parseRate).toBeCloseTo(0.75, 6);
    expect(m.meanLatencyMs).toBeCloseTo(250, 6);
    expect(m.costUsd).toBeCloseTo(0.003, 9);
  });
});
