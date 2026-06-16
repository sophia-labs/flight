import { compareExpectation } from "../body/telemetry";
import {
  analyzeBodyControlMotion,
  axisFlipped,
  type BodyControlMotion,
} from "../body/controlMotion";
import type { AircraftSnapshot, BodyTickTrace, MatchReplay } from "../protocol/schema";
import { basisFromQuat, clamp, dot, length, normalize, sub } from "../sim/math";
import { DEFAULT_VERIFICATION_PILOT_ID, summarizeReplayVerification } from "./replayVerification";

interface RangeStats {
  start?: number;
  final?: number;
  min?: number;
  mean?: number;
}

interface ControlStats {
  samples: number;
  meanAbsPitch: number;
  meanAbsRoll: number;
  meanAbsYaw: number;
  meanThrottle: number;
  meanDelta: number;
  pitchSignFlips: number;
  rollSignFlips: number;
  yawSignFlips: number;
  signFlips: number;
  triggerFrames: number;
}

interface BodyControlIntentStats {
  samples: number;
  actualSignFlips: number;
  requestedSignReversals: number;
  bufferedSignReversals: number;
  unannouncedSignReversals: number;
  reverseToneTicks: number;
  reverseToneRequests: number;
  reverseToneImmediateReversals: number;
}

interface WeaponGeometryStats {
  samples: number;
  framesInsideWeaponRange: number;
  firingWindowFrames: number;
  nearFiringWindowFrames: number;
  triggeredInWindowFrames: number;
  triggeredNearWindowFrames: number;
  triggerFrames: number;
  minRange?: number;
  minAngleDeg?: number;
}

export interface EnsembleCritique {
  pilotId: string;
  verificationReady: boolean;
  summary: Record<string, number | string | boolean | undefined>;
  bodyMismatchCounts: Record<string, number>;
  pilotGoals: string[];
  findings: string[];
  recommendations: string[];
}

function distance(a: AircraftSnapshot, b: AircraftSnapshot): number {
  const dx = a.position.x - b.position.x;
  const dy = a.position.y - b.position.y;
  const dz = a.position.z - b.position.z;
  return Math.hypot(dx, dy, dz);
}

function nearestOpponent(self: AircraftSnapshot, aircraft: AircraftSnapshot[]): AircraftSnapshot | undefined {
  return aircraft
    .filter((ship) => ship.team !== self.team && ship.health > 0)
    .sort((a, b) => distance(self, a) - distance(self, b))[0];
}

function rangeStats(replay: MatchReplay, pilotId: string): RangeStats {
  const ranges: number[] = [];
  for (const frame of replay.frames) {
    const self = frame.aircraft.find((ship) => ship.id === pilotId);
    if (!self) continue;
    const enemy = nearestOpponent(self, frame.aircraft);
    if (!enemy) continue;
    ranges.push(distance(self, enemy));
  }
  if (ranges.length === 0) return {};
  return {
    start: ranges[0],
    final: ranges[ranges.length - 1],
    min: Math.min(...ranges),
    mean: ranges.reduce((sum, range) => sum + range, 0) / ranges.length,
  };
}

function controlStats(replay: MatchReplay, pilotId: string): ControlStats {
  const controls = replay.frames
    .map((frame) => frame.aircraft.find((ship) => ship.id === pilotId)?.controls)
    .filter((control): control is NonNullable<typeof control> => Boolean(control));
  let delta = 0;
  let pitchSignFlips = 0;
  let rollSignFlips = 0;
  let yawSignFlips = 0;
  for (let i = 1; i < controls.length; i += 1) {
    const a = controls[i - 1];
    const b = controls[i];
    delta +=
      Math.abs(a.pitch - b.pitch) +
      Math.abs(a.roll - b.roll) +
      Math.abs(a.yaw - b.yaw) +
      Math.abs(a.throttle - b.throttle);
    if (axisFlipped(a.pitch, b.pitch)) pitchSignFlips += 1;
    if (axisFlipped(a.roll, b.roll)) rollSignFlips += 1;
    if (axisFlipped(a.yaw, b.yaw)) yawSignFlips += 1;
  }
  const samples = controls.length;
  const sum = controls.reduce(
    (acc, control) => ({
      pitch: acc.pitch + Math.abs(control.pitch),
      roll: acc.roll + Math.abs(control.roll),
      yaw: acc.yaw + Math.abs(control.yaw),
      throttle: acc.throttle + control.throttle,
      trigger: acc.trigger + (control.trigger ? 1 : 0),
    }),
    { pitch: 0, roll: 0, yaw: 0, throttle: 0, trigger: 0 },
  );
  return {
    samples,
    meanAbsPitch: samples ? sum.pitch / samples : 0,
    meanAbsRoll: samples ? sum.roll / samples : 0,
    meanAbsYaw: samples ? sum.yaw / samples : 0,
    meanThrottle: samples ? sum.throttle / samples : 0,
    meanDelta: samples > 1 ? delta / (samples - 1) : 0,
    pitchSignFlips,
    rollSignFlips,
    yawSignFlips,
    signFlips: pitchSignFlips + rollSignFlips + yawSignFlips,
    triggerFrames: sum.trigger,
  };
}

