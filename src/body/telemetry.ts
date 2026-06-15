import type {
  BodyActualResult,
  BodyExpectation,
  BodyMuscleCommand,
  BodyProprioception,
  PilotIntentAction,
} from "../protocol/schema";
import { basisFromQuat, clamp, cross, dot, length, normalize, scale, sub, vec3 } from "../sim/math";
import type { AircraftState } from "../sim/types";
import type { BodyManifest } from "./manifest";

const RAD2DEG = 180 / Math.PI;

export interface BodyHistory {
  memory?: string;
  lastMuscle?: BodyMuscleCommand;
  lastExpect?: BodyExpectation;
  lastActual?: BodyActualResult;
  mismatch: string[];
}

export interface BodyKinematicSnapshot {
  airspeed: number;
  altitude: number;
  aoaDeg: number;
  gLoad: number;
  stalled: boolean;
  angularVelocity: { x: number; y: number; z: number };
}

function attitude(self: AircraftState) {
  const basis = basisFromQuat(self.orientation);
  const worldUp = vec3(0, 1, 0);
  const refUp = normalize(sub(worldUp, scale(basis.forward, dot(worldUp, basis.forward))), basis.up);
  const bankDeg =
    Math.atan2(dot(cross(refUp, basis.up), basis.forward), dot(refUp, basis.up)) * RAD2DEG;
  const pitchDeg = Math.asin(clamp(basis.forward.y, -1, 1)) * RAD2DEG;
  return { basis, bankDeg, pitchDeg };
}

function signed(label: string, value: number, suffix = "") {
  const rounded = Math.round(Math.abs(value));
  if (Math.abs(value) < 1) return `${label}_level`;
  return `${value < 0 ? "left" : "right"}_${label}_${rounded}${suffix}`;
}

function pitchLabel(pitchDeg: number) {
  if (Math.abs(pitchDeg) < 1) return "nose_level";
  return `${pitchDeg > 0 ? "nose_up" : "nose_down"}_${Math.round(Math.abs(pitchDeg))}`;
}

export function energyBand(airspeed: number) {
  if (airspeed < 65) return "dead";
  if (airspeed < 115) return "low";
  if (airspeed < 245) return "good";
  if (airspeed < 330) return "high";
  return "overspeed";
}

function stallMargin(self: AircraftState) {
  const criticalDeg = self.model.stallAoARad * RAD2DEG;
  const frac = Math.abs(self.metrics.aoaDeg) / Math.max(criticalDeg, 1);
  const surfaceStall = Math.max(0, ...(self.surfaceControls ?? []).map((surface) => surface.stallSeverity ?? 0));
  if (self.metrics.stalled || frac > 1 || surfaceStall > 0.45) return "stalled";
  if (surfaceStall > 0.12) return "buffet";
  if (frac > 0.85) return "thin";
  if (frac > 0.65) return "narrowing";
  return "safe";
}

function painLevel(value: number) {
  return Math.max(0, Math.min(5, Math.round(value)));
}

function targetRelation(self: AircraftState, aircraft: AircraftState[]) {
  const enemy = aircraft
    .filter((candidate) => candidate.team !== self.team && candidate.health > 0)
    .sort((a, b) => length(sub(a.position, self.position)) - length(sub(b.position, self.position)))[0];
  if (!enemy) return "none";
  const { basis } = attitude(self);
  const toTarget = sub(enemy.position, self.position);
  const range = Math.max(length(toTarget), 1);
  const dir = scale(toTarget, 1 / range);
  const forward = dot(dir, basis.forward);
  const right = dot(dir, basis.right);
  const up = dot(dir, basis.up);
  const side = Math.abs(right) < 0.08 ? "center" : right < 0 ? "left" : "right";
  const vertical = Math.abs(up) < 0.08 ? "level" : up > 0 ? "above" : "below";
  const aspect = forward > 0.45 ? "ahead" : forward < -0.25 ? "behind" : "abeam";
  return `${side}_${Math.round(Math.abs(right) * 90)} ${vertical}_${Math.round(Math.abs(up) * 90)} ${aspect} ${Math.round(range)}m`;
}

