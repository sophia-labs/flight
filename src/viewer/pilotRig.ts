import * as THREE from "three";
import type { AircraftSnapshot, ControlInput, Part } from "../protocol/schema";
import { COCKPIT_SCALE, PILOT_AVATAR_SCALE, PILOT_AVATAR_YAW_RAD } from "../studio/pilotDefaults";
export { COCKPIT_SCALE, PILOT_AVATAR_SCALE, PILOT_AVATAR_YAW_RAD, PILOT_MODEL_URL } from "../studio/pilotDefaults";

export const PILOT_IK_CONFIG = Object.freeze({
  handIterations: 12,
  handMaxAngleRad: THREE.MathUtils.degToRad(35),
  footIterations: 4,
  footMaxAngleRad: THREE.MathUtils.degToRad(14),
});

export type CockpitAnchorName =
  | "seatHip"
  | "seatBack"
  | "rightGrip"
  | "leftThrottle"
  | "leftFoot"
  | "rightFoot";

export interface CanopyEnvelope {
  center: THREE.Vector3;
  id: string;
  size: THREE.Vector3;
}

export interface PilotStation {
  canopy: CanopyEnvelope | null;
  controlPoints: {
    leftPedal: THREE.Vector3;
    panelCenter: THREE.Vector3;
    rightPedal: THREE.Vector3;
    stickPivot: THREE.Vector3;
    throttlePivot: THREE.Vector3;
  };
  eye: THREE.Vector3;
  faceTarget: THREE.Vector3;
  layoutOffset: THREE.Vector3;
  seatBack: THREE.Vector3;
  seatHip: THREE.Vector3;
  source: "crew-station" | "canopy" | "sensor" | "fallback";
  stationId: string | null;
}

export interface PilotForces {
  vertical: number;
  lateral: number;
  foreAft: number;
}

export interface CockpitRigState {
  anchors: Record<CockpitAnchorName, THREE.Vector3>;
  controlPoints: {
    leftPedal: THREE.Vector3;
    panelCenter: THREE.Vector3;
    rightPedal: THREE.Vector3;
    stickPivot: THREE.Vector3;
    throttlePivot: THREE.Vector3;
  };
  pedalAngleRad: number;
  pedalTravel: number;
  station: PilotStation;
  stickPitchRad: number;
  stickRollRad: number;
  throttleAngleRad: number;
  yaw: number;
}

export interface AvatarRestJoint {
  x: number;
  y: number;
  z: number;
}

export const SAMPLE_AVATAR_REST_METERS = Object.freeze({
  hips: { x: 0, y: 0.9081, z: 0.032 },
  head: { x: 0, y: 1.3863, z: 0.0037 },
  leftShoulder: { x: 0.0224, y: 1.2865, z: 0.003 },
  leftUpperArm: { x: 0.1086, y: 1.2742, z: 0.003 },
  leftLowerArm: { x: 0.3284, y: 1.2742, z: 0.003 },
  leftHand: { x: 0.5431, y: 1.2742, z: 0.0026 },
  rightShoulder: { x: -0.0224, y: 1.2865, z: 0.003 },
  rightUpperArm: { x: -0.1086, y: 1.2742, z: 0.003 },
  rightLowerArm: { x: -0.3284, y: 1.2742, z: 0.003 },
  rightHand: { x: -0.5431, y: 1.2742, z: 0.0034 },
  leftUpperLeg: { x: 0.0772, y: 0.8683, z: 0.0284 },
  leftLowerLeg: { x: 0.0772, y: 0.5154, z: 0.021 },
  leftFoot: { x: 0.0772, y: 0.1007, z: -0.004 },
  rightUpperLeg: { x: -0.0772, y: 0.8683, z: 0.0284 },
  rightLowerLeg: { x: -0.0772, y: 0.5154, z: 0.021 },
  rightFoot: { x: -0.0772, y: 0.1007, z: -0.004 },
} satisfies Record<string, AvatarRestJoint>);

const DEFAULT_SEAT_HIP = v(0, -0.006, -4.35);
const DEFAULT_SEAT_BACK = v(0, 0.42, -4.12);
const DEFAULT_EYE = v(0, 0.45, -4.2);
const DEFAULT_HEAD = defaultHeadTarget();
const DEFAULT_EYE_FROM_HEAD = DEFAULT_EYE.clone().sub(DEFAULT_HEAD);
const DEFAULT_HEAD_FROM_HIP = DEFAULT_HEAD.clone().sub(DEFAULT_SEAT_HIP);
const DEFAULT_SEAT_BACK_FROM_HIP = DEFAULT_SEAT_BACK.clone().sub(DEFAULT_SEAT_HIP);
const STICK_PIVOT_FROM_HIP = v(0.12, -0.23, -4.95).sub(DEFAULT_SEAT_HIP);
const THROTTLE_PIVOT_FROM_HIP = v(-0.24, -0.23, -4.8).sub(DEFAULT_SEAT_HIP);
const LEFT_PEDAL_FROM_HIP = v(-0.22, -0.11, -5.34).sub(DEFAULT_SEAT_HIP);
const RIGHT_PEDAL_FROM_HIP = v(0.22, -0.11, -5.34).sub(DEFAULT_SEAT_HIP);
const PANEL_CENTER_FROM_HIP = v(0, 0.1, -5.05).sub(DEFAULT_SEAT_HIP);