const GUN_HIT_RANGE_M = 1_180;
const GUN_HIT_ANGLE_RAD = 0.155;
const NEAR_GUN_RANGE_M = 1_420;
const NEAR_GUN_ANGLE_RAD = 0.24;
const RAD2DEG = 180 / Math.PI;

function weaponGeometryStats(replay: MatchReplay, pilotId: string): WeaponGeometryStats {
  const stats: WeaponGeometryStats = {
    samples: 0,
    framesInsideWeaponRange: 0,
    firingWindowFrames: 0,
    nearFiringWindowFrames: 0,
    triggeredInWindowFrames: 0,
    triggeredNearWindowFrames: 0,
    triggerFrames: 0,
  };

  for (const frame of replay.frames) {
    const self = frame.aircraft.find((ship) => ship.id === pilotId);
    if (!self || self.health <= 0) continue;
    const enemy = nearestOpponent(self, frame.aircraft);
    if (!enemy) continue;

    const toEnemy = sub(enemy.position, self.position);
    const range = length(toEnemy);
    const direction = normalize(toEnemy);
    const forward = basisFromQuat(self.orientation).forward;
    const angle = Math.acos(clamp(dot(direction, forward), -1, 1));
    const weaponReady = self.weaponCooldown <= 0;
    const trigger = self.controls.trigger;
    const insideRange = range < GUN_HIT_RANGE_M;
    const inWindow = weaponReady && insideRange && angle < GUN_HIT_ANGLE_RAD;
    const nearWindow = weaponReady && range < NEAR_GUN_RANGE_M && angle < NEAR_GUN_ANGLE_RAD;

    stats.samples += 1;
    if (insideRange) stats.framesInsideWeaponRange += 1;
    if (inWindow) stats.firingWindowFrames += 1;
    if (nearWindow) stats.nearFiringWindowFrames += 1;
    if (trigger) stats.triggerFrames += 1;
    if (trigger && inWindow) stats.triggeredInWindowFrames += 1;
    if (trigger && nearWindow) stats.triggeredNearWindowFrames += 1;
    stats.minRange = stats.minRange === undefined ? range : Math.min(stats.minRange, range);
    stats.minAngleDeg = stats.minAngleDeg === undefined ? angle * RAD2DEG : Math.min(stats.minAngleDeg, angle * RAD2DEG);
  }

  return stats;
}

function tickMismatches(tick: BodyTickTrace): string[] {
  return compareExpectation(tick.parsed.expect, tick.actual, tick.controlInput);
}

function bodyMismatchCounts(replay: MatchReplay, pilotId: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const tick of replay.bodyTicks ?? []) {
    if (tick.agentId !== pilotId) continue;
    for (const mismatch of tickMismatches(tick)) counts[mismatch] = (counts[mismatch] ?? 0) + 1;
  }
  return counts;
}

