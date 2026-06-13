import { describe, expect, it } from "vitest";
import {
  ControlInputSchema,
  clampControlInput,
  type ControlInput,
  type ReplayEvent,
} from "../src/protocol/schema";
import {
  basisFromQuat,
  dot,
  length,
  normalize,
  quatIdentity,
  quatLookRotation,
  vec3,
} from "../src/sim/math";
import { DEFAULT_MODEL, stepSimulation } from "../src/sim/flight";
import type { AircraftState, FlightMetrics } from "../src/sim/types";
import { generateDemoMatch } from "../src/runtime/scenario";

describe("flight sim replay generation", () => {
  it("produces deterministic replay data", async () => {
    const first = await generateDemoMatch(8);
    const second = await generateDemoMatch(8);

    expect(first).toEqual(second);
    expect(first.frames.length).toBeGreaterThan(20);
  });

  it("keeps every generated control input inside the public protocol", async () => {
    const replay = await generateDemoMatch(10);

    for (const frame of replay.frames) {
      for (const aircraft of frame.aircraft) {
        expect(() => ControlInputSchema.parse(aircraft.controls)).not.toThrow();
        expect(Number.isFinite(aircraft.position.x)).toBe(true);
        expect(Number.isFinite(aircraft.velocity.y)).toBe(true);
        expect(aircraft.health).toBeGreaterThanOrEqual(0);
        expect(aircraft.health).toBeLessThanOrEqual(100);
      }
    }
  });

  it("creates an orientation that points the aircraft forward vector at the desired heading", () => {
    const desired = normalize(vec3(10, 1, -8));
    const orientation = quatLookRotation(desired);
    const basis = basisFromQuat(orientation);

    expect(dot(basis.forward, desired)).toBeGreaterThan(0.999);
  });
});

const STEP_DT = 0.16;
const ZERO_METRICS: FlightMetrics = {
  airspeed: 0,
  altitude: 0,
  aoaDeg: 0,
  gLoad: 1,
  stalled: false,
};

function makeAircraft(o: Partial<AircraftState> = {}): AircraftState {
  const velocity = o.velocity ?? vec3(0, 0, -180);
  const position = o.position ?? vec3(0, 1000, 0);
  return {
    id: o.id ?? "blue-1",
    callsign: o.callsign ?? "Blue",
    team: o.team ?? "blue",
    color: o.color ?? "#4da3ff",
    position,
    velocity,
    orientation: o.orientation ?? quatLookRotation(velocity),
    controls: o.controls ?? { pitch: 0, roll: 0, yaw: 0, throttle: 0.8, trigger: false },
    health: o.health ?? 100,
    weaponCooldown: o.weaponCooldown ?? 0,
    model: o.model ?? DEFAULT_MODEL,
    metrics: o.metrics ?? { ...ZERO_METRICS, airspeed: length(velocity), altitude: position.y },
  };
}

function controls(p: Partial<ControlInput> = {}): ControlInput {
  return { pitch: 0, roll: 0, yaw: 0, throttle: 0.8, trigger: false, ...p };
}

function step(
  aircraft: AircraftState[],
  controlsById: Record<string, ControlInput>,
  steps: number,
): ReplayEvent[] {
  const events: ReplayEvent[] = [];
  for (let i = 0; i < steps; i += 1) {
    events.push(...stepSimulation(aircraft, controlsById, STEP_DT).events);
  }
  return events;
}