export function resolvePilotStation(parts?: Part[]): PilotStation {
  const explicit = pilotCrewStation(parts);
  if (explicit) return stationFromCrewPart(explicit, parts);

  const sensorEye = cockpitSensorEye(parts);
  const eye = sensorEye ?? DEFAULT_EYE.clone();
  const canopy = selectCanopyEnvelope(parts, eye);

  if (!sensorEye && !canopy) {
    return buildStation(DEFAULT_SEAT_HIP.clone(), DEFAULT_EYE.clone(), null, "fallback");
  }

  const seatHip = seatHipForEye(eye);
  if (canopy) constrainSeatToCanopy(seatHip, canopy);
  return buildStation(seatHip, eye, canopy, canopy ? "canopy" : "sensor");
}

export function computeCockpitRig(controls: ControlInput, parts?: Part[]): CockpitRigState {
  const station = resolvePilotStation(parts);
  const stickPitchRad = clamp(controls.pitch, -1, 1) * 0.42;
  const stickRollRad = clamp(-controls.roll, -1, 1) * 0.36;
  const throttleAngleRad = -0.55 + clamp(controls.throttle, 0, 1) * 1.05;
  const yaw = clamp(controls.yaw, -1, 1);
  const pedalTravel = yaw * m(0.26);
  const pedalAngleRad = yaw * 0.24;

  const stickPivot = station.controlPoints.stickPivot.clone();
  const stickRotation = new THREE.Euler(stickPitchRad, 0, stickRollRad, "XYZ");
  const throttlePivot = station.controlPoints.throttlePivot.clone();
  const throttleRotation = new THREE.Euler(throttleAngleRad, 0, 0, "XYZ");

  const leftPedal = station.controlPoints.leftPedal.clone().add(new THREE.Vector3(0, 0, pedalTravel));
  const rightPedal = station.controlPoints.rightPedal.clone().add(new THREE.Vector3(0, 0, -pedalTravel));

  return {
    anchors: {
      seatHip: station.seatHip.clone(),
      seatBack: station.seatBack.clone(),
      rightGrip: transformLocal(stickPivot, stickRotation, v(0.055, 0.63, -0.025)),
      leftThrottle: transformLocal(throttlePivot, throttleRotation, v(0, 0.46, -0.035)),
      leftFoot: leftPedal,
      rightFoot: rightPedal,
    },
    controlPoints: {
      leftPedal,
      panelCenter: station.controlPoints.panelCenter.clone(),
      rightPedal,
      stickPivot,
      throttlePivot,
    },
    pedalAngleRad,
    pedalTravel,
    station,
    stickPitchRad,
    stickRollRad,
    throttleAngleRad,
    yaw,
  };
}

export function computePilotForces(ship: Pick<AircraftSnapshot, "controls" | "gLoad" | "stalled">): PilotForces {
  return {
    vertical: clamp(Math.max(0, ship.gLoad - 1) + (ship.stalled ? 0.65 : 0), 0, 6),
    lateral: clamp(-ship.controls.roll * 1.15 + ship.controls.yaw * 0.45, -2, 2),
    foreAft: clamp(-ship.controls.pitch * 0.65 + (ship.controls.throttle - 0.65) * 0.18, -2, 2),
  };
}

export function positionAvatarRootForSeat({
  hipLocalMeters,
  scale = PILOT_AVATAR_SCALE,
  seatHip,
  yawRad = PILOT_AVATAR_YAW_RAD,
}: {
  hipLocalMeters: THREE.Vector3;
  scale?: number;
  seatHip: THREE.Vector3;
  yawRad?: number;
}): THREE.Vector3 {
  const hipOffset = hipLocalMeters
    .clone()
    .multiplyScalar(scale)
    .applyAxisAngle(new THREE.Vector3(0, 1, 0), yawRad);
  return seatHip.clone().sub(hipOffset);
}

