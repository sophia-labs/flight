import { Type, type TSchema } from "@earendil-works/pi-ai";
import type { Action, MotorProgramHeldAction, MotorProgramSample } from "../protocol/schema";
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

function maybeNum(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function interpolateMotorProgramSample(
  samples: MotorProgramSample[],
  tMs: number,
): MotorProgramSample {
  if (samples.length === 1) return { ...samples[0], tMs };
  let a = samples[0];
  let b = samples[0];
  for (let i = 1; i < samples.length; i += 1) {
    if (tMs <= samples[i].tMs) {
      a = samples[i - 1];
      b = samples[i];
      break;
    }
    a = samples[i];
    b = samples[i];
  }
  const span = b.tMs - a.tMs;
  const u = span > 0 ? clamp((tMs - a.tMs) / span, 0, 1) : 0;
  const mix = (x: number, y: number) => x + (y - x) * u;
  return {
    tMs,
    pitch: clamp(mix(a.pitch, b.pitch), -1, 1),
    roll: clamp(mix(a.roll, b.roll), -1, 1),
    yaw: clamp(mix(a.yaw, b.yaw), -1, 1),
    throttle: clamp(mix(a.throttle, b.throttle), 0, 1),
    trigger: a.trigger === true || b.trigger === true,
  };
}

function resampleMotorProgramSamples(
  samples: MotorProgramSample[],
  durationMs: number,
  sampleDtMs: number,
): MotorProgramSample[] {
  const dt = Math.max(1, Math.round(sampleDtMs));
  const out: MotorProgramSample[] = [];
  for (let tMs = 0; tMs < durationMs; tMs += dt) {
    out.push(interpolateMotorProgramSample(samples, tMs));
  }
  if (out.at(-1)?.tMs !== durationMs) {
    out.push(interpolateMotorProgramSample(samples, durationMs));
  }
  return out;
}

function normalizeMotorProgramSamples(raw: unknown, durationMs: number, sampleDtMs: number): MotorProgramSample[] {
  const source = Array.isArray(raw) ? raw : [];
  const byTime = new Map<number, MotorProgramSample>();
  for (const value of source.slice(0, 96)) {
    const sample = asRecord(value);
    const tMs = Math.round(clamp(num(sample.tMs, "samples[].tMs"), 0, durationMs));
    byTime.set(tMs, {
      tMs,
      pitch: clamp(num(sample.pitch, "samples[].pitch"), -1, 1),
      roll: clamp(num(sample.roll, "samples[].roll"), -1, 1),
      yaw: clamp(num(sample.yaw, "samples[].yaw"), -1, 1),
      throttle: clamp(num(sample.throttle, "samples[].throttle"), 0, 1),
      trigger: Boolean(sample.trigger),
    });
  }

  if (byTime.size === 0) {
    byTime.set(0, { tMs: 0, pitch: 0, roll: 0, yaw: 0, throttle: 0.88, trigger: false });
  }

  const samples = [...byTime.values()].sort((a, b) => a.tMs - b.tMs);
  if (samples[0].tMs !== 0) {
    samples.unshift({ ...samples[0], tMs: 0 });
  }
  const last = samples[samples.length - 1];
  if (last.tMs < durationMs) {
    samples.push({ ...last, tMs: durationMs });
  }
  return resampleMotorProgramSamples(samples, durationMs, sampleDtMs);
}

export type DefaultWeaponsFreeGuard = "gun" | "radar-lock" | "none";

function normalizeHeldActions(
  raw: unknown,
  defaultWeaponsFree: DefaultWeaponsFreeGuard = "gun",
): MotorProgramHeldAction[] {
  const source = Array.isArray(raw) ? raw : [];
  const actions: MotorProgramHeldAction[] = [];
  for (const value of source.slice(0, 8)) {
    const action = asRecord(value);
    const rawKind = typeof action.kind === "string" ? action.kind : "";
    if (rawKind !== "weapons_free" && rawKind !== "abort_if" && rawKind !== "recover_if") continue;
    const coneDeg = maybeNum(action.coneDeg);
    const rangeM = maybeNum(action.rangeM);
    actions.push({
      kind: rawKind,
      ...(typeof action.condition === "string" && action.condition.trim()
        ? { condition: action.condition.slice(0, 96) }
        : {}),
      ...(coneDeg !== undefined && coneDeg > 0 ? { coneDeg: clamp(coneDeg, 1, 45) } : {}),
      ...(rangeM !== undefined && rangeM > 0 ? { rangeM: clamp(rangeM, 50, 120_000) } : {}),
      ...(typeof action.note === "string" && action.note.trim() ? { note: action.note.slice(0, 120) } : {}),
    });
  }

  if (!actions.some((action) => action.kind === "weapons_free") && defaultWeaponsFree !== "none") {
    actions.push({
      kind: "weapons_free",
      ...(defaultWeaponsFree === "radar-lock"
        ? {
            condition: "radar_lock",
            coneDeg: 30,
            rangeM: 80_000,
            note: "FOX-3 release only on a real radar lock",
          }
        : {
            condition: "target_in_forward_gun_cone",
            coneDeg: 12,
            rangeM: 2_350,
            note: "handoff to twitch Body for final aim and shot call",
          }),
    });
  }

  return actions;
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

export const pilotIntentSpec: ActionSpec = {
  name: "set_pilot_intent",
  description: "Describe tactical desire for an embodied Body controller; do not command actuators.",
  toolSchema: Type.Object({
    reason: Type.String({ description: "one short phrase: your tactical intent" }),
    goal: Type.String({ description: "what you want the body to attempt next" }),
    urgency: Type.Number({ description: "0..1, how urgent the desire is" }),
    riskTolerance: Type.Number({ description: "0..1, how much envelope risk to accept" }),
    style: Type.String({ description: "short token such as patient, aggressive, reckless_but_survivable" }),
    constraints: Type.Array(Type.String({ description: "short constraint token" })),
    attention: Type.Array(Type.String({ description: "short object/state token to attend to" })),
    trigger: Type.Boolean({ description: "request guns this turn if the body can line up" }),
  }),
  rules: [
    "ACTION (pilot-intent): send desire, constraints, style, attention, and trigger request.",
    "Do NOT output actuator, stick, bank, pitch, or load commands. The Body owns direct motor control.",
    "Choose one concrete phase each turn: close, point_nose, preserve_energy, recover, or fire.",
    "Use body-relative language: close range, point nose, unload, recover energy, line up, avoid ground, keep control.",
    "If range < 1050m, bearingForward is high, bearingRight/bearingUp are small, and weaponCooldown is 0, set trigger=true and make the goal a firing-window request.",
    "If not in a firing window, set trigger=false and make the goal explain the next geometry step instead of a generic engage command.",
  ].join("\n"),
  toAction: (a) => ({
    kind: "pilot-intent",
    goal: typeof a.goal === "string" ? a.goal.slice(0, 180) : "keep control and pursue the target",
    urgency: clamp(num(a.urgency, "urgency"), 0, 1),
    riskTolerance: clamp(num(a.riskTolerance, "riskTolerance"), 0, 1),
    style: typeof a.style === "string" ? a.style.slice(0, 48) : "controlled",
    constraints: Array.isArray(a.constraints)
      ? a.constraints.map(String).slice(0, 8)
      : ["do_not_crash", "avoid_stall"],
    attention: Array.isArray(a.attention) ? a.attention.map(String).slice(0, 8) : [],
    trigger: Boolean(a.trigger),
  }),
};

export const motorProgramSpec: ActionSpec = {
  name: "set_motor_program",
  description: "Author a short, smooth control tape plus held-action guards for reflex handoff.",
  toolSchema: Type.Object({
    reason: Type.String({ description: "one short phrase: tactical purpose of this motor program" }),
    durationMs: Type.Number({ description: "program duration in milliseconds; use 2500 unless recovery demands less" }),
    sampleDtMs: Type.Number({ description: "nominal interval between samples; use 50 for smooth controls" }),
    samples: Type.Array(
      Type.Object({
        tMs: Type.Number({ description: "sample timestamp in milliseconds from 0 to durationMs" }),
        pitch: Type.Number({ description: "-1 nose down .. +1 nose up" }),
        roll: Type.Number({ description: "-1 roll left .. +1 roll right" }),
        yaw: Type.Number({ description: "-1 yaw left .. +1 yaw right" }),
        throttle: Type.Number({ description: "0 idle .. 1 full power" }),
        trigger: Type.Boolean({ description: "normally false; use held weapons_free instead of direct trigger" }),
      }),
    ),
    heldActions: Type.Array(
      Type.Object({
        kind: Type.String({ description: "weapons_free, abort_if, or recover_if" }),
        condition: Type.String({ description: "short guard condition; empty string if unused" }),
        coneDeg: Type.Number({ description: "gun-cone half angle for weapons_free; use 8-14" }),
        rangeM: Type.Number({ description: "maximum range for the guard; use about 2200-2400 for guns, 80000 for radar_lock" }),
        note: Type.String({ description: "short note for the held action; empty string if unused" }),
      }),
    ),
  }),
  rules: [
    "ACTION (motor-program): output a control tape for the next ~2.5 seconds and held-action guards.",
    "Use durationMs=2500 and sampleDtMs=50 by default. Provide smooth samples from tMs=0 through tMs=2500; the runtime will resample any sparse knots into the requested 50ms tape.",
    "If observation.text is present, it is your cockpit camera-ascii@2 view. The + at the grid center is the gun boresight/pipper. Use that visual field and legend for line-up; do not rely only on bearing numbers.",
    "For pipper corrections: target/legend high or bearingUp > 0 means pitch up toward it; target/legend low or bearingUp < 0 means pitch down toward it. Avoid overflying vertically; keep the target near 12 o'clock level before handoff.",
    "Samples are desired controls, not instant physics results: keep pitch/roll/yaw continuous and avoid sign flips unless you pass through neutral.",
    "Keep trigger=false in samples. To authorize guns, include heldActions with kind='weapons_free', condition='target_in_forward_gun_cone', coneDeg 8..14, rangeM about 2200..2400.",
    "To authorize a heat-seeking FOX-2 shot, include heldActions with kind='weapons_free', condition='ir_lock' or 'missile_lock', coneDeg 30, rangeM about 6500. The weapon sear fires only when contact.missileLock is actually true.",
    "To authorize an active-radar BVR shot, include heldActions with kind='weapons_free', condition='radar_lock', coneDeg 30, rangeM about 80000. The weapon sear fires only when contact.radarLock is actually true.",
    "When a gun-cone weapons_free guard trips, a fast twitch Body gets the visual field and owns the final nose correction plus shot/no-shot call. Missile sears do not steer; they only release an armed missile on a real lock.",
    "Use abort_if/recover_if guards for ground, stall, or low-energy danger, but still include a flyable tape.",
    "ENERGY & GEOMETRY DISCIPLINE (you have NO autopilot or envelope protection — the tape goes straight to the controls):",
    "Closure: against a slow or stationary target, do NOT hold full throttle into the merge. Inside ~1200 m with closureRate strongly negative, chop throttle to 0.3-0.5 and bleed toward ~180 m/s so you can stop the nose ON the target instead of flying past it.",
    "Overshoot: if off-nose angle is growing while range is small, you are already overflying — plan the throttle chop one tape EARLIER, while the target is still ahead of the nose.",
    "Floor: self.altitude is your height above the deck (you crash at 55 m). Below ~250 m, pitch toward level and add power to climb; NEVER sustain a nose-low or high-G pull toward the ground.",
    "G: a geometry correction against a slow target needs only a rolling 4-5 G slice (roll your lift vector toward it, modest pitch). Held pitch above ~0.6 spikes G past 10, bleeds energy, tightens your spiral, and dumps altitude — reserve max pull for real threats.",
    "WEAPONS — read your loadout. If self.missileLoaded is true you carry an AIM-9 heat-seeker (FOX-2). If self.radarMissileLoaded is true you carry an active-radar BVR missile (FOX-3). A gun kill needs a close, dead-on pass you will usually OVERSHOOT on a slow/stationary target; the missile does not. When a contact shows missileLock=true it is inside your IR seeker cone and within lock range (roughly under 6 km) — you HAVE the FOX-2 shot. When a contact shows radarLock=true, your radar has a valid active-radar weapon solution at BVR range — you HAVE the FOX-3 shot. Keep a weapons_free guard armed and prefer the best missile solution to any long-range gun attempt.",
  ].join("\n"),
  toAction: (a) => {
    const durationMs = clamp(num(a.durationMs, "durationMs"), 500, 5_000);
    const sampleDtMs = clamp(num(a.sampleDtMs, "sampleDtMs"), 25, 250);
    return {
      kind: "motor-program",
      durationMs,
      sampleDtMs,
      samples: normalizeMotorProgramSamples(a.samples, durationMs, sampleDtMs),
      heldActions: normalizeHeldActions(a.heldActions),
    };
  },
};

export function motorProgramSpecWithDefaultWeaponsFree(defaultWeaponsFree: DefaultWeaponsFreeGuard): ActionSpec {
  return {
    ...motorProgramSpec,
    toAction: (a) => {
      const durationMs = clamp(num(a.durationMs, "durationMs"), 500, 5_000);
      const sampleDtMs = clamp(num(a.sampleDtMs, "sampleDtMs"), 25, 250);
      return {
        kind: "motor-program",
        durationMs,
        sampleDtMs,
        samples: normalizeMotorProgramSamples(a.samples, durationMs, sampleDtMs),
        heldActions: normalizeHeldActions(a.heldActions, defaultWeaponsFree),
      };
    },
  };
}

export const actionSpecs = {
  "raw-stick": rawStickSpec,
  setpoint: setpointSpec,
  "flight-director": flightDirectorSpec,
  "pilot-intent": pilotIntentSpec,
  "motor-program": motorProgramSpec,
} as const;
export type ActionMode = keyof typeof actionSpecs;
