import { mkdir, writeFile } from "node:fs/promises";
import type { Controller } from "../agent/controller";
import { perfectSensor } from "../agent/observation";
import { competenceEvaluator } from "../eval/outcome";
import type { Airframe, MatchReplay, MotorProgramAction, MotorProgramSample, Observation } from "../protocol/schema";
import { createMatchRoundStepper } from "../runtime/match";
import { createBvrInterceptAircraft, gentlePropController } from "../runtime/scenario";
import { aircraftArchetypes } from "../sim/aircraftCatalog";
import { length, sub } from "../sim/math";

interface TapeProfile {
  name: string;
  bankGain: number;
  bankLimitDeg: number;
  rollP: number;
  rollD: number;
  rollMax: number;
  rollRateDegPerTurn: number;
  bankDamping: number;
  pitchBase: number;
  pitchBank: number;
  pitchAlt: number;
  pitchSpeed: number;
  pitchMax: number;
  altitudeTargetM: number;
  terminalRangeM: number;
  terminalPitch: number;
  throttleBase: number;
  speedCapMps: number;
  yawGain: number;
}

interface TrialResult {
  profile: TapeProfile;
  success: boolean;
  turnsRun: number;
  replayId: string;
  metrics: TrialMetrics;
  replay?: MatchReplay;
}

interface TrialMetrics {
  initialRangeM: number;
  minRangeM: number;
  finalRangeM: number;
  minAltitudeM: number;
  finalAltitudeM: number;
  maxSpeedMps: number;
  maxG: number;
  maxAoADeg: number;
  finalHealth: number;
  firstRadarLockTurn?: number;
  firstRadarLockRangeM?: number;
  first25KmRadarLockTurn?: number;
  first25KmRadarLockTimeS?: number;
  first25KmRadarLockRangeM?: number;
  first25KmRadarLockAltitudeM?: number;
  first25KmRadarLockSpeedMps?: number;
  firstShotTimeS?: number;
  hitCount: number;
}

const RUN_ID = process.env.TOMCAT_BVR_MOTOR_RUN_ID ?? `tomcat-bvr-motor-${Date.now().toString(36)}`;
const MAX_TURNS = numberEnv("TOMCAT_BVR_MOTOR_MAX_TURNS", 180);
const KEEP_REPLAY = process.env.TOMCAT_BVR_MOTOR_KEEP_REPLAY === "1";
const PROFILE_MODE = process.env.TOMCAT_BVR_MOTOR_PROFILE_MODE ?? "coarse";
const STOP_SUCCESS_ALT_M = numberEnv("TOMCAT_BVR_MOTOR_STOP_ALT_M", Infinity);
const RAD2DEG = 180 / Math.PI;

async function main(): Promise<void> {
  const tomcat = aircraftArchetypes.find((candidate) => candidate.id === "variable-sweep-tomcat");
  if (!tomcat) throw new Error("missing variable-sweep-tomcat archetype");

  const profiles = buildProfiles();
  const results: TrialResult[] = [];
  let bestSuccess: TrialResult | undefined;

  for (const [index, profile] of profiles.entries()) {
    if ((index + 1) % 25 === 0) {
      console.error(`motor tape search ${index + 1}/${profiles.length}`);
    }
    const result = await runProfile(profile, tomcat.airframe);
    results.push(result);
    if (result.success && betterSuccess(result, bestSuccess)) {
      bestSuccess = result;
      console.error(
        `success ${profile.name}: ${Math.round(result.metrics.first25KmRadarLockRangeM ?? NaN)} m ` +
          `alt ${Math.round(result.metrics.first25KmRadarLockAltitudeM ?? NaN)} m`,
      );
    }
    if ((index + 1) % 10 === 0 || result.success) {
      await writeReport(results, bestSuccess, "checkpoint");
    }
    if ((bestSuccess?.metrics.first25KmRadarLockAltitudeM ?? 0) >= STOP_SUCCESS_ALT_M) break;
  }

  const path = await writeReport(results, bestSuccess, "final");
  const ranked = [...results].sort(compareResults);
  const out = {
    runId: RUN_ID,
    maxTurns: MAX_TURNS,
    totalProfiles: profiles.length,
    successCount: results.filter((result) => result.success).length,
    best: bestSuccess ? resultForJson(bestSuccess) : undefined,
    topResults: ranked.slice(0, 20).map(resultForJson),
  };
  console.log(JSON.stringify({ path, ...out }, null, 2));
}

