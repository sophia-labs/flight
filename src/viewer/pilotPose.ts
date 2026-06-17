import type { PilotForces } from "./pilotRig";

export interface Rotation {
  x: number;
  y: number;
  z: number;
}

export interface PilotPose {
  bones: Record<string, Rotation>;
  expressions: Record<string, number>;
  lookAt: { x: number; y: number };
}

export const CONTROLLED_PILOT_BONES = [
  "hips",
  "spine",
  "head",
  "leftShoulder",
  "chest",
  "upperChest",
  "leftUpperArm",
  "leftLowerArm",
  "leftHand",
  "rightShoulder",
  "rightUpperArm",
  "rightLowerArm",
  "rightHand",
  "leftUpperLeg",
  "leftLowerLeg",
  "leftFoot",
  "rightUpperLeg",
  "rightLowerLeg",
  "rightFoot",
] as const;

export const PILOT_EXPRESSION_NAMES = [
  "blink",
  "happy",
  "angry",
  "sad",
  "relaxed",
  "surprised",
  "aa",
  "ih",
  "ou",
  "ee",
  "oh",
] as const;

export function buildPilotPose({
  elapsed,
  forces,
  trigger,
}: {
  elapsed: number;
  forces: PilotForces;
  trigger: boolean;
}): PilotPose {
  const pose = createPose();
  addBones(pose, neutralArmPose());
  addBones(pose, seatedPose());
  addBones(pose, idlePose(elapsed));

  const automatic = automaticPose(elapsed);
  addExpressions(pose, automatic.expressions);
  addBones(pose, gForcePose(elapsed, forces).bones);
  addExpressions(pose, gForcePose(elapsed, forces).expressions);
  addLookAt(pose, gForcePose(elapsed, forces).lookAt);

  if (trigger) {
    addExpressions(pose, { angry: 0.12, aa: 0.2 });
    addBones(pose, { head: rotationDeg(-2, 0, 0), chest: rotationDeg(1, 0, 0) });
  }

  return pose;
}

export function buildPilotLoadoutPose({
  elapsed,
  expressionPreset = "focused",
}: {
  elapsed: number;
  expressionPreset?: "neutral" | "focused" | "excited" | "strained";
}): PilotPose {
  const pose = createPose();
  const breath = Math.sin(elapsed * 1.35);
  const sway = Math.sin(elapsed * 0.62);

  addBones(pose, {
    hips: rotationDeg(0, sway * 1.2, sway * 0.9),
    spine: rotationDeg(1.5 + breath * 0.7, sway * 0.7, -sway * 0.4),
    chest: rotationDeg(2.5 + breath * 0.9, sway * 1.1, -sway * 0.6),
    upperChest: rotationDeg(1.8 + breath * 0.5, sway * 0.7, -sway * 0.4),
    head: rotationDeg(0.8 + Math.sin(elapsed * 0.75) * 1.1, Math.sin(elapsed * 0.48) * 2.4, 0),
    leftShoulder: rotationDeg(0, 0, -4),
    rightShoulder: rotationDeg(0, 0, 4),
    leftUpperArm: rotationDeg(8 + breath * 0.6, 2, -62 + sway * 2),
    rightUpperArm: rotationDeg(8 + breath * 0.6, -2, 62 - sway * 2),
    leftLowerArm: rotationDeg(-8, 0, -7),
    rightLowerArm: rotationDeg(-8, 0, 7),
    leftHand: rotationDeg(0, Math.sin(elapsed * 0.9) * 2, -8),
    rightHand: rotationDeg(0, Math.sin(elapsed * 0.9 + 1.2) * 2, 8),
    leftUpperLeg: rotationDeg(2, 0, -2),
    rightUpperLeg: rotationDeg(2, 0, 2),
    leftLowerLeg: rotationDeg(-2, 0, 0),
    rightLowerLeg: rotationDeg(-2, 0, 0),
    leftFoot: rotationDeg(1, 0, -2),
    rightFoot: rotationDeg(1, 0, 2),
  });

  addExpressions(pose, {
    blink: autoBlinkValue(elapsed),
    relaxed: expressionPreset === "neutral" ? 0.22 : 0.14,
  });

  if (expressionPreset === "focused") addExpressions(pose, { ih: 0.04 });
  if (expressionPreset === "excited") addExpressions(pose, { happy: 0.32, aa: 0.08 });
  if (expressionPreset === "strained") addExpressions(pose, { angry: 0.2, ih: 0.18 });

  pose.lookAt = {
    x: Math.sin(elapsed * 0.45) * 0.18,
    y: Math.sin(elapsed * 0.58 + 0.8) * 0.08,
  };

  return pose;
}

export function rotationDeg(x = 0, y = 0, z = 0): Rotation {
  const toRad = Math.PI / 180;
  return { x: x * toRad, y: y * toRad, z: z * toRad };
}

function createPose(): PilotPose {
  return { bones: {}, expressions: {}, lookAt: { x: 0, y: 0 } };
}

