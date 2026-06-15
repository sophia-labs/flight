import type {
  BodyActualResult,
  BodyParsedOutput,
  BodyTickTrace,
  ControlInput,
  PilotIntentAction,
  Usage,
} from "../protocol/schema";
import { clampControlInput } from "../protocol/schema";
import { cameraSensor } from "../agent/perception";
import { cameraAsciiEncoderV2 } from "../agent/encoders/cameraAscii";
import { selectCameraDevice } from "../sim/mountedSensor";
import type { SensorDevice } from "../sim/parts";
import type { AircraftState } from "../sim/types";
import type { BodyManifest } from "./manifest";
import type { BodyModel, BodyModelResult } from "./model";
import { parseBodyOutput } from "./parser";
import {
  buildBodyPrompt,
  compareExpectation,
  encodeProprioception,
  snapshotKinematics,
  summarizeActual,
  type BodyHistory,
  type BodyKinematicSnapshot,
} from "./telemetry";

export interface BodyRuntimeConfig {
  manifest: BodyManifest;
  model: BodyModel;
  timeoutMs?: number;
  recordLatency?: boolean;
  controlSlew?: Partial<BodyControlSlewLimits>;
}

export interface BodyRuntimeState extends BodyHistory {
  tick: number;
  lastControl: ControlInput;
}

export interface PendingBodyTick {
  turn: number;
  tick: number;
  agentId: string;
  time: number;
  dt: number;
  reason: BodyTickTrace["reason"];
  manifestId: string;
  pilotIntent: PilotIntentAction;
  proprioception: BodyTickTrace["proprioception"];
  promptText: string;
  rawOutput: string;
  parsed: BodyParsedOutput;
  controlInput: ControlInput;
  before: BodyKinematicSnapshot;
  latencyMs?: number;
  usage?: Usage;
  modelError?: string;
}

const DEFAULT_BODY_MODEL_TIMEOUT_MS = 15_000;
const DEFAULT_BODY_CONTROL_SLEW = {
  pitch: 0.26,
  roll: 0.3,
  yaw: 0.22,
  throttle: 0.18,
} satisfies BodyControlSlewLimits;

interface BodyControlSlewLimits {
  pitch: number;
  roll: number;
  yaw: number;
  throttle: number;
}

export function createBodyRuntimeState(initialControl: ControlInput): BodyRuntimeState {
  return {
    tick: 0,
    mismatch: [],
    mismatchStreaks: {},
    lastControl: initialControl,
  };
}

function nextMismatchStreaks(
  current: Record<string, number>,
  mismatch: string[],
): Record<string, number> {
  const next: Record<string, number> = {};
  for (const label of mismatch) {
    next[label] = (current[label] ?? 0) + 1;
  }
  return next;
}

function muscleControl(parsed: BodyParsedOutput, trigger: boolean): ControlInput | undefined {
  if (!parsed.muscle) return undefined;
  return clampControlInput({
    roll: parsed.muscle.roll / 5,
    pitch: parsed.muscle.pitch / 5,
    yaw: parsed.muscle.yaw / 5,
    throttle: parsed.muscle.push / 5,
    trigger,
  });
}

function toneSlewScale(parsed: BodyParsedOutput): number {
  const tone = parsed.tone;
  if (!tone) return 0.85;
  const modeScale = {
    relax: 0.55,
    hold: 0.82,
    pulse: 1.0,
    brace: 1.2,
    reverse: 1.08,
  } satisfies Record<NonNullable<BodyParsedOutput["tone"]>["mode"], number>;
  return modeScale[tone.mode] * (1 + tone.intensity * 0.12);
}

function stepToward(current: number, desired: number, maxDelta: number): number {
  const delta = desired - current;
  if (Math.abs(delta) <= maxDelta) return desired;
  return current + Math.sign(delta) * maxDelta;
}