async function writeReport(results: TrialResult[], bestSuccess: TrialResult | undefined, suffix: "checkpoint" | "final"): Promise<string> {
  const ranked = [...results].sort(compareResults);
  const out = {
    runId: RUN_ID,
    profileMode: PROFILE_MODE,
    maxTurns: MAX_TURNS,
    completedProfiles: results.length,
    successCount: results.filter((result) => result.success).length,
    best: bestSuccess ? resultForJson(bestSuccess) : undefined,
    topResults: ranked.slice(0, 20).map(resultForJson),
  };
  await mkdir("reports/coach", { recursive: true });
  const path = suffix === "final"
    ? `reports/coach/tomcat-bvr-motor-tape-${RUN_ID}.json`
    : `reports/coach/tomcat-bvr-motor-tape-${RUN_ID}-checkpoint.json`;
  await writeFile(path, `${JSON.stringify(out, null, 2)}\n`);
  if (bestSuccess?.replay) {
    await writeFile(
      `reports/coach/tomcat-bvr-motor-tape-${RUN_ID}-best-replay.json`,
      `${JSON.stringify(bestSuccess.replay, null, 2)}\n`,
    );
  }
  return path;
}

function buildProfiles(): TapeProfile[] {
  if (PROFILE_MODE === "high-alt") return buildHighAltitudeProfiles();

  const profiles: TapeProfile[] = [];
  for (const bankLimitDeg of [18, 24, 30, 36, 42]) {
    for (const pitchBase of [0.03, 0.06, 0.09, 0.12, 0.16]) {
      for (const pitchBank of [0.08, 0.14, 0.2]) {
        for (const throttleBase of [0.02, 0.08, 0.16]) {
          profiles.push({
            name: `vestibular-b${bankLimitDeg}-p${pitchBase}-pb${pitchBank}-t${throttleBase}`,
            bankGain: 0.54,
            bankLimitDeg,
            rollP: 0.018,
            rollD: 0.28,
            rollMax: 0.34,
            rollRateDegPerTurn: 34,
            bankDamping: 0.92,
            pitchBase,
            pitchBank,
            pitchAlt: 0.000045,
            pitchSpeed: 0.0035,
            pitchMax: 0.42,
            altitudeTargetM: 5_500,
            terminalRangeM: 35_000,
            terminalPitch: 0.08,
            throttleBase,
            speedCapMps: 430,
            yawGain: 0.04,
          });
        }
      }
    }
  }
  return profiles;
}

function buildHighAltitudeProfiles(): TapeProfile[] {
  const profiles: TapeProfile[] = [];
  for (const altitudeTargetM of [6_000, 7_500, 9_000]) {
    for (const bankLimitDeg of [12, 16, 20, 24, 28]) {
      for (const pitchBase of [0.1, 0.14, 0.18, 0.22, 0.26]) {
        for (const pitchAlt of [0.00006, 0.00009, 0.00012]) {
          for (const throttleBase of [0.02, 0.08, 0.14]) {
            profiles.push({
              name: `high-a${altitudeTargetM}-b${bankLimitDeg}-p${pitchBase}-pa${pitchAlt}-t${throttleBase}`,
              bankGain: 0.5,
              bankLimitDeg,
              rollP: 0.016,
              rollD: 0.3,
              rollMax: 0.28,
              rollRateDegPerTurn: 30,
              bankDamping: 0.92,
              pitchBase,
              pitchBank: 0.1,
              pitchAlt,
              pitchSpeed: 0.0035,
              pitchMax: 0.58,
              altitudeTargetM,
              terminalRangeM: 40_000,
              terminalPitch: 0.11,
              throttleBase,
              speedCapMps: 430,
              yawGain: 0.035,
            });
          }
        }
      }
    }
  }
  return profiles;
}

