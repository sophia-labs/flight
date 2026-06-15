import { compareExpectation } from "../body/telemetry";
import type {
  AircraftSnapshot,
  BodyTickTrace,
  MatchReplay,
  ReplayFrame,
  TurnDecision,
} from "../protocol/schema";
import { basisFromQuat, clamp, dot, length, normalize, sub } from "../sim/math";
import { DEFAULT_VERIFICATION_PILOT_ID, summarizeReplayVerification } from "../headless/replayVerification";
import { analyzeBodyControlMotion, type BodyControlMotion } from "../body/controlMotion";

const GUN_HIT_RANGE_M = 1_180;
const GUN_HIT_ANGLE_RAD = 0.155;
const NEAR_GUN_RANGE_M = 1_420;
const NEAR_GUN_ANGLE_RAD = 0.24;
const RAD2DEG = 180 / Math.PI;

export interface FlightTranscriptOptions {
  pilotId?: string;
  maxTicks?: number;
}

export interface GeometryMoment {
  rangeM?: number;
  noseAngleDeg?: number;
  weaponReady?: boolean;
  firingWindow?: boolean;
  nearWindow?: boolean;
}

export interface FlightTranscriptMoment {
  tick: BodyTickTrace;
  decision?: TurnDecision;
  geometry: GeometryMoment;
  mismatch: string[];
  calibration: string[];
  controlMotion: BodyControlMotion;
  pilotWant: string;
  senseText: string;
  geometryText: string;
  bodyOutputText: string;
  controlText: string;
  controlMotionText: string;
  expectText: string;
  actualText: string;
  streakText: string;
  read: string;
}

export function activeFlightTranscriptMomentIndex(
  moments: FlightTranscriptMoment[],
  time: number,
): number {
  let active = -1;
  for (let i = 0; i < moments.length; i += 1) {
    if (moments[i].tick.time <= time + 1e-6) active = i;
    else break;
  }
  return active;
}

function distance(a: AircraftSnapshot, b: AircraftSnapshot): number {
  return Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y, a.position.z - b.position.z);
}

function nearestOpponent(self: AircraftSnapshot, aircraft: AircraftSnapshot[]): AircraftSnapshot | undefined {
  return aircraft
    .filter((ship) => ship.team !== self.team && ship.health > 0)
    .sort((a, b) => distance(self, a) - distance(self, b))[0];
}

function closestFrame(frames: ReplayFrame[], time: number): ReplayFrame | undefined {
  return frames.reduce<ReplayFrame | undefined>((best, frame) => {
    if (!best) return frame;
    return Math.abs(frame.time - time) < Math.abs(best.time - time) ? frame : best;
  }, undefined);
}

function geometryAt(frame: ReplayFrame | undefined, pilotId: string): GeometryMoment {
  const self = frame?.aircraft.find((ship) => ship.id === pilotId);
  if (!self || self.health <= 0 || !frame) return {};
  const enemy = nearestOpponent(self, frame.aircraft);
  if (!enemy) return {};

  const toEnemy = sub(enemy.position, self.position);
  const rangeM = length(toEnemy);
  const forward = basisFromQuat(self.orientation).forward;
  const noseAngleRad = Math.acos(clamp(dot(normalize(toEnemy), forward), -1, 1));
  const weaponReady = self.weaponCooldown <= 0;
  return {
    rangeM,
    noseAngleDeg: noseAngleRad * RAD2DEG,
    weaponReady,
    firingWindow: weaponReady && rangeM < GUN_HIT_RANGE_M && noseAngleRad < GUN_HIT_ANGLE_RAD,
    nearWindow: weaponReady && rangeM < NEAR_GUN_RANGE_M && noseAngleRad < NEAR_GUN_ANGLE_RAD,
  };
}

function fmt(value: number | undefined, digits = 0): string {
  return value === undefined ? "n/a" : value.toFixed(digits);
}

