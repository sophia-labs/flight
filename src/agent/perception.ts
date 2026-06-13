import type { Percept, Vec3 } from "../protocol/schema";
import {
  add,
  basisFromQuat,
  clamp,
  cross,
  dot,
  length,
  normalize,
  quatMultiply,
  rotateVec,
  scale,
  sub,
  WORLD_UP,
} from "../sim/math";
import type { Modality, SensorDevice } from "../sim/parts";
import type { AircraftState, Team } from "../sim/types";
import { cameraAsciiEncoder } from "./encoders/cameraAscii";

// v0.4.0 perception seam — the structural mirror of the action seam:
//   action:     intent  -> adapterFor(kind).controlFor -> ControlInput   (sim-facing)
//   perception: world   -> sensorFor(modality).sense    -> SenseFrame     (geometric truth)
//                          encoderFor(id).encode         -> Percept        (model-readable artifact)
// A Sensor is the PHYSICS of sensing (what reaches the device, deterministic, pixel-free). An
// Encoder is the REPRESENTATION (how that becomes something a model could read). Today only the
// camera is implemented, and its Percept is RECORDED for the viewer — not yet fed to the pilot.

// One contact as a sensor resolves it. ndc are projected image-plane coords in [-1,1] (x right, y
// up), meaningful only when inView. All angles in radians.
export interface ProjectedContact {
  id: string;
  team: Team;
  health: number;
  range: number;
  ndcX: number;
  ndcY: number;
  angularRadiusRad: number; // subtended radius — the rendering-free range cue
  aspectRad: number; // target heading vs the line from it to us: 0 = nose-on, PI = tail-on
  inView: boolean; // passes the device cone + range gate
}

// The deterministic, pixel-free sense-datum (geometric truth). Internal — not serialized; the
// recorded artifact is the Percept. eye/boresight are world-space (the v0.5.0 viewer builds the
// true frustum from them).
export interface SenseFrame {
  modality: Modality;
  deviceId: string;
  eye: Vec3;
  boresight: Vec3;
  bankRad: number;
  pitchRad: number;
  hHalfFovRad: number;
  vHalfFovRad: number;
  selfSpeed: number;
  selfAltitude: number;
  contacts: ProjectedContact[];
}

export interface Sensor {
  readonly modality: Modality;
  // PURE: no RNG, no clock, no GPU. Two calls on the same (device, world, self) are byte-identical.
  sense(device: SensorDevice, world: AircraftState[], self: AircraftState): SenseFrame;
}

export interface Encoder {
  readonly id: string;
  readonly modality: Modality;
  encode(frame: SenseFrame): Percept; // SYNC in v0.4.0 (a future async VLM encoder changes this then)
}

const AIRFRAME_RADIUS_M = 8; // ~16 m span; turns range into an apparent angular size

// Analytic camera: projects world contacts onto the device's image plane from its mount pose.
// No pixels are rendered — this is the geometry a renderer (or a text encoder) would draw from.
export const cameraSensor: Sensor = {
  modality: "camera",
  sense(device, world, self) {
    const eye = add(self.position, rotateVec(self.orientation, device.pose.offset));
    const camOrient = quatMultiply(self.orientation, device.pose.rotation);
    const basis = basisFromQuat(camOrient);
    const boresight = basis.forward;

    // Camera attitude — same bank/pitch formula the setpoint adapter uses, on the camera basis.
    const refUp = normalize(sub(WORLD_UP, scale(boresight, dot(WORLD_UP, boresight))), basis.up);
    const bankRad = Math.atan2(dot(cross(refUp, basis.up), boresight), dot(refUp, basis.up));
    const pitchRad = Math.asin(clamp(boresight.y, -1, 1));

    const hHalfFovRad = (device.optics?.hFovRad ?? Math.PI / 3) / 2;
    const aspect = device.optics?.aspect ?? 4 / 3;
    const tanH = Math.tan(Math.max(hHalfFovRad, 1e-4)); // floor keeps a degenerate FOV from making ndc NaN
    const tanV = tanH / aspect;
    const vHalfFovRad = Math.atan(tanV);

    const contacts: ProjectedContact[] = [];
    for (const other of world) {
      if (other.id === self.id || other.health <= 0) continue;

      const toC = sub(other.position, eye);
      const range = length(toC);
      const dir = normalize(toC, boresight); // boresight fallback keeps a coincident contact finite
      const f = dot(dir, boresight);
      const ahead = f > 1e-6;
      const angleFromBoresightRad = Math.acos(clamp(f, -1, 1));
      const inView =
        ahead && angleFromBoresightRad <= device.for.halfAngleRad && range <= device.for.maxRangeM;

      // Perspective divide (only meaningful in front of the lens); normalized by the half-FOV tangents.
      const ndcX = ahead ? dot(dir, basis.right) / f / tanH : 0;
      const ndcY = ahead ? dot(dir, basis.up) / f / tanV : 0;

      const angularRadiusRad = Math.atan2(AIRFRAME_RADIUS_M, Math.max(range, 1));

      // Aspect: where the target's nose points relative to the line from it to us.
      const toUs = normalize(sub(eye, other.position), boresight);
      const targetForward = basisFromQuat(other.orientation).forward;
      const aspectRad = Math.acos(clamp(dot(targetForward, toUs), -1, 1));

      contacts.push({
        id: other.id,
        team: other.team,
        health: other.health,
        range,
        ndcX,
        ndcY,
        angularRadiusRad,
        aspectRad,
        inView,
      });
    }

    return {
      modality: "camera",
      deviceId: device.id,
      eye,
      boresight,
      bankRad,
      pitchRad,
      hHalfFovRad,
      vHalfFovRad,
      selfSpeed: length(self.velocity),
      selfAltitude: self.position.y,
      contacts,
    };
  },
};

const SENSORS: Partial<Record<Modality, Sensor>> = {
  camera: cameraSensor,
  // radar / ir: deferred — the seam exists, the physics lands in a later version.
};

const ENCODERS: Record<string, Encoder> = {
  [cameraAsciiEncoder.id]: cameraAsciiEncoder,
};

const DEFAULT_ENCODER: Partial<Record<Modality, string>> = {
  camera: cameraAsciiEncoder.id,
};

export function sensorFor(modality: Modality): Sensor {
  const sensor = SENSORS[modality];
  if (!sensor) throw new Error(`no sensor implementation for modality: ${modality}`);
  return sensor;
}

export function encoderFor(id: string): Encoder {
  const encoder = ENCODERS[id];
  if (!encoder) throw new Error(`no encoder registered: ${id}`);
  return encoder;
}

export function defaultEncoderId(modality: Modality): string {
  const id = DEFAULT_ENCODER[modality];
  if (!id) throw new Error(`no default encoder for modality: ${modality}`);
  return id;
}

// Convenience for the runtime: run a device's sensor through its default encoder into a Percept.
export function senseAndEncode(
  device: SensorDevice,
  world: AircraftState[],
  self: AircraftState,
): Percept {
  const frame = sensorFor(device.modality).sense(device, world, self);
  return encoderFor(defaultEncoderId(device.modality)).encode(frame);
}
