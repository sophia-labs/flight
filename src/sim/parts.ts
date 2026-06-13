import type { Quaternion, Vec3 } from "../protocol/schema";

// v0.4.0: a sensor is a first-class DEVICE mounted at a pose on the airframe. This is the seam the
// camera study and (later) radar/IR ride on, and the same mount-pose concept a KSP-style builder
// will place. Deliberately NOT an airframe compiler or a multi-variant Part union yet — the only
// structural change the sensor foundation needs is `AircraftState.devices?: SensorDevice[]`. The
// compiler arrives with the builder (a later version), as a clean additive fold over these parts.

export type Modality = "camera" | "radar" | "ir";

// Where a device sits and which way it looks, in the aircraft's body frame.
// Body forward is -Z (see basisFromQuat in math.ts); rotation is the boresight offset vs that basis
// (identity = looks straight down the nose).
export interface DevicePose {
  offset: Vec3; // metres, body frame
  rotation: Quaternion; // boresight rotation vs the body basis
}

// What a device can physically perceive: a cone about its boresight, out to a range ceiling.
// halfAngleRad = Math.PI means omnidirectional; maxRangeM = Infinity means no range limit.
export interface FieldOfRegard {
  halfAngleRad: number;
  maxRangeM: number;
}

export interface SensorDevice {
  id: string; // stable, e.g. "nose-cam" — keys a recorded Percept back to its device
  kind: "sensor";
  modality: Modality;
  pose: DevicePose;
  for: FieldOfRegard;
  // Camera framing (rectangular image plane). Ignored by radar/ir. hFovRad = horizontal field of
  // view; aspect = width/height, used to derive the vertical field of view.
  optics?: { hFovRad: number; aspect: number };
}
