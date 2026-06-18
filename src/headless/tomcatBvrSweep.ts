import { mkdir, writeFile } from "node:fs/promises";
import type { Controller } from "../agent/controller";
import { perfectSensor, radarSensorModel, type SensorModel } from "../agent/observation";
import { pursuitAction } from "../agent/controllers/scripted";
import { competenceEvaluator } from "../eval/outcome";
import type { Action, Airframe, FlightDirectorAction, MatchReplay } from "../protocol/schema";
import type { MatchConfig } from "../runtime/config";
import { runMatch } from "../runtime/match";
import { createBvrInterceptAircraft, gentlePropController } from "../runtime/scenario";
import { aircraftArchetypes } from "../sim/aircraftCatalog";
import { length, normalize, quatLookRotation, scale, sub, vec3 } from "../sim/math";
import { selectRadarDevice } from "../sim/mountedSensor";
import type { AircraftState } from "../sim/types";

interface SweepCase {
  name: string;
  sensorMode: "radar" | "perfect";
  controllerMode: "hold-direct" | "pursuit-fd";
  headingOffsetDeg: number;
  speedMps: number;
  altitudeM: number;
  turns: number;
}

interface SweepResult {
  case: SweepCase;
  replayId: string;
  metrics: BvrMetrics;
}

interface BvrMetrics {
  initialRangeM: number;
  finalRangeM: number;
  minRangeM: number;
  finalAltitudeM: number;
  minAltitudeM: number;
  maxG: number;
  maxAoADeg: number;
  firstContactTurn?: number;
  firstRadarLockTurn?: number;
  firstShotTimeS?: number;
  firstHitTimeS?: number;
  shotCount: number;
  hitCount: number;
  targetKilled: boolean;
  fallbackTurns: number;
}

const RUN_ID = process.env.TOMCAT_BVR_SWEEP_RUN_ID ?? `tomcat-bvr-${Date.now().toString(36)}`;
const TURNS = numberEnv("TOMCAT_BVR_SWEEP_TURNS", 44);

async function main(): Promise<void> {
  const tomcat = aircraftArchetypes.find((candidate) => candidate.id === "variable-sweep-tomcat");
  if (!tomcat) throw new Error("missing variable-sweep-tomcat archetype");
  const cases = buildCases();
  const results: SweepResult[] = [];
  for (const testCase of cases) {
    console.error(`tomcat-bvr ${testCase.name}`);
    const replay = await runCase(testCase, tomcat.airframe);
    results.push({
      case: testCase,
      replayId: replay.id,
      metrics: summarize(replay),
    });
  }
  const out = {
    runId: RUN_ID,
    turns: TURNS,
    results,
    aggregate: {
      cases: results.length,
      hits: results.filter((result) => result.metrics.hitCount > 0).length,
      shots: results.filter((result) => result.metrics.shotCount > 0).length,
      radarLocks: results.filter((result) => result.metrics.firstRadarLockTurn !== undefined).length,
      minRangeM: Math.min(...results.map((result) => result.metrics.minRangeM)),
    },
  };
  await mkdir("reports/coach", { recursive: true });
  const path = `reports/coach/tomcat-bvr-sweep-${RUN_ID}.json`;
  await writeFile(path, `${JSON.stringify(out, null, 2)}\n`);
  console.log(JSON.stringify({ path, ...out }, null, 2));
}

function buildCases(): SweepCase[] {
  const cases: SweepCase[] = [];
  for (const speedMps of [320, 420, 520]) {
    for (const headingOffsetDeg of [-30, -15, 0, 15, 30]) {
      cases.push({
        name: `radar-direct-speed${speedMps}-offset${headingOffsetDeg}`,
        sensorMode: "radar",
        controllerMode: "hold-direct",
        headingOffsetDeg,
        speedMps,
        altitudeM: 6_000,
        turns: TURNS,
      });
    }
  }
  for (const speedMps of [320, 420, 520]) {
    for (const headingOffsetDeg of [-60, -30, 0, 30, 60]) {
      cases.push({
        name: `perfect-pursuit-speed${speedMps}-offset${headingOffsetDeg}`,
        sensorMode: "perfect",
        controllerMode: "pursuit-fd",
        headingOffsetDeg,
        speedMps,
        altitudeM: 6_000,
        turns: TURNS,
      });
    }
  }
  return cases;
}

async function runCase(testCase: SweepCase, airframe: Airframe): Promise<MatchReplay> {
  const initialAircraft = createBvrInterceptAircraft(airframe);
  configureBlueInitial(initialAircraft, testCase);
  const blue = initialAircraft.find((ship) => ship.id === "blue-1");
  if (!blue) throw new Error("missing blue-1");
  const sensor = testCase.sensorMode === "radar" ? radarSensorFor(blue) : perfectSensor;
  const config: MatchConfig = {
    id: `tomcat-bvr-sweep|${testCase.name}|turns:${testCase.turns}`,
    turnDuration: 2.5,
    frameDt: 0.05,
    maxTurns: testCase.turns,
    decisionTimeoutMs: 1_000,
    initialAircraft,
    sensor,
    evaluator: competenceEvaluator,
    fallback: holdDirectAction,
    agents: {
      "blue-1": {
        meta: {
          id: "blue-1",
          kind: "scripted",
          label: testCase.controllerMode,
          config: { controlMode: "flight-director" },
        },
        controller: testCase.controllerMode === "pursuit-fd" ? pursuitBvrController() : holdDirectController(),
        sensor,
      },
      "prop-1": {
        meta: { id: "prop-1", kind: "scripted", label: "Day Tripper" },
        controller: gentlePropController,
      },
    },
  };
  return runMatch(config);
}