function crossesControlSign(current: number, desired: number): boolean {
  const deadband = 0.08;
  return Math.abs(current) >= deadband && Math.abs(desired) >= deadband && Math.sign(current) !== Math.sign(desired);
}

function stepControlAxis(
  current: number,
  desired: number,
  maxDelta: number,
  canReverse: boolean,
): number {
  if (!canReverse && crossesControlSign(current, desired)) {
    const neutralStep = current - Math.sign(current) * maxDelta;
    return Math.sign(neutralStep) === Math.sign(current) ? neutralStep : 0;
  }
  return stepToward(current, desired, maxDelta);
}

export function slewBodyControl(
  current: ControlInput,
  desired: ControlInput,
  parsed: BodyParsedOutput,
  limits: Partial<BodyControlSlewLimits> = {},
): ControlInput {
  const scale = toneSlewScale(parsed);
  const merged = { ...DEFAULT_BODY_CONTROL_SLEW, ...limits };
  const canReverse = parsed.tone?.mode === "reverse";
  return clampControlInput({
    pitch: stepControlAxis(current.pitch, desired.pitch, merged.pitch * scale, canReverse),
    roll: stepControlAxis(current.roll, desired.roll, merged.roll * scale, canReverse),
    yaw: stepControlAxis(current.yaw, desired.yaw, merged.yaw * scale, canReverse),
    throttle: stepToward(current.throttle, desired.throttle, merged.throttle * scale),
    trigger: desired.trigger,
  });
}

export function invalidOutputControl(state: BodyRuntimeState, trigger: boolean): ControlInput {
  return clampControlInput({
    pitch: state.lastControl.pitch * 0.42,
    roll: state.lastControl.roll * 0.42,
    yaw: state.lastControl.yaw * 0.42,
    throttle: Math.max(0.28, state.lastControl.throttle * 0.72),
    trigger,
  });
}

function reasonForPain(proprioception: PendingBodyTick["proprioception"]): BodyTickTrace["reason"] {
  const pain = proprioception.pain;
  if (pain.groundRush >= 4 || pain.wingBuffet >= 4 || pain.pitchMush >= 4 || pain.overG >= 4) {
    return "pain_interrupt";
  }
  return "regular_tick";
}

function normalizeBodyResult(result: BodyModelResult): {
  rawOutput: string;
  usage?: Usage;
} {
  if (typeof result === "string") return { rawOutput: result };
  return {
    rawOutput: result.output,
    ...(result.usage ? { usage: result.usage } : {}),
  };
}