async function runProfile(profile: TapeProfile, airframe: Airframe): Promise<TrialResult> {
  const controller = motorTapeController(profile);
  const stepper = createMatchRoundStepper({
    id: `tomcat-bvr-motor-tape|${RUN_ID}|${profile.name}`,
    turnDuration: 2_500 / 1_000,
    frameDt: 0.05,
    maxTurns: MAX_TURNS,
    decisionTimeoutMs: 1_000,
    initialAircraft: createBvrInterceptAircraft(airframe),
    sensor: perfectSensor,
    evaluator: competenceEvaluator,
    agents: {
      "blue-1": {
        meta: {
          id: "blue-1",
          kind: "scripted",
          label: `motor-tape/${profile.name}`,
          config: { controlMode: "motor-program" },
        },
        controller,
        sensor: perfectSensor,
      },
      "prop-1": {
        meta: { id: "prop-1", kind: "scripted", label: "Day Tripper" },
        controller: gentlePropController,
      },
    },
    fallback: () => neutralTape(false),
  });

  let replay = stepper.replay();
  while (!stepper.complete) {
    const round = await stepper.nextRound();
    replay = round.replay;
    if (has25KmRadarSolution(replay)) break;
  }

  const metrics = summarize(replay);
  const success = metrics.first25KmRadarLockTurn !== undefined && metrics.finalHealth > 0;
  return {
    profile,
    success,
    turnsRun: stepper.turn,
    replayId: replay.id,
    metrics,
    ...(success && KEEP_REPLAY ? { replay } : {}),
  };
}

function motorTapeController(profile: TapeProfile): Controller {
  let bankEstimateDeg = 0;
  let lastRoll = 0;

  return async (observation) => {
    bankEstimateDeg = (bankEstimateDeg + lastRoll * profile.rollRateDegPerTurn) * profile.bankDamping;
    const contact = observation.contacts[0];
    const azDeg = contact ? Math.atan2(contact.bearingRight, Math.max(0.05, contact.bearingForward)) * RAD2DEG : 0;
    const targetBankDeg =
      contact && contact.range < 31_000
        ? clamp(azDeg * profile.bankGain * 0.35, -profile.bankLimitDeg * 0.45, profile.bankLimitDeg * 0.45)
        : clamp(azDeg * profile.bankGain, -profile.bankLimitDeg, profile.bankLimitDeg);
    const roll = clamp((targetBankDeg - bankEstimateDeg) * profile.rollP - lastRoll * profile.rollD, -profile.rollMax, profile.rollMax);
    lastRoll = roll;

    const speedExcess = Math.max(0, observation.self.airspeed - profile.speedCapMps);
    const lowAltitudeLift = Math.max(0, profile.altitudeTargetM - observation.self.altitude) * profile.pitchAlt;
    const terminalLift = contact && contact.range < profile.terminalRangeM ? profile.terminalPitch : 0;
    const pitch = clamp(
      profile.pitchBase +
        Math.abs(bankEstimateDeg) * profile.pitchBank / Math.max(profile.bankLimitDeg, 1) +
        lowAltitudeLift +
        speedExcess * profile.pitchSpeed +
        terminalLift,
      -0.08,
      profile.pitchMax,
    );
    const throttle =
      observation.self.airspeed > profile.speedCapMps
        ? 0.01
        : observation.self.airspeed < 310
          ? Math.min(0.78, profile.throttleBase + 0.32)
          : profile.throttleBase;
    const yaw = contact ? clamp(contact.bearingRight * profile.yawGain, -0.08, 0.08) : 0;
    const armRadar = contact?.radarLock === true && contact.range <= 25_000;

    return {
      action: tape({
        pitch,
        roll,
        yaw,
        throttle,
        armRadar,
      }),
      rationale: `motor tape: az ${azDeg.toFixed(1)} target bank ${targetBankDeg.toFixed(1)} estimate ${bankEstimateDeg.toFixed(1)}`,
    };
  };
}

function tape(input: { pitch: number; roll: number; yaw: number; throttle: number; armRadar: boolean }): MotorProgramAction {
  const durationMs = 2_500;
  const samples: MotorProgramSample[] = [
    {
      tMs: 0,
      pitch: clamp(input.pitch * 0.72, -1, 1),
      roll: clamp(input.roll * 0.72, -1, 1),
      yaw: clamp(input.yaw * 0.5, -1, 1),
      throttle: input.throttle,
      trigger: false,
    },
    {
      tMs: 1_250,
      pitch: clamp(input.pitch, -1, 1),
      roll: clamp(input.roll, -1, 1),
      yaw: clamp(input.yaw, -1, 1),
      throttle: input.throttle,
      trigger: false,
    },
    {
      tMs: 2_500,
      pitch: clamp(input.pitch * 0.92, -1, 1),
      roll: clamp(input.roll * 0.6, -1, 1),
      yaw: clamp(input.yaw * 0.5, -1, 1),
      throttle: input.throttle,
      trigger: false,
    },
  ];
  return {
    kind: "motor-program",
    durationMs,
    sampleDtMs: 50,
    samples,
    heldActions: input.armRadar
      ? [
          {
            kind: "weapons_free",
            condition: "radar_lock",
            coneDeg: 30,
            rangeM: 25_000,
            note: "release only at the 25 km radar point",
          },
        ]
      : [],
  };
}

