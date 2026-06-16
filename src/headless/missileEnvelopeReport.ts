import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ReplayEvent } from "../protocol/schema";
import { aircraftArchetypes } from "../sim/aircraftCatalog";
import { compileAirframe } from "../sim/airframe";
import { AIM9M_SIDEWINDER_PROFILE, stepSimulation, targetHeatSignature } from "../sim/flight";
import { fullFuelByTank } from "../sim/mass";
import { length, quatLookRotation, sub, vec3 } from "../sim/math";
import type { AircraftModel, AircraftState, Projectile } from "../sim/types";

type MissileAspect = "rear" | "head-on" | "beam-left" | "beam-right";
type TargetManeuver = "steady" | "jink";

export interface MissileEnvelopeCase {
  id: string;
  aspect: MissileAspect;
  rangeM: number;
  lateralOffsetM: number;
  shooterSpeedMps: number;
  targetSpeedMps: number;
  targetThrottle: number;
  targetAfterburner: boolean;
  maneuver: TargetManeuver;
}

export interface MissileEnvelopeResult {
  id: string;
  aspect: MissileAspect;
  rangeM: number;
  lateralOffsetM: number;
  targetSpeedMps: number;
  targetThrottle: number;
  targetAfterburner: boolean;
  maneuver: TargetManeuver;
  hit: boolean;
  timeToHitS?: number;
  missReason?: "no-shot" | "no-lock" | "lock-lost" | "kinematic-miss" | "timeout";
  initialLock: boolean;
  lockAcquired: boolean;
  lockLost: boolean;
  initialSignal?: number;
  maxSignal?: number;
  initialTargetHeat: number;
  peakSeekerAngleDeg: number;
  minMissDistanceM: number;
  missileTravelM: number;
  eventMessages: string[];
}

interface MissileEnvelopeReport {
  schemaVersion: 1;
  generatedAt: string;
  missileProfile: typeof AIM9M_SIDEWINDER_PROFILE;
  historicalAnchor: {
    source: string;
    url: string;
    speed: string;
    range: string;
    guidance: string;
  };
  summary: {
    cases: number;
    hits: number;
    hitRate: number;
  };
  cases: MissileEnvelopeResult[];
}

const argv = process.argv.slice(2);
const out = resolve(flag("--out") ?? "reports/missile-envelope.json");
const dt = numberFlag("--dt", 0.05);
const maxTimeS = numberFlag("--max-time", 28);
const altitudeM = numberFlag("--altitude", 1_500);