describe("flight physics characterization", () => {
  it("throttle accelerates and idle does not", () => {
    const full = makeAircraft();
    const idle = makeAircraft();
    const start = length(full.velocity);

    step([full], { "blue-1": controls({ throttle: 1 }) }, 15);
    step([idle], { "blue-1": controls({ throttle: 0 }) }, 15);

    expect(full.metrics.airspeed).toBeGreaterThan(idle.metrics.airspeed);
    expect(full.metrics.airspeed).toBeGreaterThan(start);
  });

  it("lift opposes gravity in level cruise (loses far less than free-fall)", () => {
    const ship = makeAircraft({ velocity: vec3(0, 0, -180), position: vec3(0, 1000, 0) });

    step([ship], { "blue-1": controls({ throttle: 0.8 }) }, 15);

    // ~2.4 s of free-fall would lose ~28 m; lift must keep the loss well under that.
    expect(ship.position.y).toBeGreaterThan(1000 - 28);
  });

  it("flags stall below the speed floor", () => {
    const ship = makeAircraft({ velocity: vec3(0, 0, -40) });

    step([ship], { "blue-1": controls({ throttle: 0.5 }) }, 1);

    expect(ship.metrics.stalled).toBe(true);
  });

  it("flags stall and cuts lift at high angle of attack", () => {
    const speed = 130;
    const clean = makeAircraft({
      orientation: quatIdentity(),
      velocity: vec3(0, -speed * Math.sin(0.3), -speed * Math.cos(0.3)),
    });
    const stalled = makeAircraft({
      orientation: quatIdentity(),
      velocity: vec3(0, -speed * Math.sin(0.7), -speed * Math.cos(0.7)),
    });

    step([clean], { "blue-1": controls({ throttle: 0.5 }) }, 1);
    step([stalled], { "blue-1": controls({ throttle: 0.5 }) }, 1);

    expect(clean.metrics.stalled).toBe(false);
    expect(stalled.metrics.stalled).toBe(true);
    // Same speed/altitude, so qbar matches; only AoA differs — stall must reduce lift.
    expect(stalled.metrics.gLoad).toBeLessThan(clean.metrics.gLoad);
  });

  it("a fast aircraft on the deck takes terrain damage and stays at the floor", () => {
    const ship = makeAircraft({ position: vec3(0, 55, 0), velocity: vec3(0, 0, -180) });

    step([ship], { "blue-1": controls({ throttle: 0.8 }) }, 1);

    expect(ship.health).toBeLessThan(100);
    expect(ship.position.y).toBeGreaterThanOrEqual(55);
  });

  it("resolves a hit when the target is in range and inside the gun cone", () => {
    const shooter = makeAircraft({
      id: "blue-1",
      team: "blue",
      orientation: quatLookRotation(vec3(0, 0, -1)),
      position: vec3(0, 1000, 0),
      weaponCooldown: 0,
    });
    const target = makeAircraft({ id: "red-1", team: "red", position: vec3(0, 1000, -500) });

    const events = step(
      [shooter, target],
      {
        "blue-1": controls({ throttle: 0.5, trigger: true }),
        "red-1": controls({ throttle: 0.5, trigger: false }),
      },
      1,
    );

    expect(events.some((e) => e.type === "shot")).toBe(true);
    expect(events.some((e) => e.type === "hit")).toBe(true);
    expect(target.health).toBeLessThan(100);
    expect(target.health).toBeGreaterThanOrEqual(72); // damage is clamped to <= 28
  });

  it("misses when the target is out of range", () => {
    const shooter = makeAircraft({
      id: "blue-1",
      team: "blue",
      orientation: quatLookRotation(vec3(0, 0, -1)),
      velocity: vec3(0, 0, 0),
      position: vec3(0, 1000, 0),
    });
    const target = makeAircraft({
      id: "red-1",
      team: "red",
      velocity: vec3(0, 0, 0),
      position: vec3(0, 1000, -2000),
    });

    const events = step(
      [shooter, target],
      {
        "blue-1": controls({ throttle: 0, trigger: true }),
        "red-1": controls({ throttle: 0, trigger: false }),
      },
      1,
    );

    expect(events.some((e) => e.type === "shot")).toBe(true);
    expect(events.some((e) => e.type === "hit")).toBe(false);
    expect(target.health).toBe(100);
  });

  it("misses when the target is outside the gun cone", () => {
    const shooter = makeAircraft({
      id: "blue-1",
      team: "blue",
      orientation: quatLookRotation(vec3(0, 0, -1)),
      velocity: vec3(0, 0, 0),
      position: vec3(0, 1000, 0),
    });
    const target = makeAircraft({
      id: "red-1",
      team: "red",
      velocity: vec3(0, 0, 0),
      position: vec3(500, 1000, 0),
    });

    const events = step(
      [shooter, target],
      {
        "blue-1": controls({ throttle: 0, trigger: true }),
        "red-1": controls({ throttle: 0, trigger: false }),
      },
      1,
    );

    expect(events.some((e) => e.type === "hit")).toBe(false);
    expect(target.health).toBe(100);
  });

  it("clamps out-of-range control inputs to the protocol bounds", () => {
    const c = clampControlInput({ pitch: 5, roll: -9, yaw: 0.2, throttle: 3, trigger: true });
    expect(c).toEqual({ pitch: 1, roll: -1, yaw: 0.2, throttle: 1, trigger: true });
  });

  it("the demo match produces an actual engagement", async () => {
    const replay = await generateDemoMatch(28);
    const types = replay.frames.flatMap((frame) => frame.events.map((event) => event.type));

    expect(types.filter((t) => t === "shot").length).toBeGreaterThanOrEqual(1);
    expect(types.filter((t) => t === "hit").length).toBeGreaterThanOrEqual(1);

    const finalFrame = replay.frames[replay.frames.length - 1];
    const minHealth = Math.min(...finalFrame.aircraft.map((a) => a.health));
    expect(minHealth).toBeLessThan(100);
  });

  it("keeps every aircraft at or above the terrain floor", async () => {
    const replay = await generateDemoMatch(28);
    for (const frame of replay.frames) {
      for (const aircraft of frame.aircraft) {
        expect(aircraft.position.y).toBeGreaterThanOrEqual(55);
      }
    }
  });
});