function yesNo(value: boolean | undefined): string {
  return value ? "yes" : "no";
}

function muscleText(tick: BodyTickTrace): string {
  const muscle = tick.parsed.muscle;
  if (!muscle) return "none";
  return `ROLL=${muscle.roll} PITCH=${muscle.pitch} YAW=${muscle.yaw} PUSH=${muscle.push}`;
}

function toneText(tick: BodyTickTrace): string {
  const tone = tick.parsed.tone;
  return tone ? `${tone.mode} ${tone.intensity}` : "none";
}

function expectText(tick: BodyTickTrace): string {
  const expect = tick.parsed.expect;
  if (!expect) return "none";
  return `ROLL=${expect.roll} PITCH=${expect.pitch} SPEED=${expect.speed} MARGIN=${expect.margin}`;
}

function actualText(tick: BodyTickTrace): string {
  return `ROLL=${tick.actual.roll} PITCH=${tick.actual.pitch} SPEED=${tick.actual.speed} MARGIN=${tick.actual.margin}`;
}

function controlText(tick: BodyTickTrace): string {
  const control = tick.controlInput;
  return `pitch=${control.pitch.toFixed(2)} roll=${control.roll.toFixed(2)} yaw=${control.yaw.toFixed(2)} throttle=${control.throttle.toFixed(2)} trigger=${yesNo(control.trigger)}`;
}

function listText(values: string[]): string {
  return values.length ? values.join(",") : "none";
}

function controlMotionText(motion: BodyControlMotion): string {
  return [
    `delta=${motion.delta === undefined ? "n/a" : motion.delta.toFixed(2)}`,
    `flips=${listText(motion.flips)}`,
    `requested_reverse=${listText(motion.requestedReversals)}`,
    `buffered_reverse=${listText(motion.bufferedReversals)}`,
    `tone=${motion.toneMode}`,
  ].join(" ");
}

function streakText(tick: BodyTickTrace): string {
  const entries = Object.entries(tick.proprioception.last?.mismatchStreaks ?? {});
  return entries.length ? entries.map(([label, count]) => `${label}x${count}`).join("; ") : "none";
}

function promptCalibrationLines(tick: BodyTickTrace): string[] {
  return tick.promptText.match(/(?:mismatch_streaks|speed_mismatch_streak|pitch_mismatch_streak|roll_mismatch_streak):[^\n]+/g) ?? [];
}

function actionText(decision: TurnDecision | undefined): string {
  if (!decision) return "none";
  if (decision.action.kind !== "pilot-intent") return `${decision.action.kind} action`;
  return `${decision.action.goal}; urgency=${decision.action.urgency.toFixed(2)} risk=${decision.action.riskTolerance.toFixed(2)} style=${decision.action.style} trigger=${yesNo(decision.action.trigger)}`;
}