function bodyControlIntentStats(replay: MatchReplay, pilotId: string): BodyControlIntentStats {
  const stats: BodyControlIntentStats = {
    samples: 0,
    actualSignFlips: 0,
    requestedSignReversals: 0,
    bufferedSignReversals: 0,
    unannouncedSignReversals: 0,
    reverseToneTicks: 0,
    reverseToneRequests: 0,
    reverseToneImmediateReversals: 0,
  };
  let previousTick: BodyTickTrace | undefined;

  for (const tick of replay.bodyTicks ?? []) {
    if (tick.agentId !== pilotId) continue;
    const motion: BodyControlMotion = analyzeBodyControlMotion(tick, previousTick);
    stats.samples += 1;
    stats.actualSignFlips += motion.flips.length;
    stats.requestedSignReversals += motion.requestedReversals.length;
    stats.bufferedSignReversals += motion.bufferedReversals.length;
    if (motion.reverseTone) {
      stats.reverseToneTicks += 1;
      stats.reverseToneRequests += motion.requestedReversals.length;
      stats.reverseToneImmediateReversals += motion.immediateReversals.length;
    } else {
      stats.unannouncedSignReversals += motion.requestedReversals.length;
    }
    previousTick = tick;
  }

  return stats;
}

function pilotGoals(replay: MatchReplay, pilotId: string): string[] {
  const goals = new Set<string>();
  for (const decision of replay.decisions ?? []) {
    if (decision.agentId === pilotId && decision.action.kind === "pilot-intent") {
      goals.add(decision.action.goal);
    }
  }
  return [...goals];
}

function addUnique(list: string[], item: string): void {
  if (!list.includes(item)) list.push(item);
}

function goalHasConcretePhase(goal: string): boolean {
  return /\b(close|point|nose|fire|firing|recover|unload|preserve|weapon|range)\b/i.test(goal);
}

