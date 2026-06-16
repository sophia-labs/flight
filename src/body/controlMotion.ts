import type { BodyTickTrace, ControlInput } from "../protocol/schema";

export const CONTROL_AXES = ["pitch", "roll", "yaw"] as const;
export type ControlAxis = (typeof CONTROL_AXES)[number];

export interface BodyControlMotion {
  delta?: number;
  flips: ControlAxis[];
  requestedReversals: ControlAxis[];
  bufferedReversals: ControlAxis[];
  immediateReversals: ControlAxis[];
  reverseTone: boolean;
  toneMode: string;
}

export function axisSign(value: number): number {
  return Math.abs(value) < 0.08 ? 0 : Math.sign(value);
}

export function axisFlipped(a: number, b: number): boolean {
  const before = axisSign(a);
  const after = axisSign(b);
  return before !== 0 && after !== 0 && before !== after;
}

export function controlDelta(before: ControlInput, after: ControlInput): number {
  return (
    Math.abs(before.pitch - after.pitch) +
    Math.abs(before.roll - after.roll) +
    Math.abs(before.yaw - after.yaw) +
    Math.abs(before.throttle - after.throttle)
  );
}

function muscleSign(tick: BodyTickTrace, axis: ControlAxis): number {
  const value = tick.parsed.muscle?.[axis];
  return value === undefined ? 0 : axisSign(value);
}

export function analyzeBodyControlMotion(
  tick: BodyTickTrace,
  previousTick: BodyTickTrace | undefined,
): BodyControlMotion {
  const toneMode = tick.parsed.tone?.mode ?? "none";
  const motion: BodyControlMotion = {
    flips: [],
    requestedReversals: [],
    bufferedReversals: [],
    immediateReversals: [],
    reverseTone: toneMode === "reverse",
    toneMode,
  };
  if (!previousTick) return motion;

  motion.delta = controlDelta(previousTick.controlInput, tick.controlInput);
  for (const axis of CONTROL_AXES) {
    const actualFlip = axisFlipped(previousTick.controlInput[axis], tick.controlInput[axis]);
    const previousSign = axisSign(previousTick.controlInput[axis]);
    const desiredSign = muscleSign(tick, axis);
    const requestedReversal = previousSign !== 0 && desiredSign !== 0 && previousSign !== desiredSign;

    if (actualFlip) motion.flips.push(axis);
    if (requestedReversal) {
      motion.requestedReversals.push(axis);
      if (actualFlip) motion.immediateReversals.push(axis);
      else motion.bufferedReversals.push(axis);
    }
  }

  return motion;
}