function readingLine(input: {
  mismatch: string[];
  geometry: GeometryMoment;
  previousGeometry?: GeometryMoment;
  controlMotion: BodyControlMotion;
  tick: BodyTickTrace;
}): string {
  const notes: string[] = [];
  if (input.previousGeometry?.rangeM !== undefined && input.geometry.rangeM !== undefined) {
    const delta = input.geometry.rangeM - input.previousGeometry.rangeM;
    if (delta < -3) notes.push(`closing ${Math.abs(delta).toFixed(0)}m since previous Body tick`);
    if (delta > 3) notes.push(`opening ${delta.toFixed(0)}m since previous Body tick`);
  }
  if (input.geometry.firingWindow) notes.push("valid gun window exists");
  else if (input.geometry.nearWindow) notes.push("near weapon geometry but not a clean gun window");
  if (input.mismatch.length === 0) notes.push("Body expectation matched measured physics");
  if (input.mismatch.includes("speed_mismatch")) {
    const expected = input.tick.parsed.expect?.speed;
    const actual = input.tick.actual.speed;
    if (expected === "stable" && actual !== "stable") {
      notes.push(`Body expected stable speed, but airspeed was ${actual}`);
    } else if (expected !== "stable" && actual === "stable") {
      notes.push("Body predicted speed movement before airspeed actually changed enough");
    } else {
      notes.push(`Body speed expectation disagreed with physics (${expected ?? "none"} -> ${actual})`);
    }
  }
  if (input.mismatch.includes("pitch_mismatch")) {
    notes.push("pitch response lagged or contradicted the Body expectation");
  }
  if (input.mismatch.includes("roll_mismatch")) {
    notes.push("roll response lagged or contradicted the Body expectation");
  }
  if (input.controlMotion.requestedReversals.length > 0 && !input.controlMotion.reverseTone) {
    const details: string[] = [];
    if (input.controlMotion.bufferedReversals.length > 0) {
      details.push(`buffered ${input.controlMotion.bufferedReversals.join("/")}`);
    }
    if (input.controlMotion.immediateReversals.length > 0) {
      details.push(`actual control crossed immediately on ${input.controlMotion.immediateReversals.join("/")}`);
    }
    notes.push(
      `Body requested ${input.controlMotion.requestedReversals.join("/")} sign reversal without TONE reverse${
        details.length ? ` (${details.join("; ")})` : ""
      }`,
    );
  } else if (input.controlMotion.requestedReversals.length > 0 && input.controlMotion.immediateReversals.length > 0) {
    notes.push(`Body explicitly reversed ${input.controlMotion.immediateReversals.join("/")} with TONE reverse`);
  } else if (input.controlMotion.requestedReversals.length > 0) {
    notes.push(
      `Body requested ${input.controlMotion.requestedReversals.join("/")} TONE reverse, but slew has not crossed yet`,
    );
  } else if (input.controlMotion.reverseTone) {
    notes.push("TONE reverse used without an axis sign reversal");
  }
  if (input.controlMotion.flips.length > 0) {
    notes.push(`control reversed ${input.controlMotion.flips.join("/")}`);
  }
  if (input.tick.parsed.status === "failed") notes.push("Body output was not parseable and recovery controls were used");
  return notes.length ? notes.join("; ") : "no notable event under current transcript heuristics";
}

export function formatFlightTranscript(
  replay: MatchReplay,
  options: FlightTranscriptOptions = {},
): string {
  const pilotId = options.pilotId ?? DEFAULT_VERIFICATION_PILOT_ID;
  const verification = summarizeReplayVerification(replay, pilotId);
  const decisions = (replay.decisions ?? []).filter((decision) => decision.agentId === pilotId);
  const bodyTicks = (replay.bodyTicks ?? []).filter((tick) => tick.agentId === pilotId);
  const moments = buildFlightTranscriptMoments(replay, options);
  const lines: string[] = [
    `# Flight Transcript: ${replay.id}`,
    "",
    `pilot: ${verification.pilotLabel ?? pilotId}`,
    `body: ${verification.bodyModel ?? "unknown"}`,
    `verified: ${verification.llmEnsembleReady ? "yes" : "no"}`,
    `frames: ${replay.frames.length}; body_ticks: ${bodyTicks.length}; decisions: ${decisions.length}`,
    `cost: $${verification.totalCostUsd.toFixed(4)} (pilot $${verification.pilotCostUsd.toFixed(4)}, body $${verification.bodyCostUsd.toFixed(4)})`,
    "",
    "## Pilot Decisions",
    "",
  ];

  if (decisions.length === 0) {
    lines.push("- none", "");
  } else {
    for (const decision of decisions) {
      lines.push(
        `- turn ${decision.turn} t=${decision.observation.time.toFixed(2)}s: ${actionText(decision)}`,
      );
      if (decision.rationale) lines.push(`  rationale: ${decision.rationale}`);
    }
    lines.push("");
  }

  lines.push("## Moment-By-Moment Body Read", "");
  for (const moment of moments) {
    lines.push(`### t=${moment.tick.time.toFixed(2)}s turn ${moment.tick.turn} Body tick ${moment.tick.tick}`);
    lines.push(`pilot_want: ${moment.pilotWant}`);
    lines.push(`sense: ${moment.senseText}`);
    lines.push(`geometry: ${moment.geometryText}`);
    lines.push(`body_output: ${moment.bodyOutputText}`);
    lines.push(`control: ${moment.controlText}`);
    lines.push(`control_motion: ${moment.controlMotionText}`);
    lines.push(`expect: ${moment.expectText}`);
    lines.push(`actual: ${moment.actualText}`);
    lines.push(`mismatch: ${moment.mismatch.length ? moment.mismatch.join("; ") : "none"}; prompt_streaks_seen=${moment.streakText}`);
    if (moment.calibration.length > 0) lines.push(`calibration_prompt: ${moment.calibration.join(" | ")}`);
    lines.push(`read: ${moment.read}`);
    lines.push("");
  }

  if (options.maxTicks !== undefined && bodyTicks.length > moments.length) {
    lines.push(`_Transcript truncated: showing ${moments.length}/${bodyTicks.length} Body ticks._`, "");
  }

  return lines.join("\n").trimEnd() + "\n";
}

