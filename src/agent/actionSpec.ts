import { Type, type TSchema } from "@earendil-works/pi-ai";
import type { Action } from "../protocol/schema";
import { clamp } from "../sim/math";

// An ActionSpec is the LLM-facing description of an action vocabulary: the tool schema the model
// fills, the system-prompt fragment describing it, and a coercion from raw args -> validated Action.
export interface ActionSpec {
  name: string;
  description: string;
  toolSchema: TSchema;
  rules: string;
  toAction: (args: Record<string, unknown>) => Action;
}

function num(value: unknown, field: string): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) throw new Error(`field "${field}" must be a finite number`);
  return n;
}

export const rawStickSpec: ActionSpec = {
  name: "set_controls",
  description: "Set the raw flight-stick controls held for this turn.",
  toolSchema: Type.Object({
    reason: Type.String({ description: "one short phrase: your intent this turn" }),
    pitch: Type.Number({ description: "elevator, -1 (nose down) .. 1 (nose up)" }),
    roll: Type.Number({ description: "aileron, -1 (roll left) .. 1 (roll right)" }),
    yaw: Type.Number({ description: "rudder, -1 .. 1" }),
    throttle: Type.Number({ description: "0 (idle) .. 1 (full)" }),
    trigger: Type.Boolean({ description: "fire guns this turn" }),
  }),
  rules: [
    "ACTION (raw stick): output pitch, roll, yaw in [-1,1], throttle in [0,1], and trigger.",
    "Each input is HELD for the whole ~2.4s turn, so small deflections go a long way and a hard pull will stall you.",
  ].join("\n"),
  toAction: (a) => ({
    kind: "raw-stick",
    pitch: clamp(num(a.pitch, "pitch"), -1, 1),
    roll: clamp(num(a.roll, "roll"), -1, 1),
    yaw: clamp(num(a.yaw, "yaw"), -1, 1),
    throttle: clamp(num(a.throttle, "throttle"), 0, 1),
    trigger: Boolean(a.trigger),
  }),
};

export const setpointSpec: ActionSpec = {
  name: "set_flight",
  description: "Command a target attitude; an autopilot holds it and prevents stalls.",
  toolSchema: Type.Object({
    reason: Type.String({ description: "one short phrase: your intent this turn" }),
    targetBankDeg: Type.Number({ description: "desired bank angle, -90..90 (+ = roll right)" }),
    targetPitchDeg: Type.Number({ description: "desired pitch attitude, -30..30 (+ = nose up)" }),
    throttle: Type.Number({ description: "0 (idle) .. 1 (full)" }),
    trigger: Type.Boolean({ description: "fire guns this turn" }),
  }),
  rules: [
    "ACTION (setpoint): command targetBankDeg (-90..90, + = right) and targetPitchDeg (-30..30, + = nose up).",
    "An autopilot smoothly flies to that attitude and will NOT let you stall, so you can commit to aggressive banks.",
    "To turn toward the enemy: bank toward it (sign of bearingRight) and hold a little nose-up; set throttle and trigger as needed.",
  ].join("\n"),
  toAction: (a) => ({
    kind: "setpoint",
    targetBankDeg: clamp(num(a.targetBankDeg, "targetBankDeg"), -90, 90),
    targetPitchDeg: clamp(num(a.targetPitchDeg, "targetPitchDeg"), -30, 30),
    throttle: clamp(num(a.throttle, "throttle"), 0, 1),
    trigger: Boolean(a.trigger),
  }),
};

export const flightDirectorSpec: ActionSpec = {
  name: "set_flight_director",
  description: "Command bank, pull/load, and energy priority; the flight controller protects the envelope.",
  toolSchema: Type.Object({
    reason: Type.String({ description: "one short phrase: your tactical intent this turn" }),
    targetBankDeg: Type.Number({ description: "desired bank angle, -90..90 (+ = roll right)" }),
    targetLoadG: Type.Number({ description: "desired pull/load, 0.2..7.0 G" }),
    throttle: Type.Number({ description: "0 (idle) .. 1 (full)" }),
    speedPriority: Type.String({ description: "gain, hold, or bleed" }),
    trigger: Type.Boolean({ description: "fire guns this turn" }),
  }),
  rules: [
    "ACTION (flight-director): command targetBankDeg (-90..90, + = right), targetLoadG (0.2..7.0), throttle, speedPriority, and trigger.",
    "Use bank to choose turn direction and loadG to choose how hard to pull. Higher load turns harder but bleeds energy and can approach stall.",
    "Set speedPriority='gain' when slow or extending, 'hold' in most turns, and 'bleed' only to force an overshoot or tighten briefly.",
  ].join("\n"),
  toAction: (a) => {
    const rawPriority = typeof a.speedPriority === "string" ? a.speedPriority : "hold";
    const speedPriority =
      rawPriority === "gain" || rawPriority === "bleed" || rawPriority === "hold" ? rawPriority : "hold";
    return {
      kind: "flight-director",
      targetBankDeg: clamp(num(a.targetBankDeg, "targetBankDeg"), -90, 90),
      targetLoadG: clamp(num(a.targetLoadG, "targetLoadG"), 0.2, 7.0),
      throttle: clamp(num(a.throttle, "throttle"), 0, 1),
      speedPriority,
      trigger: Boolean(a.trigger),
    };
  },
};

export const actionSpecs = {
  "raw-stick": rawStickSpec,
  setpoint: setpointSpec,
  "flight-director": flightDirectorSpec,
} as const;
export type ActionMode = keyof typeof actionSpecs;