function authority(self: AircraftState) {
  const energy = energyBand(self.metrics.airspeed);
  const margin = stallMargin(self);
  const mushy = energy === "dead" || energy === "low" || margin === "thin" || margin === "buffet" || margin === "stalled";
  const rollSurfaceStall = Math.max(
    0,
    ...(self.surfaceControls ?? [])
      .filter((surface) => surface.axis === "roll")
      .map((surface) => surface.stallSeverity ?? 0),
  );
  const yawSurfaceStall = Math.max(
    0,
    ...(self.surfaceControls ?? [])
      .filter((surface) => surface.axis === "yaw")
      .map((surface) => surface.stallSeverity ?? 0),
  );
  return {
    pitch: mushy ? "mushy" : "ok",
    roll: rollSurfaceStall > 0.25 || energy === "dead" ? "weak" : "ok",
    yaw: yawSurfaceStall > 0.25 || energy === "dead" ? "weak" : "ok",
    thrust: self.fuelKg <= 0 && self.model.fuelCapacityKg > 0 ? "dead" : "strong_lagging",
  };
}

function pain(self: AircraftState) {
  const margin = stallMargin(self);
  const surfaceStall = Math.max(0, ...(self.surfaceControls ?? []).map((surface) => surface.stallSeverity ?? 0));
  const altitude = self.position.y;
  const descending = self.velocity.y < -18;
  return {
    wingBuffet: painLevel((margin === "stalled" ? 4.8 : margin === "buffet" ? 3 : margin === "thin" ? 2 : 0) + surfaceStall * 2),
    pitchMush: painLevel(margin === "stalled" ? 5 : margin === "thin" || margin === "buffet" ? 3 : energyBand(self.metrics.airspeed) === "low" ? 2 : 0),
    overG: painLevel(Math.max(0, self.metrics.gLoad - 4.2) * 1.4),
    groundRush: painLevel(altitude < 90 ? 5 : altitude < 150 && descending ? 4 : altitude < 260 ? 2 : 0),
  };
}

function affordances(self: AircraftState) {
  const energy = energyBand(self.metrics.airspeed);
  const margin = stallMargin(self);
  const out = ["can_roll_left", "can_roll_right", "cannot_hover", "cannot_stop_in_air"];
  if (energy === "dead" || energy === "low") out.push("can_dive_for_speed", "cannot_climb_hard");
  if (margin === "thin" || margin === "buffet" || margin === "stalled") out.push("should_unload_before_pull");
  if (margin === "safe" || margin === "narrowing") out.push("can_pull_gently");
  if (self.position.y < 260) out.push("should_respect_ground");
  return out;
}

export function snapshotKinematics(self: AircraftState): BodyKinematicSnapshot {
  return {
    airspeed: self.metrics.airspeed,
    altitude: self.metrics.altitude,
    aoaDeg: self.metrics.aoaDeg,
    gLoad: self.metrics.gLoad,
    stalled: self.metrics.stalled,
    angularVelocity: self.angularVelocity,
  };
}

export function summarizeActual(before: BodyKinematicSnapshot, after: AircraftState): BodyActualResult {
  const speedDelta = after.metrics.airspeed - before.airspeed;
  const rollRate = after.angularVelocity.x;
  const pitchRate = after.angularVelocity.y;
  return {
    roll: rollRate > 0.85 ? "right++" : rollRate > 0.18 ? "right+" : rollRate < -0.85 ? "left++" : rollRate < -0.18 ? "left+" : "stable",
    pitch: pitchRate > 0.55 ? "up++" : pitchRate > 0.12 ? "up" : pitchRate < -0.55 ? "down++" : pitchRate < -0.12 ? "down" : "stable",
    speed: speedDelta > 3 ? "recover" : speedDelta > 0.6 ? "rising" : speedDelta < -3 ? "falling_fast" : speedDelta < -0.6 ? "falling" : "stable",
    margin: stallMargin(after),
  };
}

export function compareExpectation(expect: BodyExpectation | undefined, actual: BodyActualResult): string[] {
  if (!expect) return ["no_expect"];
  const mismatch: string[] = [];
  if (!actual.roll.startsWith(expect.roll.replace(/\++$/, "")) && expect.roll !== "stable") mismatch.push("roll_mismatch");
  if (!actual.pitch.startsWith(expect.pitch.replace(/\++$/, "")) && expect.pitch !== "stable") mismatch.push("pitch_mismatch");
  if (expect.speed !== actual.speed && !(expect.speed === "recover" && (actual.speed === "rising" || actual.speed === "stable"))) mismatch.push("speed_mismatch");
  if (expect.margin !== actual.margin && !(expect.margin === "better" && actual.margin !== "stalled")) mismatch.push("margin_mismatch");
  return mismatch;
}