function neutralArmPose(): Record<string, Rotation> {
  return {
    leftUpperArm: rotationDeg(0, 0, -54),
    leftLowerArm: rotationDeg(0, 0, -6),
    rightUpperArm: rotationDeg(0, 0, 54),
    rightLowerArm: rotationDeg(0, 0, 6),
  };
}

function seatedPose(): Record<string, Rotation> {
  return {
    hips: rotationDeg(-12, 0, 0),
    spine: rotationDeg(6, 0, 0),
    chest: rotationDeg(8, 0, 0),
    upperChest: rotationDeg(4, 0, 0),
    leftUpperLeg: rotationDeg(-84, 6, -6),
    rightUpperLeg: rotationDeg(-84, -6, 6),
    leftLowerLeg: rotationDeg(96, 0, 0),
    rightLowerLeg: rotationDeg(96, 0, 0),
    leftFoot: rotationDeg(-18, 0, 0),
    rightFoot: rotationDeg(-18, 0, 0),
    leftShoulder: rotationDeg(0, 0, -7),
    rightShoulder: rotationDeg(0, 0, 8),
    leftUpperArm: rotationDeg(20, 18, 18),
    leftLowerArm: rotationDeg(-58, -8, -18),
    leftHand: rotationDeg(-12, 10, -10),
    rightUpperArm: rotationDeg(32, -12, -24),
    rightLowerArm: rotationDeg(-60, 0, 18),
    rightHand: rotationDeg(-12, -8, 10),
  };
}

function idlePose(elapsed: number): Record<string, Rotation> {
  return {
    head: rotationDeg(
      Math.sin(elapsed * 0.9 + 0.8) * 0.8,
      Math.sin(elapsed * 0.65) * 2.0,
      0,
    ),
    chest: rotationDeg(0, Math.sin(elapsed * 0.45) * 1.2, 0),
  };
}

function automaticPose(elapsed: number): PilotPose {
  const blink = autoBlinkValue(elapsed);
  return {
    bones: {},
    expressions: {
      blink,
      aa: Math.max(0, Math.sin(elapsed * 8.5)) * 0.08,
      relaxed: 0.18,
    },
    lookAt: { x: 0, y: 0 },
  };
}

function mathClamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function gForcePose(elapsed: number, forces: PilotForces): PilotPose {
  const vertical = mathClamp(forces.vertical, 0, 6);
  const lateral = mathClamp(forces.lateral, -2, 2);
  const foreAft = mathClamp(forces.foreAft, -2, 2);
  const strain = clamp01(vertical / 6 + Math.abs(lateral) / 3 + Math.abs(foreAft) / 3);

  if (strain <= 0.001) return createPose();

  const buffet = (Math.sin(elapsed * 24) * 0.9 + Math.sin(elapsed * 39) * 0.35) * strain;
  return {
    bones: {
      chest: rotationDeg(3.2 * vertical - 2.5 * foreAft, -2.0 * lateral, 3.0 * lateral + buffet * 0.8),
      upperChest: rotationDeg(2.0 * vertical - 1.5 * foreAft, -1.5 * lateral, 2.0 * lateral + buffet * 0.5),
      head: rotationDeg(2.8 * vertical - 4.5 * foreAft + buffet, -4.0 * lateral, 5.0 * lateral + buffet * 0.8),
      leftUpperArm: rotationDeg(2.0 * vertical, 4.0 * lateral, -6.0 * strain),
      rightUpperArm: rotationDeg(2.0 * vertical, 4.0 * lateral, 6.0 * strain),
      leftLowerArm: rotationDeg(1.0 * vertical, 0, -4.0 * strain),
      rightLowerArm: rotationDeg(1.0 * vertical, 0, 4.0 * strain),
    },
    expressions: {
      angry: 0.18 * strain,
      ih: 0.22 * strain,
    },
    lookAt: {
      x: -0.12 * lateral,
      y: -0.045 * vertical + 0.06 * foreAft,
    },
  };
}

function addBones(pose: PilotPose, bones: Record<string, Rotation>) {
  for (const [name, rotation] of Object.entries(bones)) {
    const current = pose.bones[name] ?? { x: 0, y: 0, z: 0 };
    pose.bones[name] = {
      x: current.x + rotation.x,
      y: current.y + rotation.y,
      z: current.z + rotation.z,
    };
  }
}

function addExpressions(pose: PilotPose, expressions: Record<string, number>) {
  for (const [name, value] of Object.entries(expressions)) {
    pose.expressions[name] = clamp01((pose.expressions[name] ?? 0) + value);
  }
}

function addLookAt(pose: PilotPose, lookAt: { x: number; y: number }) {
  pose.lookAt.x += lookAt.x;
  pose.lookAt.y += lookAt.y;
}

function autoBlinkValue(time: number): number {
  const phase = time % 3.7;
  if (phase > 0.16) return 0;
  return Math.sin((phase / 0.16) * Math.PI);
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