function flag(name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function numberFlag(name: string, fallback: number): number {
  const raw = flag(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive finite number`);
  return value;
}

function tomcatModel(): AircraftModel {
  const archetype = aircraftArchetypes.find((candidate) => candidate.id === "variable-sweep-tomcat");
  if (!archetype) throw new Error("missing variable-sweep-tomcat archetype");
  return compileAirframe(archetype.airframe).model;
}

function controls(throttle: number, trigger: boolean, maneuver: TargetManeuver = "steady", time = 0) {
  if (maneuver === "jink") {
    return {
      pitch: Math.sin(time * 2.1) * 0.32,
      roll: Math.sin(time * 1.5 + 0.4) * 0.74,
      yaw: Math.sin(time * 1.8 + 1.2) * 0.16,
      throttle,
      trigger,
    };
  }
  return { pitch: 0, roll: 0, yaw: 0, throttle, trigger };
}

function makeAircraft(
  model: AircraftModel,
  id: string,
  team: "blue" | "red",
  position: ReturnType<typeof vec3>,
  velocity: ReturnType<typeof vec3>,
  throttle: number,
  afterburner: boolean,
): AircraftState {
  return {
    id,
    callsign: id === "blue-1" ? "Super Tomcat" : "Target",
    team,
    color: team === "blue" ? "#4da3ff" : "#ff6b61",
    position,
    velocity,
    orientation: quatLookRotation(velocity),
    controls: controls(throttle, false),
    health: 100,
    weaponCooldown: 0,
    model,
    metrics: {
      airspeed: length(velocity),
      altitude: position.y,
      aoaDeg: 0,
      gLoad: 1,
      stalled: false,
      afterburner,
      engineSpool: throttle,
    },
    angularVelocity: vec3(0, 0, 0),
    fuelKg: model.fuelCapacityKg,
    fuelByTankKg: fullFuelByTank(model),
    engineSpool: throttle,
  };
}

function targetVelocity(c: MissileEnvelopeCase) {
  if (c.aspect === "head-on") return vec3(0, 0, c.targetSpeedMps);
  if (c.aspect === "beam-left") return vec3(-c.targetSpeedMps, 0, 0);
  if (c.aspect === "beam-right") return vec3(c.targetSpeedMps, 0, 0);
  return vec3(0, 0, -c.targetSpeedMps);
}

function runCase(model: AircraftModel, c: MissileEnvelopeCase): MissileEnvelopeResult {
  const shooter = makeAircraft(
    model,
    "blue-1",
    "blue",
    vec3(0, altitudeM, 0),
    vec3(0, 0, -c.shooterSpeedMps),
    1,
    true,
  );
  const target = makeAircraft(
    model,
    "red-1",
    "red",
    vec3(c.lateralOffsetM, altitudeM, -c.rangeM),
    targetVelocity(c),
    c.targetThrottle,
    c.targetAfterburner,
  );

  let projectiles: Projectile[] = [];
  let time = 0;
  let shotSeen = false;
  let projectileSeen = false;
  let hit = false;
  let timeToHitS: number | undefined;
  let initialLock = false;
  let lockAcquired = false;
  let lockLost = false;
  let initialSignal: number | undefined;
  let maxSignal: number | undefined;
  let peakSeekerAngleDeg = 0;
  let minMissDistanceM = Infinity;
  let missileTravelM = 0;
  const events: ReplayEvent[] = [];
  const initialTargetHeat = targetHeatSignature(target, shooter.position);

  for (let i = 0; i < Math.ceil(maxTimeS / dt); i += 1) {
    const result = stepSimulation(
      [shooter, target],
      {
        "blue-1": controls(1, i === 0),
        "red-1": controls(c.targetThrottle, false, c.maneuver, time),
      },
      dt,
      projectiles,
      time,
    );
    projectiles = result.projectiles;
    events.push(...result.events);
    shotSeen ||= result.events.some((event) => event.type === "shot");
    const hitEvent = result.events.find((event) => event.type === "hit" && event.targetId === target.id);
    if (hitEvent) {
      hit = true;
      timeToHitS = Number((time + dt).toFixed(3));
    }

    for (const projectile of projectiles) {
      if (projectile.kind !== "missile") continue;
      projectileSeen = true;
      const range = length(sub(projectile.position, target.position));
      minMissDistanceM = Math.min(minMissDistanceM, range);
      missileTravelM = Math.max(missileTravelM, projectile.distanceTravelledM);
      if (projectile.lockState === "acquired") {
        lockAcquired = true;
        initialLock ||= projectile.distanceTravelledM < 1;
      }
      if (projectile.lockState === "lost") lockLost = true;
      if (projectile.seekerAngleRad !== undefined) {
        peakSeekerAngleDeg = Math.max(peakSeekerAngleDeg, (projectile.seekerAngleRad * 180) / Math.PI);
      }
      if (projectile.lockSignal !== undefined) {
        initialSignal ??= projectile.lockSignal;
        maxSignal = Math.max(maxSignal ?? 0, projectile.lockSignal);
      }
    }

    time += dt;
    if (hit) break;
    if (shotSeen && projectileSeen && projectiles.length === 0) break;
  }

  const missReason = hit
    ? undefined
    : !shotSeen
      ? "no-shot"
      : !lockAcquired
        ? "no-lock"
        : lockLost
          ? "lock-lost"
          : projectileSeen
            ? "timeout"
            : "kinematic-miss";

  return {
    id: c.id,
    aspect: c.aspect,
    rangeM: c.rangeM,
    lateralOffsetM: c.lateralOffsetM,
    targetSpeedMps: c.targetSpeedMps,
    targetThrottle: c.targetThrottle,
    targetAfterburner: c.targetAfterburner,
    maneuver: c.maneuver,
    hit,
    ...(timeToHitS !== undefined ? { timeToHitS } : {}),
    ...(missReason ? { missReason } : {}),
    initialLock,
    lockAcquired,
    lockLost,
    ...(initialSignal !== undefined ? { initialSignal: Number(initialSignal.toFixed(3)) } : {}),
    ...(maxSignal !== undefined ? { maxSignal: Number(maxSignal.toFixed(3)) } : {}),
    initialTargetHeat: Number(initialTargetHeat.toFixed(3)),
    peakSeekerAngleDeg: Number(peakSeekerAngleDeg.toFixed(2)),
    minMissDistanceM: Number((Number.isFinite(minMissDistanceM) ? minMissDistanceM : 0).toFixed(1)),
    missileTravelM: Number(missileTravelM.toFixed(1)),
    eventMessages: events.map((event) => event.message),
  };
}

function cases(): MissileEnvelopeCase[] {
  return [
    { id: "rear-hot-2km", aspect: "rear", rangeM: 2_000, lateralOffsetM: 0, shooterSpeedMps: 260, targetSpeedMps: 210, targetThrottle: 1, targetAfterburner: true, maneuver: "steady" },
    { id: "rear-hot-6km", aspect: "rear", rangeM: 6_000, lateralOffsetM: 0, shooterSpeedMps: 260, targetSpeedMps: 220, targetThrottle: 1, targetAfterburner: true, maneuver: "steady" },
    { id: "rear-hot-12km", aspect: "rear", rangeM: 12_000, lateralOffsetM: 0, shooterSpeedMps: 280, targetSpeedMps: 230, targetThrottle: 1, targetAfterburner: true, maneuver: "steady" },
    { id: "rear-hot-18km", aspect: "rear", rangeM: 18_000, lateralOffsetM: 0, shooterSpeedMps: 290, targetSpeedMps: 240, targetThrottle: 1, targetAfterburner: true, maneuver: "steady" },
    { id: "rear-idle-6km", aspect: "rear", rangeM: 6_000, lateralOffsetM: 0, shooterSpeedMps: 260, targetSpeedMps: 210, targetThrottle: 0.18, targetAfterburner: false, maneuver: "steady" },
    { id: "rear-idle-12km", aspect: "rear", rangeM: 12_000, lateralOffsetM: 0, shooterSpeedMps: 280, targetSpeedMps: 220, targetThrottle: 0.18, targetAfterburner: false, maneuver: "steady" },
    { id: "rear-idle-16km", aspect: "rear", rangeM: 16_000, lateralOffsetM: 0, shooterSpeedMps: 280, targetSpeedMps: 220, targetThrottle: 0.18, targetAfterburner: false, maneuver: "steady" },
    { id: "beam-hot-2km", aspect: "beam-right", rangeM: 2_000, lateralOffsetM: 0, shooterSpeedMps: 260, targetSpeedMps: 220, targetThrottle: 1, targetAfterburner: true, maneuver: "steady" },
    { id: "beam-hot-4km", aspect: "beam-right", rangeM: 4_000, lateralOffsetM: 0, shooterSpeedMps: 260, targetSpeedMps: 240, targetThrottle: 1, targetAfterburner: true, maneuver: "steady" },
    { id: "beam-hot-8km", aspect: "beam-right", rangeM: 8_000, lateralOffsetM: 0, shooterSpeedMps: 270, targetSpeedMps: 260, targetThrottle: 1, targetAfterburner: true, maneuver: "steady" },
    { id: "beam-jink-4km", aspect: "beam-right", rangeM: 4_000, lateralOffsetM: 120, shooterSpeedMps: 260, targetSpeedMps: 240, targetThrottle: 1, targetAfterburner: true, maneuver: "jink" },
    { id: "beam-jink-8km", aspect: "beam-right", rangeM: 8_000, lateralOffsetM: 180, shooterSpeedMps: 270, targetSpeedMps: 260, targetThrottle: 1, targetAfterburner: true, maneuver: "jink" },
    { id: "head-on-hot-3km", aspect: "head-on", rangeM: 3_000, lateralOffsetM: 0, shooterSpeedMps: 260, targetSpeedMps: 260, targetThrottle: 1, targetAfterburner: true, maneuver: "steady" },
    { id: "head-on-hot-7km", aspect: "head-on", rangeM: 7_000, lateralOffsetM: 0, shooterSpeedMps: 270, targetSpeedMps: 270, targetThrottle: 1, targetAfterburner: true, maneuver: "steady" },
    { id: "head-on-idle-7km", aspect: "head-on", rangeM: 7_000, lateralOffsetM: 0, shooterSpeedMps: 270, targetSpeedMps: 270, targetThrottle: 0.18, targetAfterburner: false, maneuver: "steady" },
    { id: "head-on-idle-12km", aspect: "head-on", rangeM: 12_000, lateralOffsetM: 0, shooterSpeedMps: 280, targetSpeedMps: 280, targetThrottle: 0.18, targetAfterburner: false, maneuver: "steady" },
  ];
}

async function main(): Promise<void> {
  const model = tomcatModel();
  const results = cases().map((testCase) => runCase(model, testCase));
  const hits = results.filter((result) => result.hit).length;
  const report: MissileEnvelopeReport = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    missileProfile: AIM9M_SIDEWINDER_PROFILE,
    historicalAnchor: {
      source: "NAVAIR AIM-9M Sidewinder public product page",
      url: "https://www.navair.navy.mil/product/AIM-9M-Sidewinder",
      speed: "Mach 2.5",
      range: "10-18 miles",
      guidance: "solid-state infrared homing",
    },
    summary: {
      cases: results.length,
      hits,
      hitRate: Number((hits / results.length).toFixed(3)),
    },
    cases: results,
  };

  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
  console.error(`missile envelope -> ${out}`);
  for (const result of results) {
    console.error(
      `${result.id.padEnd(16)} ${result.hit ? "HIT " : "MISS"} ` +
        `range=${result.rangeM}m aspect=${result.aspect} ` +
        `signal=${result.initialSignal ?? "-"} minMiss=${result.minMissDistanceM}m`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