function neutralTape(armRadar: boolean): MotorProgramAction {
  return tape({ pitch: 0, roll: 0, yaw: 0, throttle: 0.08, armRadar });
}

function has25KmRadarSolution(replay: MatchReplay): boolean {
  return Boolean(
    replay.decisions?.some((decision) =>
      decision.agentId === "blue-1" &&
      decision.observation.contacts.some((contact) => contact.radarLock === true && contact.range <= 25_000) &&
      decision.observation.self.health > 0,
    ),
  );
}

function summarize(replay: MatchReplay): TrialMetrics {
  const rows = replay.frames.map((frame) => {
    const blue = frame.aircraft.find((ship) => ship.id === "blue-1");
    const prop = frame.aircraft.find((ship) => ship.id === "prop-1");
    if (!blue || !prop) throw new Error("missing aircraft snapshots");
    return { frame, blue, prop, range: length(sub(prop.position, blue.position)) };
  });
  const decisions = replay.decisions?.filter((decision) => decision.agentId === "blue-1") ?? [];
  const firstRadarLock = decisions.find((decision) =>
    decision.observation.contacts.some((contact) => contact.radarLock === true),
  );
  const first25KmRadarLock = decisions.find((decision) =>
    decision.observation.contacts.some((contact) => contact.radarLock === true && contact.range <= 25_000),
  );
  const minRange = Math.min(...rows.map((row) => row.range));
  const final = rows.at(-1);
  if (!final) throw new Error("empty replay");
  const shotEvents = replay.frames
    .flatMap((frame) => frame.events.map((event) => ({ frame, event })))
    .filter(({ event }) => event.type === "shot");
  const hitEvents = replay.frames.flatMap((frame) => frame.events).filter((event) => event.type === "hit");
  const contact25 = first25KmRadarLock?.observation.contacts.find((contact) => contact.radarLock === true && contact.range <= 25_000);

  return {
    initialRangeM: rows[0].range,
    minRangeM: minRange,
    finalRangeM: final.range,
    minAltitudeM: Math.min(...rows.map((row) => row.blue.altitude)),
    finalAltitudeM: final.blue.altitude,
    maxSpeedMps: Math.max(...rows.map((row) => row.blue.airspeed)),
    maxG: Math.max(...rows.map((row) => row.blue.gLoad)),
    maxAoADeg: Math.max(...rows.map((row) => row.blue.aoaDeg)),
    finalHealth: final.blue.health,
    ...(firstRadarLock
      ? {
          firstRadarLockTurn: firstRadarLock.turn,
          firstRadarLockRangeM: firstRadarLock.observation.contacts.find((contact) => contact.radarLock === true)?.range,
        }
      : {}),
    ...(first25KmRadarLock && contact25
      ? {
          first25KmRadarLockTurn: first25KmRadarLock.turn,
          first25KmRadarLockTimeS: first25KmRadarLock.observation.time,
          first25KmRadarLockRangeM: contact25.range,
          first25KmRadarLockAltitudeM: first25KmRadarLock.observation.self.altitude,
          first25KmRadarLockSpeedMps: first25KmRadarLock.observation.self.airspeed,
        }
      : {}),
    ...(shotEvents[0] ? { firstShotTimeS: shotEvents[0].frame.time } : {}),
    hitCount: hitEvents.length,
  };
}

function compareResults(a: TrialResult, b: TrialResult): number {
  if (a.success !== b.success) return a.success ? -1 : 1;
  if (a.success && b.success) {
    return (
      (b.metrics.first25KmRadarLockAltitudeM ?? 0) - (a.metrics.first25KmRadarLockAltitudeM ?? 0) ||
      b.metrics.finalHealth - a.metrics.finalHealth ||
      a.metrics.maxSpeedMps - b.metrics.maxSpeedMps
    );
  }
  return a.metrics.minRangeM - b.metrics.minRangeM;
}

function betterSuccess(candidate: TrialResult, incumbent: TrialResult | undefined): boolean {
  if (!incumbent) return true;
  return compareResults(candidate, incumbent) < 0;
}

function resultForJson(result: TrialResult): Omit<TrialResult, "replay"> {
  return {
    profile: result.profile,
    success: result.success,
    turnsRun: result.turnsRun,
    replayId: result.replayId,
    metrics: result.metrics,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
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
