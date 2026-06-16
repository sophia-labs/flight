import * as THREE from "three";
import type { ControlInput, Part } from "../protocol/schema";
import { computeCockpitRig } from "./pilotRig";

export interface PilotCinemaShot {
  key: string;
  eye: THREE.Vector3;
  fov: number;
  target: THREE.Vector3;
}

interface ShotDefinition {
  duration: number;
  eye: (rig: ReturnType<typeof computeCockpitRig>) => THREE.Vector3;
  fov: number;
  key: string;
  target: (rig: ReturnType<typeof computeCockpitRig>) => THREE.Vector3;
}

const SHOTS: ShotDefinition[] = [
  {
    key: "canopy-face",
    duration: 2.6,
    fov: 31,
    eye: (rig) => stationPoint(rig, 0.0, 0.112, -0.445),
    target: (rig) => pilotFaceTarget(rig),
  },
  {
    key: "right-shoulder-stick",
    duration: 2.8,
    fov: 36,
    eye: (rig) => stationPoint(rig, 0.24, 0.105, -0.405),
    target: (rig) => midpoint(pilotFaceTarget(rig), rig.anchors.rightGrip, 0.64),
  },
  {
    key: "left-throttle",
    duration: 2.3,
    fov: 39,
    eye: (rig) => stationPoint(rig, -0.28, 0.076, -0.405),
    target: (rig) => midpoint(pilotFaceTarget(rig), rig.anchors.leftThrottle, 0.72),
  },
  {
    key: "pedals",
    duration: 2.2,
    fov: 43,
    eye: (rig) => stationPoint(rig, 0.0, -0.035, -0.505),
    target: (rig) =>
      midpoint(rig.anchors.leftFoot, rig.anchors.rightFoot, 0.5).add(new THREE.Vector3(0, 0.018, rig.yaw * 0.018)),
  },
  {
    key: "canopy-profile",
    duration: 2.8,
    fov: 34,
    eye: (rig) => stationPoint(rig, 0.43, 0.135, -0.29),
    target: (rig) => pilotFaceTarget(rig).add(new THREE.Vector3(0, -0.002, -0.012)),
  },
  {
    key: "panel-over-shoulder",
    duration: 2.8,
    fov: 37,
    eye: (rig) => stationPoint(rig, -0.08, 0.165, -0.525),
    target: (rig) => midpoint(rig.controlPoints.panelCenter, rig.anchors.rightGrip, 0.45),
  },
];

const totalDuration = SHOTS.reduce((sum, shot) => sum + shot.duration, 0);

export function computePilotCinemaShot({
  controls,
  parts,
  time,
}: {
  controls: ControlInput;
  parts?: Part[];
  time: number;
}): PilotCinemaShot {
  const rig = computeCockpitRig(controls, parts);
  const wrapped = wrap(time, totalDuration);
  let cursor = 0;
  for (let index = 0; index < SHOTS.length; index += 1) {
    const shot = SHOTS[index];
    const nextCursor = cursor + shot.duration;
    if (wrapped <= nextCursor || index === SHOTS.length - 1) {
      const local = (wrapped - cursor) / shot.duration;
      const nextShot = SHOTS[(index + 1) % SHOTS.length];
      const blend = shotBlend(local);
      return {
        key: blend > 0 ? `${shot.key}->${nextShot.key}` : shot.key,
        eye: shot.eye(rig).lerp(nextShot.eye(rig), blend),
        fov: THREE.MathUtils.lerp(shot.fov, nextShot.fov, blend),
        target: shot.target(rig).lerp(nextShot.target(rig), blend),
      };
    }
    cursor = nextCursor;
  }

  const fallback = SHOTS[0];
  return { key: fallback.key, eye: fallback.eye(rig), fov: fallback.fov, target: fallback.target(rig) };
}

export function pilotCinemaShotKeys(): string[] {
  return SHOTS.map((shot) => shot.key);
}

function pilotFaceTarget(rig: ReturnType<typeof computeCockpitRig>): THREE.Vector3 {
  return rig.station.faceTarget.clone();
}

function stationPoint(rig: ReturnType<typeof computeCockpitRig>, x: number, y: number, z: number): THREE.Vector3 {
  return new THREE.Vector3(x, y, z).add(rig.station.layoutOffset);
}

function midpoint(a: THREE.Vector3, b: THREE.Vector3, amount: number): THREE.Vector3 {
  return a.clone().lerp(b, amount);
}

function shotBlend(progress: number): number {
  if (progress < 0.72) return 0;
  const t = THREE.MathUtils.clamp((progress - 0.72) / 0.28, 0, 1);
  return t * t * (3 - 2 * t);
}

function wrap(value: number, max: number): number {
  if (max <= 0) return 0;
  return ((value % max) + max) % max;
}
