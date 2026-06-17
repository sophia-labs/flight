import { describe, expect, it } from "vitest";
import {
  BodyTickTraceSchema,
  ControlInputSchema,
  SurfaceControlSnapshotSchema,
  clampControlInput,
  type ControlInput,
  type ReplayEvent,
} from "../src/protocol/schema";
import {
  add,
  basisFromQuat,
  dot,
  integrateLocalAngularVelocity,
  length,
  normalize,
  quatFromAxisAngle,
  quatIdentity,
  quatLookRotation,
  quatMultiply,
  scale,
  sub,
  vec3,
} from "../src/sim/math";
import { SEA_LEVEL_DENSITY_KG_M3, densityAtAltitude, stallSpeedMps } from "../src/sim/aero";
import { aircraftArchetypes } from "../src/sim/aircraftCatalog";
import { compileAirframe, defaultAirframe } from "../src/sim/airframe";
import {
  activeRadarLockAvailable,
  DEFAULT_MODEL,
  hasLoadedActiveRadarMissile,
  stepSimulation,
} from "../src/sim/flight";
import {
  currentMassProperties,
  fullFuelByTank,
  integrateBodyAngularVelocity,
  mat3Diagonal,
} from "../src/sim/mass";
import type { AircraftState, FlightMetrics, Projectile } from "../src/sim/types";
import {
  buildScriptedMatchConfig,
  createBalloonScenarioAircraft,
  createBalloonTarget,
  generateBalloonMatch,
  generateDemoMatch,
} from "../src/runtime/scenario";
import { runMatch } from "../src/runtime/match";
import { toObservation, perfectSensor, radarSensorModel } from "../src/agent/observation";
import { senseAndEncode } from "../src/agent/perception";
import { selectCameraDevice, selectRadarDevice } from "../src/sim/mountedSensor";