export function buildFlightTranscriptMoments(
  replay: MatchReplay,
  options: FlightTranscriptOptions = {},
): FlightTranscriptMoment[] {
  const pilotId = options.pilotId ?? DEFAULT_VERIFICATION_PILOT_ID;
  const decisions = (replay.decisions ?? []).filter((decision) => decision.agentId === pilotId);
  const decisionByTurn = new Map(decisions.map((decision) => [decision.turn, decision]));
  const bodyTicks = (replay.bodyTicks ?? []).filter((tick) => tick.agentId === pilotId);
  const ticks = options.maxTicks === undefined ? bodyTicks : bodyTicks.slice(0, options.maxTicks);
  const moments: FlightTranscriptMoment[] = [];
  let previousGeometry: GeometryMoment | undefined;
  let previousTick: BodyTickTrace | undefined;

  for (const tick of ticks) {
    const frame = closestFrame(replay.frames, tick.time);
    const geometry = geometryAt(frame, pilotId);
    const mismatch = compareExpectation(tick.parsed.expect, tick.actual, tick.controlInput);
    const calibration = promptCalibrationLines(tick);
    const decision = decisionByTurn.get(tick.turn);
    const motion = analyzeBodyControlMotion(tick, previousTick);
    const read = readingLine({ mismatch, geometry, previousGeometry, controlMotion: motion, tick });

    moments.push({
      tick,
      ...(decision ? { decision } : {}),
      geometry,
      mismatch,
      calibration,
      controlMotion: motion,
      pilotWant: actionText(decision),
      senseText: `${tick.proprioception.attitude}; ${tick.proprioception.motion}; energy=${tick.proprioception.energy}; stall=${tick.proprioception.stallMargin}; target=${tick.proprioception.target}`,
      geometryText: `range=${fmt(geometry.rangeM)}m nose=${fmt(geometry.noseAngleDeg, 1)}deg cooldown_ready=${yesNo(geometry.weaponReady)} firing_window=${yesNo(geometry.firingWindow)} near_window=${yesNo(geometry.nearWindow)}`,
      bodyOutputText: `status=${tick.parsed.status}; muscle=${muscleText(tick)}; tone=${toneText(tick)}; feel=${tick.parsed.feel ?? "none"}; mem=${tick.parsed.memory ?? "none"}`,
      controlText: controlText(tick),
      controlMotionText: controlMotionText(motion),
      expectText: expectText(tick),
      actualText: actualText(tick),
      streakText: streakText(tick),
      read,
    });
    previousGeometry = geometry;
    previousTick = tick;
  }

  return moments;
}
