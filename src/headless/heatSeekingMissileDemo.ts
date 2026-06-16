import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { MatchReplaySchema, type MatchReplay, type ReplayEvent, type ReplayFrame } from "../protocol/schema";
import { aircraftArchetypes } from "../sim/aircraftCatalog";
import { compileAirframe } from "../sim/airframe";
import { stepSimulation } from "../sim/flight";
import { fullFuelByTank } from "../sim/mass";
import { length, quatLookRotation, vec3 } from "../sim/math";
import { toSnapshot, type AircraftState, type Projectile } from "../sim/types";

const argv = process.argv.slice(2);
const out = resolve(flag("--out") ?? "clips/heat-seeking-missile-demo-replay.json");
const frameDt = numberFlag("--dt", 0.05);
const durationSeconds = numberFlag("--seconds", 6.2);
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

function tomcat(id: string, team: "blue" | "red", position: ReturnType<typeof vec3>, velocity: ReturnType<typeof vec3>): AircraftState {
  const archetype = aircraftArchetypes.find((candidate) => candidate.id === "variable-sweep-tomcat");
  if (!archetype) throw new Error("missing variable-sweep-tomcat archetype");
  const compiled = compileAirframe(archetype.airframe);
  const throttle = 1;
  return {
    id,
    callsign: team === "blue" ? "Super Tomcat" : "Hot Bandit",
    team,
    color: team === "blue" ? "#4da3ff" : "#ff6b61",
    position,
    velocity,
    orientation: quatLookRotation(velocity),
    controls: { pitch: 0, roll: 0, yaw: 0, throttle, trigger: false },
    health: 100,
    weaponCooldown: 0,
    model: compiled.model,
    metrics: {
      airspeed: length(velocity),
      altitude: position.y,
      aoaDeg: 0,
      gLoad: 1,
      stalled: false,
      afterburner: true,
      engineSpool: throttle,
    },
    angularVelocity: vec3(0, 0, 0),
    fuelKg: compiled.model.fuelCapacityKg,
    fuelByTankKg: fullFuelByTank(compiled.model),
    engineSpool: throttle,
    devices: compiled.devices,
    airframe: archetype.airframe,
  };
}

function targetControls(time: number) {
  return {
    pitch: Math.sin(time * 2.1) * 0.32,
    roll: Math.sin(time * 1.5 + 0.4) * 0.74,
    yaw: Math.sin(time * 1.8 + 1.2) * 0.16,
    throttle: 1,
    trigger: false,
  };
}

function buildReplay(): MatchReplay {
  const shooter = tomcat("blue-1", "blue", vec3(0, altitudeM, 0), vec3(0, 0, -260));
  const target = tomcat("red-1", "red", vec3(120, altitudeM, -4_000), vec3(240, 0, 0));
  const aircraft = [shooter, target];
  const frames: ReplayFrame[] = [];
  let projectiles: Projectile[] = [];
  let time = 0;

  frames.push(snapshot(0, time, 0, aircraft, [], projectiles));

  const steps = Math.max(1, Math.round(durationSeconds / frameDt));
  for (let i = 0; i < steps; i += 1) {
    const result = stepSimulation(
      aircraft,
      {
        "blue-1": { pitch: 0, roll: 0, yaw: 0, throttle: 1, trigger: i === 0 },
        "red-1": targetControls(time),
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
    id: "heat-seeking-missile-demo",
    schemaVersion: 3,
    turnDuration: 0.8,
    frameDt,
    frames,
    agents: [
      { id: "blue-1", kind: "scripted", label: "Super Tomcat weapons demo" },
      { id: "red-1", kind: "scripted", label: "jinking hot target" },
    ],
    outcome: {
      resolved: target.health <= 28,
      reason: target.health <= 28 ? "destroyed" : "timeout",
      winnerTeam: target.health <= 28 ? "blue" : null,
      turnsRun: Math.max(1, Math.ceil(durationSeconds / 0.8)),
      scores: {
        blue: { damageDealt: Math.max(0, 100 - target.health), damageTaken: Math.max(0, 100 - shooter.health), survived: shooter.health > 0 },
        red: { damageDealt: Math.max(0, 100 - shooter.health), damageTaken: Math.max(0, 100 - target.health), survived: target.health > 0 },
      },
      finalHealth: {
        "blue-1": shooter.health,
        "red-1": target.health,
      },
    },
    airframes: {
      "blue-1": shooter.airframe,
      "red-1": target.airframe,
    },
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
