import type { BodyProprioception, PilotIntentAction } from "../protocol/schema";
import type { BodyManifest } from "./manifest";

export interface BodyModelInput {
  manifest: BodyManifest;
  pilotIntent: PilotIntentAction;
  proprioception: BodyProprioception;
  memory?: string;
}

export type BodyModel = (input: BodyModelInput) => Promise<string>;

function targetSide(target: string) {
  if (target.startsWith("left_")) return -1;
  if (target.startsWith("right_")) return 1;
  return 0;
}

function bankedToward(attitude: string, side: number) {
  if (side < 0) return attitude.includes("left_bank");
  if (side > 0) return attitude.includes("right_bank");
  return true;
}

function expectedRoll(roll: number) {
  if (roll <= -4) return "left++";
  if (roll < 0) return "left+";
  if (roll >= 4) return "right++";
  if (roll > 0) return "right+";
  return "stable";
}

function expectedPitch(pitch: number) {
  if (pitch <= -3) return "down";
  if (pitch >= 3) return "up";
  if (pitch > 0) return "up";
  if (pitch < 0) return "down";
  return "stable";
}

export const scriptedFixedWingBodyModel: BodyModel = async ({ pilotIntent, proprioception, memory }) => {
  const side = targetSide(proprioception.target);
  const dangerousMargin =
    proprioception.stallMargin === "stalled" ||
    proprioception.stallMargin === "buffet" ||
    proprioception.stallMargin === "thin";
  const lowEnergy = proprioception.energy === "dead" || proprioception.energy === "low";
  const groundPanic = proprioception.pain.groundRush >= 4;
  const canPull = proprioception.affordances.includes("can_pull_gently");
  const alreadyBankedToward = bankedToward(proprioception.attitude, side);
  const risk = pilotIntent.riskTolerance;

  let roll = side === 0 ? 0 : side * (dangerousMargin ? 2 : risk > 0.7 ? 5 : 4);
  let pitch = 0;
  let yaw = side === 0 ? 0 : side * (dangerousMargin ? 1 : 2);
  let push = lowEnergy || dangerousMargin ? 5 : 4;
  let tone: "hold" | "pulse" | "brace" | "relax" | "reverse" = "hold";
  let toneLevel = 1;
  let feel = "holding shape while I feel the air";
  let nextMemory = memory ?? "";

  if (dangerousMargin || lowEnergy) {
    pitch = groundPanic ? 1 : -3;
    roll = side === 0 ? 0 : side * 2;
    yaw = side === 0 ? 0 : side;
    push = 5;
    tone = "brace";
    toneLevel = dangerousMargin ? 3 : 2;
    feel = groundPanic ? "low and mushy, pulling only enough" : "unloading before the wing stops listening";
    nextMemory = "unload wait_pull";
  } else if (groundPanic) {
    pitch = 4;
    roll = side === 0 ? 0 : side * 2;
    yaw = 0;
    push = 5;
    tone = "brace";
    toneLevel = 3;
    feel = "ground is loud, lifting with care";
    nextMemory = "ground lift_care";
  } else if (side !== 0 && alreadyBankedToward && canPull) {
    pitch = pilotIntent.urgency > 0.7 ? 3 : 2;
    push = 4;
    tone = "pulse";
    toneLevel = 2;
    feel = "bank is set, taking a careful bite";
    nextMemory = side < 0 ? "left_turn bite" : "right_turn bite";
  } else if (side !== 0) {
    pitch = -1;
    push = 5;
    tone = "brace";
    toneLevel = 1;
    feel = side < 0 ? "rolling left before I pull" : "rolling right before I pull";
    nextMemory = side < 0 ? "left_turn stage" : "right_turn stage";
  } else if (proprioception.target.includes("ahead") && canPull) {
    pitch = 1;
    push = 4;
    feel = "target ahead, keeping the nose fed";
    nextMemory = "lineup hold";
  }

  const speedExpect = pitch < 0 && push >= 4 ? "recover" : push <= 2 ? "bleed" : "stable";
  const marginExpect = dangerousMargin || pitch < 0 ? "better" : "stable";

  return [
    `MUSCLE ROLL=${roll} PITCH=${pitch} YAW=${yaw} PUSH=${push}`,
    `TONE ${tone} ${toneLevel}`,
    `EXPECT ROLL=${expectedRoll(roll)} PITCH=${expectedPitch(pitch)} SPEED=${speedExpect} MARGIN=${marginExpect}`,
    `FEEL ${feel}`,
    `MEM ${nextMemory}`.trim(),
  ].join("\n");
};

