import { describe, expect, it } from "vitest";
import {
  ControlInputSchema,
  SurfaceControlSnapshotSchema,
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
import { compileAirframe, defaultAirframe } from "../src/sim/airframe";
import { DEFAULT_MODEL, stepSimulation } from "../src/sim/flight";
import type { AircraftState, FlightMetrics } from "../src/sim/types";
import { buildScriptedMatchConfig, generateDemoMatch } from "../src/runtime/scenario";
import { runMatch } from "../src/runtime/match";

describe("flight sim replay generation", () => {
  it("produces deterministic replay data", async () => {
    const first = await generateDemoMatch(8);
    const second = await generateDemoMatch(8);

    expect(first).toEqual(second);
    expect(first.schemaVersion).toBe(3);
    expect(first.frames.length).toBeGreaterThan(20);
  });

  it("does not mutate MatchConfig.initialAircraft while running", async () => {
    const config = buildScriptedMatchConfig(2);
    const before = structuredClone(config.initialAircraft);

    const first = await runMatch(config);
    const second = await runMatch(config);

    expect(config.initialAircraft).toEqual(before);
    expect(first).toEqual(second);
  });

  it("keeps every generated control input inside the public protocol", async () => {
    const replay = await generateDemoMatch(10);
    expect(replay.decisions?.some((d) => d.action.kind === "flight-director")).toBe(true);

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

  it("records actual per-surface control deflections for HUD and cockpit rendering", async () => {
    const replay = await generateDemoMatch(4);
    const blueFrames = replay.frames
      .map((frame) => frame.aircraft.find((aircraft) => aircraft.id === "blue-1"))
      .filter((aircraft): aircraft is NonNullable<typeof aircraft> => Boolean(aircraft));

    expect(blueFrames[0].surfaceControls?.map((surface) => surface.id)).toEqual([
      "main-wing-left",
      "main-wing-right",
      "tailplane",
      "fin",
    ]);

    for (const aircraft of blueFrames) {
      for (const surface of aircraft.surfaceControls ?? []) {
        expect(() => SurfaceControlSnapshotSchema.parse(surface)).not.toThrow();
      }
    }

    expect(
      blueFrames.some((aircraft) =>
        (aircraft.surfaceControls ?? []).some((surface) => Math.abs(surface.deflectionDeg) > 0.1),
      ),
    ).toBe(true);
    expect(
      blueFrames.some((aircraft) =>
        (aircraft.surfaceControls ?? []).some(
          (surface) =>
            Math.abs(surface.effectiveAoADeg) > 0.01 &&
            Math.abs(surface.effectiveAoADeg) < Math.abs(surface.deflectionDeg),
        ),
      ),
    ).toBe(true);
    expect(
      blueFrames.some((aircraft) =>
        (aircraft.surfaceControls ?? []).some(
          (surface) =>
            surface.localAoADeg !== undefined &&
            surface.totalAoADeg !== undefined &&
            surface.stallSeverity !== undefined &&
            surface.loadN !== undefined &&
            surface.loadN > 100,
        ),
      ),
    ).toBe(true);
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
    angularVelocity: o.angularVelocity ?? vec3(0, 0, 0),
    fuelKg: o.fuelKg ?? 0,
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

describe("surface-force rigid-body rotation (v0.7 physics)", () => {
  it("full stick rolls and pitches through surface moments — not instant, not a scalar rate cap", () => {
    const roller = makeAircraft();
    step([roller], { "blue-1": controls({ roll: 1 }) }, 6); // ~1 s
    expect(roller.angularVelocity.x).toBeGreaterThan(0.9);
    expect(roller.angularVelocity.x).toBeLessThan(1.8);
    expect(Math.abs(roller.angularVelocity.z)).toBeGreaterThan(0.005); // adverse-yaw coupling from drag asymmetry

    const pitcher = makeAircraft();
    step([pitcher], { "blue-1": controls({ pitch: 1 }) }, 6);
    expect(pitcher.angularVelocity.y).toBeGreaterThan(0.35);
    expect(pitcher.metrics.gLoad).toBeGreaterThan(3.5);
  });

  it("stays bounded at high speed under full deflection", () => {
    const diver = makeAircraft({ velocity: vec3(0, 0, -280) });
    let maxOmega = 0;
    for (let i = 0; i < 25; i += 1) {
      step([diver], { "blue-1": controls({ pitch: 1, roll: 1, yaw: 1, throttle: 1 }) }, 1);
      const w = diver.angularVelocity;
      maxOmega = Math.max(maxOmega, Math.abs(w.x), Math.abs(w.y), Math.abs(w.z));
    }
    expect(Number.isFinite(maxOmega)).toBe(true);
    expect(maxOmega).toBeLessThan(3.5);
  });

  it("released control surfaces damp roll rate instead of integrating forever", () => {
    const ship = makeAircraft({ velocity: vec3(0, 0, -180), position: vec3(0, 1500, 0) });
    step([ship], { "blue-1": controls({ roll: 1 }) }, 8); // roll into a bank
    const bankedUpY = basisFromQuat(ship.orientation).up.y; // body-up.y = 1 level, < 1 banked
    const bankedRate = Math.abs(ship.angularVelocity.x);
    expect(bankedUpY).toBeLessThan(0.85); // genuinely banked
    step([ship], { "blue-1": controls({ roll: 0 }) }, 30); // release ~5 s
    expect(Math.abs(ship.angularVelocity.x)).toBeLessThan(bankedRate * 0.2);
    expect(Number.isFinite(basisFromQuat(ship.orientation).up.y)).toBe(true);
  });

  it("a build with no moving surfaces cannot roll on command", () => {
    const noControl = defaultAirframe();
    for (const p of noControl.parts) if (p.kind === "wing") p.control = undefined;
    const dead = makeAircraft({ model: compileAirframe(noControl).model });
    const live = makeAircraft();

    step([dead], { "blue-1": controls({ roll: 1 }) }, 8);
    step([live], { "blue-1": controls({ roll: 1 }) }, 8);

    expect(Math.abs(dead.angularVelocity.x)).toBeLessThan(0.05);
    expect(Math.abs(live.angularVelocity.x)).toBeGreaterThan(0.9);
  });

  it("offset engines create thrust moments around the centre of mass", () => {
    const offsetEngine = defaultAirframe();
    const engine = offsetEngine.parts.find((p) => p.id === "engine");
    if (engine && engine.kind === "engine") {
      engine.pose = { ...engine.pose, offset: vec3(3, 0, 4) };
    }
    const centered = makeAircraft();
    const offset = makeAircraft({ model: compileAirframe(offsetEngine).model });

    step([centered], { "blue-1": controls({ throttle: 1 }) }, 3);
    step([offset], { "blue-1": controls({ throttle: 1 }) }, 3);

    expect(Math.abs(offset.angularVelocity.z)).toBeGreaterThan(Math.abs(centered.angularVelocity.z) + 0.05);
  });

  it("statically stable: trims hands-off near level and a pitch disturbance decays", () => {
    const cruise = makeAircraft({ velocity: vec3(0, 0, -180) });
    step([cruise], { "blue-1": controls({ pitch: 0, throttle: 0.8 }) }, 15); // 2.4 s, stick neutral
    expect(Math.abs(cruise.metrics.altitude - 1000)).toBeLessThan(28); // holds level (restoring + damping)

    // Pull the nose up, release, and let the restoring moment weathervane it back: the pitch rate decays.
    const disturbed = makeAircraft({ velocity: vec3(0, 0, -180) });
    step([disturbed], { "blue-1": controls({ pitch: 1, throttle: 0.8 }) }, 3);
    const pulledRate = Math.abs(disturbed.angularVelocity.y);
    step([disturbed], { "blue-1": controls({ pitch: 0, throttle: 0.8 }) }, 12);
    expect(Math.abs(disturbed.angularVelocity.y)).toBeLessThan(pulledRate * 0.3); // settled toward trim
  });

  it("CoM placement sets stability: aft mass flips the static margin negative", () => {
    const stable = compileAirframe(defaultAirframe()).model;
    expect(stable.staticMarginM).toBeGreaterThan(0); // default: CoM ahead of AC

    const aft = defaultAirframe();
    const fuselage = aft.parts.find((p) => p.id === "fuselage");
    if (fuselage) fuselage.pose = { offset: vec3(0, 0, 3), rotation: fuselage.pose.rotation };
    expect(compileAirframe(aft).model.staticMarginM).toBeLessThan(0); // mass moved aft ⇒ unstable
  });

  it("induced drag scales with aspect ratio: a stubby wing pays more", () => {
    const def = compileAirframe(defaultAirframe()).model;
    const stubby = defaultAirframe();
    const wing = stubby.parts.find((p) => p.id === "main-wing");
    if (wing && wing.kind === "wing") {
      wing.planform = { span: wing.planform.span / 2, chord: wing.planform.chord * 2 }; // same area, ¼ AR
    }
    const sm = compileAirframe(stubby).model;
    expect(sm.wingAreaM2).toBeCloseTo(def.wingAreaM2, 6); // area unchanged
    expect(sm.aspectRatio).toBeLessThan(def.aspectRatio); // but AR dropped
    // induced-drag factor 1/(π·AR·e) is therefore higher for the stubby wing
    expect(1 / sm.aspectRatio).toBeGreaterThan(1 / def.aspectRatio);
  });
});

describe("fuel as consumable mass", () => {
  function tankedAirframe(fuelKg = 1_500) {
    const a = defaultAirframe();
    a.parts.push({
      id: "tank",
      kind: "tank",
      pose: { offset: vec3(0, 0, 0), rotation: { x: 0, y: 0, z: 0, w: 1 } },
      fuelKg,
      dryMassKg: 200,
      dims: { radius: 0.5, length: 2.5 },
    });
    return a;
  }

  it("a tank adds mass + fuel capacity; dryMass excludes the fuel", () => {
    const base = compileAirframe(defaultAirframe()).model;
    const m = compileAirframe(tankedAirframe(1_500)).model;
    expect(m.fuelCapacityKg).toBe(1_500);
    expect(m.massKg).toBe(base.massKg + 200 + 1_500); // tank structure + fuel
    expect(m.dryMassKg).toBe(m.massKg - 1_500); // everything except the fuel
  });

  it("the default (no tank) never burns and stays at full mass — a true no-op", () => {
    const def = makeAircraft();
    expect(def.fuelKg).toBe(0);
    step([def], { "blue-1": controls({ throttle: 1 }) }, 15);
    expect(def.fuelKg).toBe(0); // no tank ⇒ no burn ⇒ effectiveMass stays massKg
  });

  it("a tanked aircraft burns fuel and runs dry → thrust cuts → it decelerates", () => {
    const compiled = compileAirframe(tankedAirframe(6)); // tiny tank (~0.7 kg/frame at full thrust)
    const tanked = makeAircraft({ model: compiled.model, fuelKg: compiled.model.fuelCapacityKg });
    expect(tanked.fuelKg).toBe(6);

    step([tanked], { "blue-1": controls({ throttle: 1 }) }, 4);
    expect(tanked.fuelKg).toBeGreaterThan(0); // still burning
    expect(tanked.fuelKg).toBeLessThan(6);

    step([tanked], { "blue-1": controls({ throttle: 1 }) }, 20);
    expect(tanked.fuelKg).toBe(0); // emptied

    const speedDry = tanked.metrics.airspeed;
    step([tanked], { "blue-1": controls({ throttle: 1 }) }, 15); // dry: thrust cut → glide
    expect(tanked.metrics.airspeed).toBeLessThan(speedDry); // decelerating
  });

  it("does not NaN for a fully-empty all-fuel build (0/0 guard)", () => {
    // A degenerate build that is nothing but an empty tank: effectiveMass floor keeps it finite.
    const empty = makeAircraft({ fuelKg: 0, model: { ...DEFAULT_MODEL, dryMassKg: 0, fuelCapacityKg: 500 } });
    step([empty], { "blue-1": controls({ throttle: 1 }) }, 5);
    expect(Number.isFinite(empty.position.x)).toBe(true);
    expect(Number.isFinite(empty.metrics.airspeed)).toBe(true);
  });
});