export function sampleAvatarJointInCockpit(
  name: keyof typeof SAMPLE_AVATAR_REST_METERS,
  rootPosition: THREE.Vector3,
  scale = PILOT_AVATAR_SCALE,
  yawRad = PILOT_AVATAR_YAW_RAD,
): THREE.Vector3 {
  const joint = SAMPLE_AVATAR_REST_METERS[name];
  return new THREE.Vector3(joint.x, joint.y, joint.z)
    .multiplyScalar(scale)
    .applyAxisAngle(new THREE.Vector3(0, 1, 0), yawRad)
    .add(rootPosition);
}

export function computeCockpitFitDiagnostics(controls: ControlInput = neutralControls(), parts?: Part[]) {
  const rig = computeCockpitRig(controls, parts);
  const root = positionAvatarRootForSeat({
    hipLocalMeters: restVec("hips"),
    seatHip: rig.anchors.seatHip,
  });

  const rightShoulder = sampleAvatarJointInCockpit("rightShoulder", root);
  const leftShoulder = sampleAvatarJointInCockpit("leftShoulder", root);
  const rightHip = sampleAvatarJointInCockpit("rightUpperLeg", root);
  const leftHip = sampleAvatarJointInCockpit("leftUpperLeg", root);

  return {
    root,
    headToCamera: sampleAvatarJointInCockpit("head", root).distanceTo(rig.station.eye),
    leftArm: reachDiagnostic(
      [restVec("leftShoulder"), restVec("leftUpperArm"), restVec("leftLowerArm"), restVec("leftHand")],
      leftShoulder,
      rig.anchors.leftThrottle,
    ),
    rightArm: reachDiagnostic(
      [restVec("rightShoulder"), restVec("rightUpperArm"), restVec("rightLowerArm"), restVec("rightHand")],
      rightShoulder,
      rig.anchors.rightGrip,
    ),
    leftLeg: reachDiagnostic(
      [restVec("leftUpperLeg"), restVec("leftLowerLeg"), restVec("leftFoot")],
      leftHip,
      rig.anchors.leftFoot,
    ),
    rightLeg: reachDiagnostic(
      [restVec("rightUpperLeg"), restVec("rightLowerLeg"), restVec("rightFoot")],
      rightHip,
      rig.anchors.rightFoot,
    ),
    station: rig.station,
  };
}

export function neutralControls(): ControlInput {
  return {
    pitch: 0,
    roll: 0,
    yaw: 0,
    throttle: 0.72,
    trigger: false,
  };
}

function reachDiagnostic(restChainMeters: THREE.Vector3[], start: THREE.Vector3, target: THREE.Vector3) {
  let available = 0;
  for (let index = 1; index < restChainMeters.length; index += 1) {
    available += restChainMeters[index - 1].distanceTo(restChainMeters[index]) * PILOT_AVATAR_SCALE;
  }

  const required = start.distanceTo(target);
  return {
    available,
    required,
    ratio: required / Math.max(available, 1e-6),
  };
}

function restVec(name: keyof typeof SAMPLE_AVATAR_REST_METERS): THREE.Vector3 {
  const joint = SAMPLE_AVATAR_REST_METERS[name];
  return new THREE.Vector3(joint.x, joint.y, joint.z);
}

function defaultHeadTarget(): THREE.Vector3 {
  const root = positionAvatarRootForSeat({
    hipLocalMeters: restVec("hips"),
    seatHip: DEFAULT_SEAT_HIP,
  });
  return sampleAvatarJointInCockpit("head", root);
}

function buildStation(
  seatHip: THREE.Vector3,
  eye: THREE.Vector3,
  canopy: CanopyEnvelope | null,
  source: PilotStation["source"],
  overrides: Partial<Pick<PilotStation, "controlPoints" | "seatBack" | "stationId">> = {},
): PilotStation {
  const faceTarget = seatHip.clone().add(DEFAULT_HEAD_FROM_HIP);
  const controlPoints = overrides.controlPoints ?? {
    leftPedal: seatHip.clone().add(LEFT_PEDAL_FROM_HIP),
    panelCenter: seatHip.clone().add(PANEL_CENTER_FROM_HIP),
    rightPedal: seatHip.clone().add(RIGHT_PEDAL_FROM_HIP),
    stickPivot: seatHip.clone().add(STICK_PIVOT_FROM_HIP),
    throttlePivot: seatHip.clone().add(THROTTLE_PIVOT_FROM_HIP),
  };
  return {
    canopy,
    controlPoints,
    eye: eye.clone(),
    faceTarget,
    layoutOffset: seatHip.clone().sub(DEFAULT_SEAT_HIP),
    seatBack: overrides.seatBack?.clone() ?? seatHip.clone().add(DEFAULT_SEAT_BACK_FROM_HIP),
    seatHip,
    stationId: overrides.stationId ?? null,
    source,
  };
}

function pilotCrewStation(parts?: Part[]): Extract<Part, { kind: "crew-station" }> | null {
  return parts?.find(
    (part): part is Extract<Part, { kind: "crew-station" }> => part.kind === "crew-station" && part.role === "pilot",
  ) ?? null;
}