function configureBlueInitial(aircraft: AircraftState[], testCase: SweepCase): void {
  const blue = aircraft.find((ship) => ship.id === "blue-1");
  const target = aircraft.find((ship) => ship.id === "prop-1");
  if (!blue || !target) throw new Error("missing BVR aircraft");
  blue.position = vec3(blue.position.x, testCase.altitudeM, blue.position.z);
  const toTarget = sub(target.position, blue.position);
  const horizontal = normalize(vec3(toTarget.x, 0, toTarget.z), vec3(1, 0, 0));
  const yaw = (testCase.headingOffsetDeg * Math.PI) / 180;
  const dir = normalize(
    vec3(
      horizontal.x * Math.cos(yaw) - horizontal.z * Math.sin(yaw),
      0,
      horizontal.x * Math.sin(yaw) + horizontal.z * Math.cos(yaw),
    ),
    horizontal,
  );
  blue.velocity = scale(dir, testCase.speedMps);
  blue.orientation = quatLookRotation(blue.velocity);
  blue.metrics = { ...blue.metrics, airspeed: length(blue.velocity), altitude: blue.position.y, aoaDeg: 0, gLoad: 1, stalled: false };
  blue.controls = { ...blue.controls, throttle: 0.92, trigger: false };
}

function radarSensorFor(blue: AircraftState): SensorModel {
  const radar = selectRadarDevice(blue.devices);
  return radar ? radarSensorModel(radar) : { detect: () => [] };
}

function holdDirectController(): Controller {
  return async (observation) => ({
    action: holdDirectAction(observation) as FlightDirectorAction,
    rationale: "hold direct intercept, fire on radar lock",
  });
}

const holdDirectAction = (observation: Parameters<NonNullable<MatchConfig["fallback"]>>[0]): Action => ({
  kind: "flight-director",
  targetBankDeg: 0,
  targetLoadG: 1,
  throttle: 0.92,
  speedPriority: "hold",
  trigger: observation.contacts.some((contact) => contact.radarLock === true),
});

function pursuitBvrController(): Controller {
  return async (observation) => {
    const base = pursuitAction(observation, 0.82);
    const action: FlightDirectorAction = {
      ...base,
      throttle: Math.max(base.throttle, 0.9),
      trigger: observation.contacts.some((contact) => contact.radarLock === true),
    };
    return {
      action,
      rationale: "perfect-info pursuit, fire on radar lock",
    };
  };
}

function summarize(replay: MatchReplay): BvrMetrics {
  const blueSnaps = replay.frames
    .map((frame) => frame.aircraft.find((ship) => ship.id === "blue-1"))
    .filter((ship): ship is NonNullable<typeof ship> => Boolean(ship));
  const propSnaps = replay.frames
    .map((frame) => frame.aircraft.find((ship) => ship.id === "prop-1"))
    .filter((ship): ship is NonNullable<typeof ship> => Boolean(ship));
  if (blueSnaps.length === 0 || propSnaps.length === 0) throw new Error("missing aircraft snapshots");
  const ranges = replay.frames
    .map((frame) => {
      const blue = frame.aircraft.find((ship) => ship.id === "blue-1");
      const prop = frame.aircraft.find((ship) => ship.id === "prop-1");
      return blue && prop ? length(sub(prop.position, blue.position)) : undefined;
    })
    .filter((value): value is number => value !== undefined);
  const firstContactTurn = replay.decisions?.find((decision) => decision.agentId === "blue-1" && decision.observation.contacts.length > 0)?.turn;
  const firstRadarLockTurn = replay.decisions?.find((decision) =>
    decision.agentId === "blue-1" && decision.observation.contacts.some((contact) => contact.radarLock === true),
  )?.turn;
  const shotEvents = replay.frames.flatMap((frame) => frame.events.map((event) => ({ frame, event }))).filter(({ event }) => event.type === "shot");
  const hitEvents = replay.frames.flatMap((frame) => frame.events.map((event) => ({ frame, event }))).filter(({ event }) => event.type === "hit");
  return {
    initialRangeM: ranges[0] ?? NaN,
    finalRangeM: ranges.at(-1) ?? NaN,
    minRangeM: Math.min(...ranges),
    finalAltitudeM: blueSnaps.at(-1)!.altitude,
    minAltitudeM: Math.min(...blueSnaps.map((snap) => snap.altitude)),
    maxG: Math.max(...blueSnaps.map((snap) => snap.gLoad)),
    maxAoADeg: Math.max(...blueSnaps.map((snap) => snap.aoaDeg)),
    ...(firstContactTurn !== undefined ? { firstContactTurn } : {}),
    ...(firstRadarLockTurn !== undefined ? { firstRadarLockTurn } : {}),
    ...(shotEvents[0] ? { firstShotTimeS: shotEvents[0].frame.time } : {}),
    ...(hitEvents[0] ? { firstHitTimeS: hitEvents[0].frame.time } : {}),
    shotCount: shotEvents.length,
    hitCount: hitEvents.length,
    targetKilled: propSnaps.at(-1)!.health <= 0,
    fallbackTurns: replay.decisions?.filter((decision) => decision.agentId === "blue-1" && decision.source === "fallback").length ?? 0,
  };
}

function numberEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