async function callBodyModel(input: {
  config: BodyRuntimeConfig;
  manifest: BodyManifest;
  pilotIntent: PilotIntentAction;
  proprioception: PendingBodyTick["proprioception"];
  memory?: string;
}): Promise<{
  rawOutput: string;
  usage?: Usage;
  latencyMs?: number;
  modelError?: string;
}> {
  const { config, manifest, pilotIntent, proprioception, memory } = input;
  const timeoutMs = Math.max(1, config.timeoutMs ?? DEFAULT_BODY_MODEL_TIMEOUT_MS);
  const aborter = new AbortController();
  const started = config.recordLatency ? Date.now() : 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      aborter.abort();
      reject(new Error(`body model timeout after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    const pending = config.model({
      manifest,
      pilotIntent,
      proprioception,
      memory,
      signal: aborter.signal,
      timeoutMs,
    });
    pending.catch(() => {});
    const result = await Promise.race([pending, timeout]);
    return {
      ...normalizeBodyResult(result),
      ...(config.recordLatency ? { latencyMs: Date.now() - started } : {}),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      rawOutput: "",
      modelError: message.slice(0, 240),
      ...(config.recordLatency ? { latencyMs: Date.now() - started } : {}),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function runBodyTick(input: {
  config: BodyRuntimeConfig;
  state: BodyRuntimeState;
  turn: number;
  agentId: string;
  time: number;
  dt: number;
  self: AircraftState;
  aircraft: AircraftState[];
  pilotIntent: PilotIntentAction;
  /**
   * The camera device whose camera-ascii@2 glyph-field the Body sees. FIELD-FEED computes this
   * percept fresh EACH tick from the live world + self, so the field tracks the plane as it moves.
   * Omitted ⇒ the self airframe's cockpit-cam (or the default cockpit camera) is selected.
   */
  device?: SensorDevice;
}): Promise<PendingBodyTick> {
  const { config, state, turn, agentId, time, dt, self, aircraft, pilotIntent } = input;
  // Sense the live world through the cockpit camera and encode it as the @2 glyph-field. Pure and
  // deterministic (no clock/RNG/GPU): two ticks on the same world + self produce byte-identical text.
  const device = input.device ?? selectCameraDevice(self.devices);
  const field = cameraAsciiEncoderV2.encode(cameraSensor.sense(device, aircraft, self)).text ?? "";
  const proprioception = encodeProprioception(self, state, field);
  const promptText = buildBodyPrompt(config.manifest, pilotIntent, proprioception, state.memory);
  const bodyCall = await callBodyModel({
    config,
    manifest: config.manifest,
    pilotIntent,
    proprioception,
    memory: state.memory,
  });
  const rawOutput = bodyCall.rawOutput;
  const parsed: BodyParsedOutput = bodyCall.modelError
    ? { status: "failed", errors: [`model_error: ${bodyCall.modelError}`], clipped: false }
    : parseBodyOutput(rawOutput, config.manifest);
  const desiredControl = muscleControl(parsed, pilotIntent.trigger);
  const controlInput = desiredControl
    ? slewBodyControl(state.lastControl, desiredControl, parsed, config.controlSlew)
    : invalidOutputControl(state, pilotIntent.trigger);
  const reason = parsed.status === "failed" ? "invalid_recovery" : reasonForPain(proprioception);
  const before = snapshotKinematics(self);

  if (parsed.muscle) state.lastMuscle = parsed.muscle;
  if (parsed.expect) state.lastExpect = parsed.expect;
  if (parsed.memory !== undefined) state.memory = parsed.memory;
  state.lastControl = controlInput;
  state.tick += 1;

  return {
    turn,
    tick: state.tick,
    agentId,
    time,
    dt,
    reason,
    manifestId: config.manifest.bodyId,
    pilotIntent,
    proprioception,
    promptText,
    rawOutput,
    parsed,
    controlInput,
    before,
    ...(bodyCall.latencyMs !== undefined ? { latencyMs: bodyCall.latencyMs } : {}),
    ...(bodyCall.usage ? { usage: bodyCall.usage } : {}),
    ...(bodyCall.modelError ? { modelError: bodyCall.modelError } : {}),
  };
}

export function finishBodyTick(
  pending: PendingBodyTick,
  state: BodyRuntimeState,
  after: AircraftState,
): BodyTickTrace {
  const actual: BodyActualResult = summarizeActual(pending.before, after);
  const mismatch = compareExpectation(pending.parsed.expect, actual, pending.controlInput);
  state.lastActual = actual;
  state.mismatch = mismatch;
  state.mismatchStreaks = nextMismatchStreaks(state.mismatchStreaks, mismatch);
  return {
    turn: pending.turn,
    tick: pending.tick,
    agentId: pending.agentId,
    time: pending.time,
    dt: pending.dt,
    reason: pending.reason,
    manifestId: pending.manifestId,
    pilotIntent: pending.pilotIntent,
    proprioception: pending.proprioception,
    promptText: pending.promptText,
    rawOutput: pending.rawOutput,
    parsed: pending.parsed,
    controlInput: pending.controlInput,
    actual,
    mismatch,
    ...(pending.latencyMs !== undefined ? { latencyMs: pending.latencyMs } : {}),
    ...(pending.usage ? { usage: pending.usage } : {}),
    ...(pending.modelError ? { modelError: pending.modelError } : {}),
  };
}
