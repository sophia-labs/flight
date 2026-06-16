import type { Part, Quaternion, Vec3 } from "../protocol/schema";
import { cockpitCamera } from "./airframe";
import { add, basisFromQuat, clamp, cross, dot, normalize, quatMultiply, rotateVec, scale, sub, WORLD_UP } from "./math";
import type { SensorDevice } from "./parts";

export interface SensorCarrier {
  position: Vec3;
  orientation: Quaternion;
}

export interface MountedSensorPose {
  eye: Vec3;
  orientation: Quaternion;
  basis: ReturnType<typeof basisFromQuat>;
  boresight: Vec3;
  bankRad: number;
  pitchRad: number;
  hHalfFovRad: number;
  vHalfFovRad: number;
  hFovRad: number;
  vFovRad: number;
  aspect: number;
}

export function cameraDevices(parts: Part[] | undefined): SensorDevice[] {
  return (parts ?? []).filter(
    (part): part is SensorDevice => part.kind === "sensor" && part.modality === "camera",
  );
}

export function selectCameraDevice(parts: Part[] | undefined, preferredId = "cockpit-cam"): SensorDevice {
  const cameras = cameraDevices(parts);
  return (
    cameras.find((device) => device.id === preferredId) ??
    cameras.find((device) => device.id === "cockpit-cam") ??
    cameras[0] ??
    cockpitCamera()
  );
}

export function mountedSensorPose(
  device: SensorDevice,
  carrier: SensorCarrier,
  options: { offsetScale?: number; aspectOverride?: number } = {},
): MountedSensorPose {
  const offsetScale = options.offsetScale ?? 1;
  const eye = add(carrier.position, rotateVec(carrier.orientation, scale(device.pose.offset, offsetScale)));
  const orientation = quatMultiply(carrier.orientation, device.pose.rotation);
  const basis = basisFromQuat(orientation);
  const boresight = basis.forward;
  const refUp = normalize(sub(WORLD_UP, scale(boresight, dot(WORLD_UP, boresight))), basis.up);
  const bankRad = Math.atan2(dot(cross(refUp, basis.up), boresight), dot(refUp, basis.up));
  const pitchRad = Math.asin(clamp(boresight.y, -1, 1));
  const hFovRad = device.optics?.hFovRad ?? Math.PI / 3;
  const aspect = options.aspectOverride ?? device.optics?.aspect ?? 4 / 3;
  const hHalfFovRad = hFovRad / 2;
  const vHalfFovRad = Math.atan(Math.tan(Math.max(hHalfFovRad, 1e-4)) / aspect);

  return {
    eye,
    orientation,
    basis,
    boresight,
    bankRad,
    pitchRad,
    hHalfFovRad,
    vHalfFovRad,
    hFovRad,
    vFovRad: vHalfFovRad * 2,
    aspect,
  };
}