export function critiqueReplay(
  replay: MatchReplay,
  pilotId = DEFAULT_VERIFICATION_PILOT_ID,
): EnsembleCritique {
  const verification = summarizeReplayVerification(replay, pilotId);
  const competence = replay.outcome?.competence?.[pilotId];
  const ranges = rangeStats(replay, pilotId);
  const controls = controlStats(replay, pilotId);
  const bodyControls = bodyControlIntentStats(replay, pilotId);
  const weapon = weaponGeometryStats(replay, pilotId);
  const mismatches = bodyMismatchCounts(replay, pilotId);
  const goals = pilotGoals(replay, pilotId);
  const mismatchTotal = Object.values(mismatches).reduce((sum, count) => sum + count, 0);
  const mismatchTicks = (replay.bodyTicks ?? []).filter(
    (tick) => tick.agentId === pilotId && tickMismatches(tick).length > 0,
  ).length;
  const mismatchRate = verification.bodyTickCount ? mismatchTicks / verification.bodyTickCount : 0;
  const findings: string[] = [];
  const recommendations: string[] = [];

  if (!verification.llmEnsembleReady) {
    addUnique(findings, "Harness validity is the first problem: this replay is not a clean live ensemble run.");
    addUnique(recommendations, "Fix fallback, provider, or Body parse failures before drawing flight-quality conclusions.");
  }
  if (verification.bodyFailedTicks > 0) {
    addUnique(findings, `Body parser failed on ${verification.bodyFailedTicks} ticks.`);
    addUnique(recommendations, "Keep strict five-line Body output, but add one retry with the parse errors appended as corrective feedback.");
  }
  if (mismatchRate > 0.35) {
    addUnique(
      findings,
      `Body expectations disagreed with actual physics on ${(mismatchRate * 100).toFixed(0)}% of ticks (${mismatchTotal} mismatch labels).`,
    );
    addUnique(recommendations, "Make Body calibration stateful: repeated speed_mismatch should force conservative EXPECT until pitch/throttle actually change airspeed.");
  }
  if (controls.meanDelta > 0.35) {
    addUnique(findings, `Control deltas are high frame-to-frame (${controls.meanDelta.toFixed(2)} mean L1 delta).`);
    addUnique(recommendations, "Tune slew and TONE together: cap brace/reverse outside recovery and penalize alternating control signs in sweeps.");
  }
  if (controls.samples > 2 && controls.signFlips / Math.max(1, controls.samples - 1) > 0.2) {
    addUnique(findings, `Frame-level control sign flips are frequent (${controls.signFlips} pitch/roll/yaw reversals).`);
    addUnique(recommendations, "Score repeated frame-level sign flips separately from Body intent so smoothing does not hide oscillation.");
  }
  if (bodyControls.unannouncedSignReversals > 0) {
    addUnique(
      findings,
      `Body requested ${bodyControls.unannouncedSignReversals} pitch/roll/yaw sign reversals without TONE reverse.`,
    );
    addUnique(
      recommendations,
      "Penalize non-reverse Body reversal requests in the harness, and reserve TONE reverse for deliberate immediate sign changes.",
    );
  }
  if (bodyControls.bufferedSignReversals > 0) {
    addUnique(
      findings,
      `Slew buffering intercepted ${bodyControls.bufferedSignReversals} Body reversal requests before an immediate sign flip.`,
    );
  }
  if (
    bodyControls.reverseToneTicks > 0 &&
    bodyControls.reverseToneRequests === 0 &&
    bodyControls.reverseToneTicks / Math.max(1, bodyControls.samples) > 0.1
  ) {
    addUnique(findings, `TONE reverse was used on ${bodyControls.reverseToneTicks} ticks without requesting an axis reversal.`);
    addUnique(recommendations, "Treat unnecessary TONE reverse as chatter: downgrade it to hold/pulse unless an axis must cross neutral now.");
  }
  if (competence && competence.fracStalled > 0.02) {
    addUnique(findings, `The aircraft spent ${(competence.fracStalled * 100).toFixed(1)}% of frames stalled.`);
    addUnique(recommendations, "Make stall recovery a hard Body reflex: unload first, reduce roll demand, then rebuild bank.");
  }
  if (competence && competence.energyRetainedRatio < 0.9) {
    addUnique(findings, `Energy retention is weak (${competence.energyRetainedRatio.toFixed(2)}x start energy).`);
    addUnique(recommendations, "Prompt the Pilot to trade altitude deliberately and ask the Body for unload/throttle-before-pull when energy is low.");
  }
  if (competence && competence.shots === 0 && weapon.firingWindowFrames > 0) {
    addUnique(findings, `The pilot missed ${weapon.firingWindowFrames} valid firing-window frames without firing.`);
    addUnique(recommendations, "Add a tactical harness cue for weapon employment: when target is forward, in range, and cooldown permits, request trigger explicitly.");
  } else if (competence && competence.shots === 0 && weapon.nearFiringWindowFrames > 0) {
    addUnique(findings, `The pilot got near weapon geometry for ${weapon.nearFiringWindowFrames} frames but never took a shot.`);
    addUnique(recommendations, "Teach the Pilot to transition from pure closure into trigger-ready nose pointing as soon as near-window geometry appears.");
  } else if (competence && competence.shots === 0 && weapon.samples > 0) {
    addUnique(findings, "The run never created a valid firing window; zero shots is not yet a trigger failure.");
    addUnique(recommendations, "Score range closure, nose angle, and time in near-window geometry before judging trigger discipline.");
  }
  if (competence && competence.shots > 0 && weapon.triggeredInWindowFrames === 0) {
    addUnique(findings, "Shots were not taken inside valid gun geometry.");
    addUnique(recommendations, "Gate trigger requests on range, nose angle, and cooldown instead of treating trigger as a general aggression signal.");
  }
  if (competence && competence.damageDealt <= 0) {
    if (competence.shots > 0) {
      addUnique(findings, "No damage was dealt despite weapon employment.");
      addUnique(recommendations, "Score shot quality separately: valid range, nose angle, and cooldown at the frame the trigger is requested.");
    } else if (weapon.firingWindowFrames === 0) {
      addUnique(findings, "No damage was dealt because the run never reached firing geometry.");
      addUnique(recommendations, "Score pursuit geometry and firing windows separately from survival so prompts optimize more than staying safe.");
    } else {
      addUnique(findings, "No damage was dealt despite at least one firing window.");
      addUnique(recommendations, "Make missed trigger opportunities visible to the Pilot prompt and scenario score.");
    }
  }
  if (ranges.start !== undefined && ranges.final !== undefined && ranges.final > ranges.start * 0.98) {
    addUnique(findings, `The aircraft did not materially close range (${Math.round(ranges.start)}m -> ${Math.round(ranges.final)}m).`);
    addUnique(recommendations, "Give the Pilot an explicit closure objective and have the Body prefer lead-turn bank before pulling.");
  }
  if (goals.length === 1 && !goalHasConcretePhase(goals[0]) && /maintain|position|engage/i.test(goals[0])) {
    addUnique(findings, `Pilot intent is generic: "${goals[0]}".`);
    addUnique(recommendations, "Make the Pilot choose a concrete phase each turn: close, point nose, preserve energy, recover, or fire.");
  }
  if (findings.length === 0) {
    findings.push("No obvious harness or flight-quality issue crossed the current thresholds.");
    recommendations.push("Run a multi-repeat sweep and compare closure, energy, mismatch rate, and firing windows before changing prompts.");
  }

  return {
    pilotId,
    verificationReady: verification.llmEnsembleReady,
    summary: {
      decisions: verification.pilotDecisionCount,
      bodyTicks: verification.bodyTickCount,
      bodyParseableTicks: verification.bodyParseableTicks,
      bodyFailedTicks: verification.bodyFailedTicks,
      totalCostUsd: Number(verification.totalCostUsd.toFixed(6)),
      bodyMeanLatencyMs:
        verification.bodyMeanLatencyMs === undefined ? undefined : Math.round(verification.bodyMeanLatencyMs),
      bodyMismatchTicks: mismatchTicks,
      bodyMismatchLabels: mismatchTotal,
      shots: competence?.shots,
      hits: competence?.hits,
      damageDealt: competence?.damageDealt,
      fracStalled: competence?.fracStalled,
      energyRetainedRatio: competence?.energyRetainedRatio,
      controlSmoothness: competence?.controlSmoothness,
      rangeStartM: ranges.start === undefined ? undefined : Math.round(ranges.start),
      rangeFinalM: ranges.final === undefined ? undefined : Math.round(ranges.final),
      rangeMinM: ranges.min === undefined ? undefined : Math.round(ranges.min),
      meanControlDelta: Number(controls.meanDelta.toFixed(3)),
      controlSignFlips: controls.signFlips,
      pitchSignFlips: controls.pitchSignFlips,
      rollSignFlips: controls.rollSignFlips,
      yawSignFlips: controls.yawSignFlips,
      bodyControlSignFlips: bodyControls.actualSignFlips,
      bodyRequestedSignReversals: bodyControls.requestedSignReversals,
      bodyBufferedSignReversals: bodyControls.bufferedSignReversals,
      bodyUnannouncedSignReversals: bodyControls.unannouncedSignReversals,
      bodyReverseToneTicks: bodyControls.reverseToneTicks,
      bodyReverseToneRequests: bodyControls.reverseToneRequests,
      bodyReverseToneImmediateReversals: bodyControls.reverseToneImmediateReversals,
      triggerFrames: controls.triggerFrames,
      weaponRangeFrames: weapon.framesInsideWeaponRange,
      firingWindowFrames: weapon.firingWindowFrames,
      nearFiringWindowFrames: weapon.nearFiringWindowFrames,
      triggeredInWindowFrames: weapon.triggeredInWindowFrames,
      minWeaponRangeM: weapon.minRange === undefined ? undefined : Math.round(weapon.minRange),
      minGunAngleDeg: weapon.minAngleDeg === undefined ? undefined : Number(weapon.minAngleDeg.toFixed(1)),
    },
    bodyMismatchCounts: mismatches,
    pilotGoals: goals,
    findings,
    recommendations,
  };
}

export function formatCritique(critique: EnsembleCritique): string {
  const lines = [
    `critique pilot=${critique.pilotId} verified=${critique.verificationReady ? "yes" : "no"}`,
    "summary:",
    ...Object.entries(critique.summary)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `  ${key}: ${value}`),
  ];
  if (Object.keys(critique.bodyMismatchCounts).length > 0) {
    lines.push(
      "body mismatches:",
      ...Object.entries(critique.bodyMismatchCounts).map(([key, value]) => `  ${key}: ${value}`),
    );
  }
  if (critique.pilotGoals.length > 0) {
    lines.push("pilot goals:", ...critique.pilotGoals.map((goal) => `  - ${goal}`));
  }
  lines.push(
    "findings:",
    ...critique.findings.map((finding) => `  - ${finding}`),
    "recommendations:",
    ...critique.recommendations.map((recommendation) => `  - ${recommendation}`),
  );
  return lines.join("\n");
}