function stationFromCrewPart(part: Extract<Part, { kind: "crew-station" }>, parts?: Part[]): PilotStation {
  const eye = crewPoint(part, part.seat.eye);
  const canopy = part.canopyId ? canopyEnvelopeForId(parts, part.canopyId) : selectCanopyEnvelope(parts, eye);
  return buildStation(crewPoint(part, part.seat.hip), eye, canopy, "crew-station", {
    controlPoints: {
      leftPedal: crewPoint(part, part.controls.leftPedal),
      panelCenter: crewPoint(part, part.controls.panel),
      rightPedal: crewPoint(part, part.controls.rightPedal),
      stickPivot: crewPoint(part, part.controls.stick),
      throttlePivot: crewPoint(part, part.controls.throttle),
    },
    seatBack: crewPoint(part, part.seat.back),
    stationId: part.id,
  });
}

function seatHipForEye(eye: THREE.Vector3): THREE.Vector3 {
  const head = eye.clone().sub(DEFAULT_EYE_FROM_HEAD);
  return head.sub(DEFAULT_HEAD_FROM_HIP);
}

function cockpitSensorEye(parts?: Part[]): THREE.Vector3 | null {
  const device = parts?.find((part) => part.kind === "sensor" && part.id === "cockpit-cam");
  return device ? vec3ToLocal(device.pose.offset) : null;
}

function canopyEnvelopeForId(parts: Part[] | undefined, id: string): CanopyEnvelope | null {
  const canopy = parts?.find((part): part is Extract<Part, { kind: "canopy" }> => part.kind === "canopy" && part.id === id);
  return canopy ? canopyEnvelope(canopy) : null;
}

function selectCanopyEnvelope(parts: Part[] | undefined, eye: THREE.Vector3): CanopyEnvelope | null {
  const envelopes = parts
    ?.filter((part): part is Extract<Part, { kind: "canopy" }> => part.kind === "canopy")
    .map(canopyEnvelope);
  if (!envelopes?.length) return null;

  return envelopes.reduce((best, candidate) =>
    canopyDistance(candidate, eye) < canopyDistance(best, eye) ? candidate : best,
  );
}

function canopyEnvelope(part: Extract<Part, { kind: "canopy" }>): CanopyEnvelope {
  const size = new THREE.Vector3(
    m(part.dims.width * 1.42),
    m(part.dims.height * 1.75),
    m(part.dims.length * 1.28),
  );
  const center = vec3ToLocal(part.pose.offset);
  center.y += size.y * 0.16;
  return { center, id: part.id, size };
}

function canopyDistance(canopy: CanopyEnvelope, eye: THREE.Vector3): number {
  return (
    Math.abs(canopy.center.z - eye.z) +
    Math.abs(canopy.center.x - eye.x) * 0.35 +
    Math.abs(canopy.center.y - eye.y) * 0.25
  );
}

function constrainSeatToCanopy(seatHip: THREE.Vector3, canopy: CanopyEnvelope) {
  const halfX = canopy.size.x * 0.5;
  const halfY = canopy.size.y * 0.5;
  const halfZ = canopy.size.z * 0.5;
  seatHip.x = clamp(seatHip.x, canopy.center.x - halfX * 0.2, canopy.center.x + halfX * 0.2);
  seatHip.y = clamp(seatHip.y, canopy.center.y - halfY * 0.92, canopy.center.y + halfY * 0.1);
  seatHip.z = clamp(seatHip.z, canopy.center.z - halfZ * 0.36, canopy.center.z + halfZ * 0.28);
}

function transformLocal(origin: THREE.Vector3, rotation: THREE.Euler, local: THREE.Vector3): THREE.Vector3 {
  return local.clone().applyEuler(rotation).add(origin);
}

function crewPoint(part: Extract<Part, { kind: "crew-station" }>, point: { x: number; y: number; z: number }): THREE.Vector3 {
  return new THREE.Vector3(point.x, point.y, point.z)
    .applyQuaternion(new THREE.Quaternion(part.pose.rotation.x, part.pose.rotation.y, part.pose.rotation.z, part.pose.rotation.w))
    .add(new THREE.Vector3(part.pose.offset.x, part.pose.offset.y, part.pose.offset.z))
    .multiplyScalar(COCKPIT_SCALE);
}

function vec3ToLocal(vec: { x: number; y: number; z: number }): THREE.Vector3 {
  return new THREE.Vector3(m(vec.x), m(vec.y), m(vec.z));
}

function m(value: number): number {
  return value * COCKPIT_SCALE;
}

function v(x: number, y: number, z: number): THREE.Vector3 {
  return new THREE.Vector3(m(x), m(y), m(z));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
