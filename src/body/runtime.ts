import type {
  BodyActualResult,
  BodyParsedOutput,
  BodyTickTrace,
  ControlInput,
  PilotIntentAction,
} from "../protocol/schema";
import { clampControlInput } from "../protocol/schema";
import type { AircraftState } from "../sim/types";
import type { BodyManifest } from "./manifest";
import type { BodyModel } from "./model";
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
}

export function createBodyRuntimeState(initialControl: ControlInput): BodyRuntimeState {
  return {
    tick: 0,
    mismatch: [],
    lastControl: initialControl,
  };
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
}): Promise<PendingBodyTick> {
  const { config, state, turn, agentId, time, dt, self, aircraft, pilotIntent } = input;
  const proprioception = encodeProprioception(self, aircraft, state);
  const promptText = buildBodyPrompt(config.manifest, pilotIntent, proprioception, state.memory);
  const rawOutput = await config.model({
    manifest: config.manifest,
    pilotIntent,
    proprioception,
    memory: state.memory,
  });
  const parsed = parseBodyOutput(rawOutput, config.manifest);
  const controlInput =
    muscleControl(parsed, pilotIntent.trigger) ?? invalidOutputControl(state, pilotIntent.trigger);
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
  };
}

export function finishBodyTick(
  pending: PendingBodyTick,
  state: BodyRuntimeState,
  after: AircraftState,
): BodyTickTrace {
  const actual: BodyActualResult = summarizeActual(pending.before, after);
  const mismatch = compareExpectation(pending.parsed.expect, actual);
  state.lastActual = actual;
  state.mismatch = mismatch;
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
  };
}

