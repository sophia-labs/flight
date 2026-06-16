import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { MatchReplaySchema, type MatchReplay, type ReplayEvent, type ReplayFrame } from "../protocol/schema";
import { createBalloonTarget } from "../runtime/scenario";
import { aircraftArchetypes } from "../sim/aircraftCatalog";
import { compileAirframe } from "../sim/airframe";
import { stepSimulation } from "../sim/flight";
import { fullFuelByTank } from "../sim/mass";
import { length, quatLookRotation, vec3 } from "../sim/math";
import { toSnapshot, type AircraftState, type Projectile } from "../sim/types";

const argv = process.argv.slice(2);
const out = resolve(flag("--out") ?? "clips/super-tomcat-missile-balloon-replay.json");
const frameDt = numberFlag("--dt", 0.08);
const durationSeconds = numberFlag("--seconds", 4.8);
const launchStartSeconds = numberFlag("--launch-at", 0.4);
const launchEndSeconds = numberFlag("--launch-end", 0.64);
const startAltitudeM = numberFlag("--altitude", 1_500);
const startSpeedMps = numberFlag("--speed", 260);
const balloonRangeM = numberFlag("--range", 1_300);

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

function projectileSnapshot(round: Projectile) {
  return {
    id: round.id,
    kind: round.kind,
    ...(round.guidance ? { guidance: round.guidance } : {}),
    ...(round.missileModel ? { missileModel: round.missileModel } : {}),
    ...(round.lockState ? { lockState: round.lockState } : {}),
    position: round.position,
    velocity: round.velocity,
    team: round.team,
    ...(round.targetId ? { targetId: round.targetId } : {}),
    ...(round.seekerAngleRad !== undefined ? { seekerAngleDeg: (round.seekerAngleRad * 180) / Math.PI } : {}),
    ...(round.targetHeat !== undefined ? { targetHeat: round.targetHeat } : {}),
    ...(round.lockSignal !== undefined ? { lockSignal: round.lockSignal } : {}),
  };
}

function snapshot(
  index: number,
  time: number,
  turn: number,
  aircraft: AircraftState[],
  events: ReplayEvent[],
  projectiles: Projectile[],
): ReplayFrame {
  return {
    index,
    time,
    turn,
    aircraft: aircraft.map(toSnapshot),
    events,
    ...(projectiles.length > 0 ? { projectiles: projectiles.map(projectileSnapshot) } : {}),
  };
}

function superTomcat(): AircraftState {
  const archetype = aircraftArchetypes.find((candidate) => candidate.id === "variable-sweep-tomcat");
  if (!archetype) throw new Error("missing variable-sweep-tomcat archetype");
  const compiled = compileAirframe(archetype.airframe);
  const velocity = vec3(0, 0, -startSpeedMps);
  return {
    id: "blue-1",
    callsign: "Super Tomcat",
    team: "blue",
    color: "#4da3ff",
    position: vec3(0, startAltitudeM, 0),
    velocity,
    orientation: quatLookRotation(velocity),
    controls: { pitch: 0, roll: 0, yaw: 0, throttle: 1, trigger: false },
    health: 100,
    weaponCooldown: 0,
    model: compiled.model,
    metrics: { airspeed: length(velocity), altitude: startAltitudeM, aoaDeg: 0, gLoad: 1, stalled: false },
    angularVelocity: vec3(0, 0, 0),
    fuelKg: compiled.model.fuelCapacityKg,
    fuelByTankKg: fullFuelByTank(compiled.model),
    engineSpool: 1,
    devices: compiled.devices,
    airframe: archetype.airframe,
  };
}

function buildReplay(): MatchReplay {
  const tomcat = superTomcat();
  const balloon = createBalloonTarget(vec3(0, startAltitudeM, -balloonRangeM));
  const aircraft = [tomcat, balloon];
  const frames: ReplayFrame[] = [];
  let projectiles: Projectile[] = [];
  let time = 0;

  frames.push(snapshot(0, time, 0, aircraft, [], projectiles));

  const steps = Math.max(1, Math.round(durationSeconds / frameDt));
  for (let i = 0; i < steps; i += 1) {
    const trigger = time >= launchStartSeconds && time < launchEndSeconds;
    const result = stepSimulation(
      aircraft,
      {
        "blue-1": { pitch: 0, roll: 0, yaw: 0, throttle: 1, trigger },
        balloon: { pitch: 0, roll: 0, yaw: 0, throttle: 0, trigger: false },
      },
      frameDt,
      projectiles,
      time,
    );
    projectiles = result.projectiles;
    time = Number((time + frameDt).toFixed(10));
    frames.push(snapshot(i + 1, time, Math.floor(time / 0.8), result.aircraft, result.events, projectiles));
  }

  return MatchReplaySchema.parse({
    id: "super-tomcat-missile-balloon",
    schemaVersion: 3,
    turnDuration: 0.8,
    frameDt,
    frames,
    agents: [
      { id: "blue-1", kind: "scripted", label: "Super Tomcat weapons demo" },
      { id: "balloon", kind: "scripted", label: "static balloon" },
    ],
    outcome: {
      resolved: balloon.health <= 0,
      reason: balloon.health <= 0 ? "destroyed" : "timeout",
      winnerTeam: balloon.health <= 0 ? "blue" : null,
      turnsRun: Math.max(1, Math.ceil(durationSeconds / 0.8)),
      scores: {
        blue: { damageDealt: Math.max(0, 12 - balloon.health), damageTaken: 0, survived: tomcat.health > 0 },
        red: { damageDealt: 0, damageTaken: Math.max(0, 12 - balloon.health), survived: balloon.health > 0 },
      },
      finalHealth: {
        "blue-1": tomcat.health,
        balloon: balloon.health,
      },
    },
    airframes: { "blue-1": tomcat.airframe },
  });
}

async function main(): Promise<void> {
  const replay = buildReplay();
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(replay, null, 2)}\n`);
  const events = replay.frames.flatMap((frame) => frame.events.map((event) => `${frame.time.toFixed(2)}s ${event.message}`));
  console.error(`replay -> ${out}`);
  console.error(events.join("\n"));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