describe("flight sim replay generation", () => {
  it("produces deterministic replay data", async () => {
    const first = await generateDemoMatch(8);
    const second = await generateDemoMatch(8);

    expect(first).toEqual(second);
    expect(first.schemaVersion).toBe(4);
    expect(first.frames.length).toBeGreaterThan(20);
    expect(first.bodyTicks?.length).toBeGreaterThan(20);
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
    expect(replay.decisions?.some((d) => d.action.kind === "pilot-intent")).toBe(true);
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

  it("records the embodied Body loop from muscle command to actual result", async () => {
    const replay = await generateDemoMatch(4);
    const bodyTicks = replay.bodyTicks ?? [];
    expect(bodyTicks.length).toBe(60);

    for (const tick of bodyTicks) {
      expect(() => BodyTickTraceSchema.parse(tick)).not.toThrow();
      expect(tick.agentId).toBe("blue-1");
      expect(tick.pilotIntent.kind).toBe("pilot-intent");
      expect(tick.rawOutput).toContain("MUSCLE");
      expect(tick.promptText).toContain("LAST");
      expect(tick.promptText).toContain("SENSE");
    }

    const first = bodyTicks[0];
    expect(first.parsed.muscle).toBeDefined();
    const desiredRoll = first.parsed.muscle!.roll / 5;
    const desiredPitch = first.parsed.muscle!.pitch / 5;
    const desiredYaw = first.parsed.muscle!.yaw / 5;
    const desiredThrottle = first.parsed.muscle!.push / 5;
    expect(Math.sign(first.controlInput.roll || desiredRoll)).toBe(Math.sign(desiredRoll || first.controlInput.roll));
    expect(Math.abs(first.controlInput.roll)).toBeLessThanOrEqual(Math.abs(desiredRoll));
    expect(Math.sign(first.controlInput.pitch || desiredPitch)).toBe(Math.sign(desiredPitch || first.controlInput.pitch));
    expect(Math.abs(first.controlInput.pitch)).toBeLessThanOrEqual(Math.abs(desiredPitch));
    expect(Math.sign(first.controlInput.yaw || desiredYaw)).toBe(Math.sign(desiredYaw || first.controlInput.yaw));
    expect(Math.abs(first.controlInput.yaw)).toBeLessThanOrEqual(Math.abs(desiredYaw));
    expect(first.controlInput.throttle).toBeLessThanOrEqual(Math.max(1, desiredThrottle));
    expect(bodyTicks.every((tick) => tick.parsed.status !== "failed")).toBe(true);
    expect(bodyTicks.some((tick) => tick.mismatch.length > 0)).toBe(true);
    expect(bodyTicks.some((tick) => tick.parsed.feel && tick.parsed.memory !== undefined)).toBe(true);
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

  it("integrates local angular velocity as a normalized quaternion delta", () => {
    const orientation = quatLookRotation(vec3(1, 0.2, -1));
    const stepped = integrateLocalAngularVelocity(orientation, vec3(0, 0, -2), 0.25);
    const expected = quatMultiply(orientation, quatFromAxisAngle(vec3(0, 0, -1), 0.5));

    expect(dot(basisFromQuat(stepped).up, basisFromQuat(expected).up)).toBeGreaterThan(0.99999);
    expect(Math.hypot(stepped.x, stepped.y, stepped.z, stepped.w)).toBeCloseTo(1, 8);
  });

  it("integrates rigid-body angular velocity with gyroscopic coupling", () => {
    const next = integrateBodyAngularVelocity(
      vec3(0.2, 0.6, 1.1),
      vec3(0, 0, 0),
      mat3Diagonal(10, 20, 35),
      0.2,
    );

    expect(Math.abs(next.x - 0.2)).toBeGreaterThan(0.001);
    expect(Math.abs(next.y - 0.6)).toBeGreaterThan(0.001);
    expect(Math.abs(next.z - 1.1)).toBeGreaterThan(0.001);
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
    fuelByTankKg: o.fuelByTankKg ?? fullFuelByTank(o.model ?? DEFAULT_MODEL),
    devices: o.devices,
    airframe: o.airframe,
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
  // Thread live projectiles + the running clock across steps, exactly as the match loop does, so a
  // spawned round integrates and sweeps over subsequent steps (no per-call reset).
  let projectiles: Projectile[] = [];
  let time = 0;
  for (let i = 0; i < steps; i += 1) {
    const result = stepSimulation(aircraft, controlsById, STEP_DT, projectiles, time);
    projectiles = result.projectiles;
    events.push(...result.events);
    time += STEP_DT;
  }
  return events;
}

function archetypeModel(id: string) {
  const archetype = aircraftArchetypes.find((candidate) => candidate.id === id);
  if (!archetype) throw new Error(`missing archetype ${id}`);
  return compileAirframe(archetype.airframe).model;
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

  it("flags stall below the computed stall speed", () => {
    const ship = makeAircraft({ velocity: vec3(0, 0, -40) });

    step([ship], { "blue-1": controls({ throttle: 0.5 }) }, 1);

    expect(ship.metrics.stalled).toBe(true);
  });

  it("computes stall speed from wing loading and air density", () => {
    const base = compileAirframe(defaultAirframe()).model;
    const stubby = defaultAirframe();
    const wing = stubby.parts.find((p) => p.id === "main-wing");
    if (wing && wing.kind === "wing") {
      wing.planform = { ...wing.planform, span: wing.planform.span * 0.55 };
    }
    const stubbyModel = compileAirframe(stubby).model;
    const baseStall = stallSpeedMps(base, SEA_LEVEL_DENSITY_KG_M3, base.massKg);

    expect(stallSpeedMps(stubbyModel, SEA_LEVEL_DENSITY_KG_M3, stubbyModel.massKg)).toBeGreaterThan(baseStall);
    expect(stallSpeedMps(base, densityAtAltitude(3_000), base.massKg)).toBeGreaterThan(baseStall);
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

  it("reports Super Tomcat sweep and delayed afterburner spool in live high-Mach flight", () => {
    const model = archetypeModel("variable-sweep-tomcat");
    const ship = makeAircraft({
      model,
      position: vec3(0, 14_000, 0),
      velocity: vec3(0, 0, -620),
      fuelKg: model.fuelCapacityKg,
      fuelByTankKg: fullFuelByTank(model),
    });

    step([ship], { "blue-1": controls({ throttle: 1 }) }, 1);
    const firstFrameSpool = ship.metrics.engineSpool ?? 0;
    expect(firstFrameSpool).toBeGreaterThan(0.14);
    expect(firstFrameSpool).toBeLessThan(0.5);
    expect(ship.metrics.afterburner).toBe(false);

    step([ship], { "blue-1": controls({ throttle: 1 }) }, 12);

    expect(ship.metrics.mach).toBeGreaterThan(2);
    expect(ship.metrics.sweepDeg).toBeGreaterThan(60);
    expect(ship.metrics.engineSpool).toBeGreaterThan(0.82);
    expect(ship.metrics.afterburner).toBe(true);
  });

  it("damages Mach-aero aircraft when they exceed q or Mach limits", () => {
    const model = archetypeModel("variable-sweep-tomcat");
    const ship = makeAircraft({
      model,
      position: vec3(0, 1_000, 0),
      velocity: vec3(0, 0, -560),
      fuelKg: model.fuelCapacityKg,
      fuelByTankKg: fullFuelByTank(model),
    });

    step([ship], { "blue-1": controls({ throttle: 0 }) }, 3);

    expect(ship.metrics.dynamicPressurePa).toBeGreaterThan(model.machAero?.qLimitPa ?? Infinity);
    expect(ship.health).toBeLessThan(100);
    expect(ship.metrics.stalled).toBe(true);
  });

  // v0.9.x projectiles: the gun fires a real bullet (900 m/s) that flies where the nose points and is
  // swept against targets over several steps — no more instant hitscan cone. A dead-on shot connects;
  // a 14deg-off lob flies past even a fat target.
  it("a dead-on shot spawns a round that connects after travel", () => {
    const shooter = makeAircraft({
      id: "blue-1",
      team: "blue",
      orientation: quatLookRotation(vec3(0, 0, -1)),
      velocity: vec3(0, 0, 0),
      position: vec3(0, 1000, 0),
      weaponCooldown: 0,
    });
    const target = makeAircraft({ id: "red-1", team: "red", velocity: vec3(0, 0, 0), position: vec3(0, 1000, -500) });

    const events = step(
      [shooter, target],
      {
        "blue-1": controls({ throttle: 0, trigger: true }),
        "red-1": controls({ throttle: 0, trigger: false }),
      },
      6, // ~1 s — a 900 m/s round covers the 500 m before this runs out
    );

    expect(events.some((e) => e.type === "shot")).toBe(true);
    expect(events.some((e) => e.type === "hit" && e.targetId === "red-1")).toBe(true);
    expect(target.health).toBeLessThan(100);
  });

  it("a Super Tomcat trigger launches an AIM-9M heat seeker and spends station ammo", () => {
    const model = archetypeModel("variable-sweep-tomcat");
    const shooter = makeAircraft({
      id: "blue-1",
      team: "blue",
      model,
      orientation: quatLookRotation(vec3(0, 0, -1)),
      velocity: vec3(0, 0, 0),
      position: vec3(0, 1000, 0),
      fuelKg: model.fuelCapacityKg,
      fuelByTankKg: fullFuelByTank(model),
      weaponCooldown: 0,
    });
    const target = makeAircraft({ id: "red-1", team: "red", velocity: vec3(0, 0, 0), position: vec3(0, 1000, -700) });

    let result = stepSimulation(
      [shooter, target],
      {
        "blue-1": controls({ throttle: 0, trigger: true }),
        "red-1": controls({ throttle: 0, trigger: false }),
      },
      STEP_DT,
      [],
      0,
    );

    expect(result.events.filter((e) => e.type === "shot")).toHaveLength(1);
    expect(result.events[0].message).toContain("launches AIM-9M");
    expect(result.projectiles).toHaveLength(1);
    expect(result.projectiles[0]).toMatchObject({
      kind: "missile",
      guidance: "heat-seeking",
      missileModel: "aim-9m",
      lockState: "acquired",
      ownerId: "blue-1",
      targetId: "red-1",
    });
    expect(shooter.weaponAmmo?.["m61-and-missiles"]).toBe(7);

    let projectiles = result.projectiles;
    let time = STEP_DT;
    const events = [...result.events];
    for (let i = 0; i < 10 && target.health === 100; i += 1) {
      result = stepSimulation(
        [shooter, target],
        {
          "blue-1": controls({ throttle: 0, trigger: true }),
          "red-1": controls({ throttle: 0, trigger: false }),
        },
        STEP_DT,
        projectiles,
        time,
      );
      projectiles = result.projectiles;
      events.push(...result.events);
      time += STEP_DT;
    }

    expect(events.some((e) => e.type === "hit" && e.message.includes("missile"))).toBe(true);
    expect(target.health).toBeLessThanOrEqual(28);
  });

  it("AIM-9M guidance can lead a moving off-boresight target", () => {
    const model = archetypeModel("variable-sweep-tomcat");
    const shooter = makeAircraft({
      id: "blue-1",
      team: "blue",
      model,
      orientation: quatLookRotation(vec3(0, 0, -1)),
      velocity: vec3(0, 0, -220),
      position: vec3(0, 1500, 0),
      fuelKg: model.fuelCapacityKg,
      fuelByTankKg: fullFuelByTank(model),
      weaponCooldown: 0,
    });
    const target = makeAircraft({
      id: "red-1",
      team: "red",
      model,
      orientation: quatLookRotation(vec3(80, 0, -160)),
      velocity: vec3(80, 0, -160),
      position: vec3(80, 1500, -1000),
      fuelKg: model.fuelCapacityKg,
      fuelByTankKg: fullFuelByTank(model),
    });

    let projectiles: Projectile[] = [];
    let time = 0;
    const events: ReplayEvent[] = [];
    for (let i = 0; i < 160 && target.health === 100; i += 1) {
      const result = stepSimulation(
        [shooter, target],
        {
          "blue-1": controls({ throttle: 1, trigger: i === 0 }),
          "red-1": controls({ throttle: 1, trigger: false }),
        },
        0.05,
        projectiles,
        time,
      );
      projectiles = result.projectiles;
      events.push(...result.events);
      time += 0.05;
    }

    expect(events.some((e) => e.type === "shot" && e.message.includes("AIM-9M"))).toBe(true);
    expect(events.some((e) => e.type === "hit" && e.targetId === "red-1")).toBe(true);
    expect(target.health).toBeLessThanOrEqual(28);
  });

  it("surfaces active-radar missile loadout and radar lock in pilot observations", () => {
    const tomcat = aircraftArchetypes.find((candidate) => candidate.id === "variable-sweep-tomcat")!;
    const compiled = compileAirframe(tomcat.airframe);
    const shooter = makeAircraft({
      id: "blue-1",
      team: "blue",
      model: compiled.model,
      devices: compiled.devices,
      orientation: quatLookRotation(vec3(0, 0, -1)),
      velocity: vec3(0, 0, -320),
      position: vec3(0, 10_000, 0),
      fuelKg: compiled.model.fuelCapacityKg,
      fuelByTankKg: fullFuelByTank(compiled.model),
      weaponCooldown: 0,
    });
    const target = makeAircraft({
      id: "red-1",
      team: "red",
      velocity: vec3(0, 0, -120),
      position: vec3(0, 10_000, -25_000),
    });
    const radar = selectRadarDevice(shooter.devices);

    expect(hasLoadedActiveRadarMissile(shooter)).toBe(true);
    expect(radar).toBeDefined();
    expect(activeRadarLockAvailable(shooter, target)).toBe(true);

    const obs = toObservation(shooter, [shooter, target], 1, 0, radarSensorModel(radar!));
    expect(obs.self.radarMissileLoaded).toBe(true);
    expect(obs.contacts).toHaveLength(1);
    expect(obs.contacts[0]).toMatchObject({ id: "red-1", radarLock: true });
    expect(obs.contacts[0].missileLock).toBeUndefined();
  });

  it("active-radar missile launches on radar track and kills at BVR range", () => {
    const tomcat = aircraftArchetypes.find((candidate) => candidate.id === "variable-sweep-tomcat")!;
    const compiled = compileAirframe(tomcat.airframe);
    const shooter = makeAircraft({
      id: "blue-1",
      team: "blue",
      model: compiled.model,
      devices: compiled.devices,
      orientation: quatLookRotation(vec3(0, 0, -1)),
      velocity: vec3(0, 0, -320),
      position: vec3(0, 10_000, 0),
      fuelKg: compiled.model.fuelCapacityKg,
      fuelByTankKg: fullFuelByTank(compiled.model),
      weaponCooldown: 0,
    });
    const target = makeAircraft({
      id: "red-1",
      team: "red",
      orientation: quatLookRotation(vec3(0, 0, -1)),
      velocity: vec3(0, 0, -120),
      position: vec3(0, 10_000, -25_000),
    });

    let result = stepSimulation(
      [shooter, target],
      {
        "blue-1": controls({ throttle: 0.9, trigger: true }),
        "red-1": controls({ throttle: 0.55, trigger: false }),
      },
      0.1,
      [],
      0,
    );

    expect(result.events.filter((e) => e.type === "shot")).toHaveLength(1);
    expect(result.events[0].message).toContain("launches AIM-54C");
    expect(result.projectiles[0]).toMatchObject({
      kind: "missile",
      guidance: "active-radar",
      missileModel: "aim-54c",
      lockState: "acquired",
      ownerId: "blue-1",
      targetId: "red-1",
    });
    expect(shooter.weaponAmmo?.["phoenix-radar-missiles"]).toBe(3);
    expect(shooter.weaponAmmo?.["m61-and-missiles"]).toBeUndefined();

    let projectiles = result.projectiles;
    let time = 0.1;
    const events = [...result.events];
    for (let i = 0; i < 360 && target.health > 0; i += 1) {
      result = stepSimulation(
        [shooter, target],
        {
          "blue-1": controls({ throttle: 0.9, trigger: true }),
          "red-1": controls({ throttle: 0.55, trigger: false }),
        },
        0.1,
        projectiles,
        time,
      );
      projectiles = result.projectiles;
      events.push(...result.events);
      time += 0.1;
    }

    expect(events.some((e) => e.type === "hit" && e.targetId === "red-1" && e.message.includes("radar missile"))).toBe(true);
    expect(target.health).toBe(0);
  });

  it("misses when the target is out of range (the round despawns short)", () => {
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
      position: vec3(0, 1000, -4000), // beyond the round's 2900 m reach
    });

    const events = step(
      [shooter, target],
      {
        "blue-1": controls({ throttle: 0, trigger: true }),
        "red-1": controls({ throttle: 0, trigger: false }),
      },
      20,
    );

    expect(events.some((e) => e.type === "shot")).toBe(true);
    expect(events.some((e) => e.type === "hit")).toBe(false);
    expect(target.health).toBe(100);
  });

  it("a ~14deg-off lob MISSES a fat target (the round flies past, not a forgiving cone)", () => {
    // Aim ~14deg to the right of a target 600 m dead ahead. The bullet flies along the nose, so its
    // closest approach is ~600*sin(14deg) ≈ 145 m off — well outside even the 42 m balloon radius.
    const offAngle = (14 * Math.PI) / 180;
    const shooter = makeAircraft({
      id: "blue-1",
      team: "blue",
      orientation: quatLookRotation(vec3(Math.sin(offAngle), 0, -Math.cos(offAngle))),
      velocity: vec3(0, 0, 0),
      position: vec3(0, 1000, 0),
    });
    // A fat balloon-sized target dead ahead at -Z; the old hitscan cone (0.42 rad ≈ 24deg) would have
    // "hit" this. With real bullets, the 14deg-off round sails past.
    const target = makeAircraft({ id: "red-1", team: "red", velocity: vec3(0, 0, 0), position: vec3(0, 1000, -600) });

    const events = step(
      [shooter, target],
      {
        "blue-1": controls({ throttle: 0, trigger: true }),
        "red-1": controls({ throttle: 0, trigger: false }),
      },
      10,
    );

    expect(events.some((e) => e.type === "shot")).toBe(true);
    expect(events.some((e) => e.type === "hit")).toBe(false);
    expect(target.health).toBe(100);
  });

  it("holding the trigger fires one round per cooldown, not a stream every frame", () => {
    const shooter = makeAircraft({
      id: "blue-1",
      team: "blue",
      orientation: quatLookRotation(vec3(0, 0, -1)),
      velocity: vec3(0, 0, 0),
      position: vec3(0, 1000, 0),
      weaponCooldown: 0,
    });
    const target = makeAircraft({ id: "red-1", team: "red", velocity: vec3(0, 0, 0), position: vec3(0, 1000, -800) });

    // Hold the trigger for ~3.2 s (20 steps). Cooldown is 2.65 s, so exactly two rising-edge shots fire.
    const events = step(
      [shooter, target],
      {
        "blue-1": controls({ throttle: 0, trigger: true }),
        "red-1": controls({ throttle: 0, trigger: false }),
      },
      20,
    );
    const shots = events.filter((e) => e.type === "shot").length;
    expect(shots).toBe(2);
  });

  it("clamps out-of-range control inputs to the protocol bounds", () => {
    const c = clampControlInput({ pitch: 5, roll: -9, yaw: 0.2, throttle: 3, trigger: true });
    expect(c).toEqual({ pitch: 1, roll: -1, yaw: 0.2, throttle: 1, trigger: true });
  });

  it("the demo match produces visible Body-controlled flight instead of a hidden autopilot", async () => {
    const replay = await generateDemoMatch(28);
    const bodyTicks = replay.bodyTicks ?? [];

    expect(bodyTicks.length).toBeGreaterThan(100);
    expect(bodyTicks.every((tick) => tick.parsed.status !== "failed")).toBe(true);
    expect(bodyTicks.some((tick) => Math.abs(tick.controlInput.roll) > 0.5)).toBe(true);
    expect(bodyTicks.some((tick) => Math.abs(tick.controlInput.pitch) > 0.1)).toBe(true);

    // Embodied FOV vision makes landing a shot incidental, so we don't gate on a resolved hit.
    // What the demo must prove: the Body actually SEES the enemy in its glyph-field (the field-feed)
    // and flies under its own control toward it.
    const sawEnemyInField = bodyTicks.some((tick) => / o'clock .* rng \d+/.test(tick.promptText));
    expect(sawEnemyInField).toBe(true);
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

  it("a tanked aircraft burns fuel and runs dry → throttle no longer produces thrust", () => {
    const compiled = compileAirframe(tankedAirframe(6)); // tiny tank (~0.7 kg/frame at full thrust)
    const tanked = makeAircraft({ model: compiled.model, fuelKg: compiled.model.fuelCapacityKg });
    expect(tanked.fuelKg).toBe(6);

    step([tanked], { "blue-1": controls({ throttle: 1 }) }, 4);
    expect(tanked.fuelKg).toBeGreaterThan(0); // still burning
    expect(tanked.fuelKg).toBeLessThan(6);

    step([tanked], { "blue-1": controls({ throttle: 1 }) }, 20);
    expect(tanked.fuelKg).toBe(0); // emptied

    const dryFull = structuredClone(tanked) as AircraftState;
    const dryIdle = structuredClone(tanked) as AircraftState;
    step([dryFull], { "blue-1": controls({ throttle: 1 }) }, 15);
    step([dryIdle], { "blue-1": controls({ throttle: 0 }) }, 15);
    expect(dryFull.metrics.airspeed).toBeCloseTo(dryIdle.metrics.airspeed, 6);
  });

  it("tracks fuel by tank and updates CoM/inertia as fuel burns", () => {
    const foreAftTanks = defaultAirframe();
    foreAftTanks.parts.push(
      {
        id: "fore-tank",
        kind: "tank",
        pose: { offset: vec3(0, 0, -3), rotation: quatIdentity() },
        fuelKg: 80,
        dryMassKg: 30,
        dims: { radius: 0.35, length: 1.4 },
      },
      {
        id: "aft-tank",
        kind: "tank",
        pose: { offset: vec3(0, 0, 5), rotation: quatIdentity() },
        fuelKg: 160,
        dryMassKg: 30,
        dims: { radius: 0.35, length: 1.4 },
      },
    );
    const compiled = compileAirframe(foreAftTanks);
    const ship = makeAircraft({
      model: compiled.model,
      fuelKg: compiled.model.fuelCapacityKg,
      fuelByTankKg: fullFuelByTank(compiled.model),
    });
    const wet = currentMassProperties(ship);

    step([ship], { "blue-1": controls({ throttle: 1 }) }, 12);
    const burned = currentMassProperties(ship);

    expect(ship.fuelByTankKg?.["fore-tank"]).toBeLessThan(80);
    expect(ship.fuelByTankKg?.["aft-tank"]).toBeLessThan(160);
    expect(burned.massKg).toBeLessThan(wet.massKg);
    expect(burned.com.z).not.toBeCloseTo(wet.com.z, 5);
    expect(burned.inertia.roll).toBeLessThan(wet.inertia.roll);
  });

  it("does not NaN for a fully-empty all-fuel build (0/0 guard)", () => {
    // A degenerate build that is nothing but an empty tank: effectiveMass floor keeps it finite.
    const empty = makeAircraft({ fuelKg: 0, model: { ...DEFAULT_MODEL, dryMassKg: 0, fuelCapacityKg: 500 } });
    step([empty], { "blue-1": controls({ throttle: 1 }) }, 5);
    expect(Number.isFinite(empty.position.x)).toBe(true);
    expect(Number.isFinite(empty.metrics.airspeed)).toBe(true);
  });
});

// The founding challenge made real: a static red BALLOON the embodied Body can perceive + pop. These
// pin the three load-bearing properties: it is perceived as a contact, it HOVERS, and a roughly-aimed
// in-range trigger destroys it.
describe("balloon target", () => {
  it("hovers in place — static skips flight integration (no fall/stall/move)", () => {
    const balloon = createBalloonTarget(vec3(0, 1000, 0));
    const before = { ...balloon.position };
    // Step it for a couple of seconds with whatever controls — a static entity must not budge or fall.
    step([balloon], { balloon: controls({ throttle: 1, pitch: -1 }) }, 25);
    expect(balloon.position).toEqual(before);
    expect(balloon.velocity).toEqual(vec3(0, 0, 0));
    expect(balloon.metrics.stalled).toBe(false);
    expect(balloon.health).toBe(12); // untouched, no terrain scrape
  });

  it("is perceived by the Body as a contact in the camera field and the Observation", () => {
    const [self, balloon] = createBalloonScenarioAircraft();
    // Point the Body straight at the balloon so it falls inside the cockpit-cam viewport.
    self.orientation = quatLookRotation(normalize(vec3(
      balloon.position.x - self.position.x,
      balloon.position.y - self.position.y,
      balloon.position.z - self.position.z,
    )));
    const device = selectCameraDevice(self.devices);
    const percept = senseAndEncode(device, [self, balloon], self);
    const contact = (percept.contacts ?? []).find((c) => c.id === "balloon");
    expect(contact).toBeDefined();
    expect(contact!.inView).toBe(true);
    // The fat balloon subtends a far bigger glyph than a 16 m airframe would at the same ~5 km range.
    expect(contact!.angularSizeDeg).toBeGreaterThan(0.6);

    // It is also the nearest (only) enemy in the scripted Pilot's Observation.
    const obs = toObservation(self, [self, balloon], 1, 0, perfectSensor);
    expect(obs.contacts[0]?.id).toBe("balloon");
  });

  it("is destroyed by a roughly-aimed in-range trigger (health -> 0, hit event)", () => {
    const balloon = createBalloonTarget(vec3(0, 1000, -600));
    // Shooter 600 m back, nose on the balloon, trigger down — a generous balloon cone makes this hit.
    const shooter = makeAircraft({
      id: "blue-1",
      position: vec3(0, 1000, 0),
      orientation: quatLookRotation(vec3(0, 0, -1)),
      weaponCooldown: 0,
      controls: controls({ trigger: true }),
    });
    const events = step([shooter, balloon], { "blue-1": controls({ trigger: true }) }, 30);
    const hit = events.find((e) => e.type === "hit" && e.targetId === "balloon");
    expect(hit).toBeDefined();
    expect(balloon.health).toBe(0); // popped
  });

  it("the scripted Body match pursues + tracks + fires real rounds at the balloon end to end", async () => {
    const replay = await generateBalloonMatch(16);
    const balloonFrames = replay.frames.flatMap((f) => f.aircraft.filter((a) => a.id === "balloon"));
    // The balloon never moves across the whole match (hovers).
    const p0 = balloonFrames[0].position;
    for (const b of balloonFrames) expect(b.position).toEqual(p0);
    // The balloon snapshot carries the static flag for the renderer.
    expect(balloonFrames[0].static).toBe(true);

    // v0.9.x — the gun is no longer a forgiving hitscan cone; it spawns REAL bullets that fly where the
    // nose points. The scripted Body acquires the balloon, closes, and fires real rounds at it — the end-
    // to-end loop runs. The Body's Pilot trigger gate is loose (it sprays at ~26deg), so the unforgiving
    // gun no longer guarantees a pop here; reliably converting alignment into a kill is the job of the
    // Phase-2 assisted sear (the Body calling its own SOLUTION=now only on a true intercept).
    const shots = replay.frames.flatMap((f) => f.events).filter((e) => e.type === "shot" && e.actorId === "blue-1");
    expect(shots.length).toBeGreaterThan(0); // it gets a gun run and pulls the trigger
    // It tracks the balloon TIGHTLY at some point — far tighter than the old 24deg cone — proving real
    // aim, not spray-and-pray: at its best it lines the gun axis within the balloon's hit radius.
    const tightlyAligned = replay.frames.some((f) => {
      const body = f.aircraft.find((a) => a.id === "blue-1");
      const bal = f.aircraft.find((a) => a.id === "balloon");
      if (!body || !bal) return false;
      const fwd = basisFromQuat(body.orientation).forward;
      const muzzle = add(body.position, scale(fwd, 18));
      const t = dot(sub(bal.position, muzzle), fwd);
      if (t <= 0) return false;
      const perp = length(sub(bal.position, add(muzzle, scale(fwd, t))));
      const range = length(sub(bal.position, body.position));
      return perp <= 42 && range <= 2_900; // gun axis within the balloon's hit radius, in range
    });
    expect(tightlyAligned).toBe(true);
  });
});