export function encodeProprioception(
  self: AircraftState,
  aircraft: AircraftState[],
  history: BodyHistory,
): BodyProprioception {
  const { bankDeg, pitchDeg } = attitude(self);
  const bank = signed("bank", bankDeg);
  const sense: BodyProprioception = {
    attitude: `${bank}; ${pitchLabel(pitchDeg)}`,
    motion: `roll_rate_${self.angularVelocity.x.toFixed(2)} pitch_rate_${self.angularVelocity.y.toFixed(2)} vertical_${self.velocity.y.toFixed(1)}`,
    energy: energyBand(self.metrics.airspeed),
    stallMargin: stallMargin(self),
    authority: authority(self),
    terrain: self.position.y < 120 ? "ground_rush" : self.position.y < 260 ? "ground_near" : "ground_safe",
    target: targetRelation(self, aircraft),
    pain: pain(self),
    affordances: affordances(self),
  };
  if (history.lastMuscle || history.lastExpect || history.lastActual || history.mismatch.length > 0) {
    sense.last = {
      ...(history.lastMuscle ? { muscle: history.lastMuscle } : {}),
      ...(history.lastExpect ? { expect: history.lastExpect } : {}),
      ...(history.lastActual ? { actual: history.lastActual } : {}),
      mismatch: history.mismatch,
    };
  }
  return sense;
}

function muscleLine(muscle: BodyMuscleCommand | undefined) {
  if (!muscle) return "none";
  return `ROLL=${muscle.roll} PITCH=${muscle.pitch} YAW=${muscle.yaw} PUSH=${muscle.push}`;
}

export function buildBodyPrompt(
  manifest: BodyManifest,
  pilotIntent: PilotIntentAction,
  proprioception: BodyProprioception,
  memory?: string,
): string {
  return [
    `BODY ${manifest.bodyId} DT=${manifest.bodyTickDt.toFixed(2)}`,
    "",
    "PILOT_WANT",
    `${pilotIntent.goal}; urgency=${pilotIntent.urgency.toFixed(2)}; risk=${pilotIntent.riskTolerance.toFixed(2)}; style=${pilotIntent.style}; trigger=${pilotIntent.trigger}`,
    `constraints: ${pilotIntent.constraints.join("; ") || "none"}`,
    `attention: ${pilotIntent.attention.join("; ") || "none"}`,
    "",
    "BODY_LAWS",
    ...manifest.bodyLaws,
    "",
    "SENSE",
    `attitude: ${proprioception.attitude}`,
    `motion: ${proprioception.motion}`,
    `energy: ${proprioception.energy}`,
    `stall_margin: ${proprioception.stallMargin}`,
    `authority: pitch_${proprioception.authority.pitch}; roll_${proprioception.authority.roll}; yaw_${proprioception.authority.yaw}; thrust_${proprioception.authority.thrust}`,
    `terrain: ${proprioception.terrain}`,
    `target: ${proprioception.target}`,
    `pain: wing_buffet=${proprioception.pain.wingBuffet} pitch_mush=${proprioception.pain.pitchMush} over_g=${proprioception.pain.overG} ground_rush=${proprioception.pain.groundRush}`,
    `afford: ${proprioception.affordances.join("; ")}`,
    "",
    "LAST",
    `muscle: ${muscleLine(proprioception.last?.muscle)}`,
    `expect: ${proprioception.last?.expect ? `ROLL=${proprioception.last.expect.roll} PITCH=${proprioception.last.expect.pitch} SPEED=${proprioception.last.expect.speed} MARGIN=${proprioception.last.expect.margin}` : "none"}`,
    `actual: ${proprioception.last?.actual ? `ROLL=${proprioception.last.actual.roll} PITCH=${proprioception.last.actual.pitch} SPEED=${proprioception.last.actual.speed} MARGIN=${proprioception.last.actual.margin}` : "none"}`,
    `mismatch: ${proprioception.last?.mismatch.join("; ") || "none"}`,
    "",
    "MEM",
    memory ?? "",
  ].join("\n");
}

