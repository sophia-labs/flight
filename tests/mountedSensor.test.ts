import { describe, expect, it } from "vitest";
import { cockpitCamera } from "../src/sim/airframe";
import { defaultAirframe } from "../src/sim/airframe";
import { quatIdentity, vec3 } from "../src/sim/math";
import { cameraDevices, mountedSensorPose, selectCameraDevice } from "../src/sim/mountedSensor";

describe("mounted sensor pose", () => {
  it("selects the cockpit camera before other mounted cameras", () => {
    const parts = defaultAirframe().parts;

    expect(cameraDevices(parts).map((device) => device.id)).toEqual(["cockpit-cam", "nose-cam"]);
    expect(selectCameraDevice(parts).id).toBe("cockpit-cam");
    expect(selectCameraDevice(parts, "nose-cam").id).toBe("nose-cam");
  });

  it("computes the mounted camera eye and field of view from aircraft pose", () => {
    const device = cockpitCamera();
    const pose = mountedSensorPose(device, {
      position: vec3(10, 20, 30),
      orientation: quatIdentity(),
    });

    expect(pose.eye.x).toBeCloseTo(10);
    expect(pose.eye.y).toBeCloseTo(20.45);
    expect(pose.eye.z).toBeCloseTo(25.8);
    expect(pose.boresight).toEqual({ x: 0, y: 0, z: -1 });
    expect(pose.hFovRad).toBeCloseTo(device.optics!.hFovRad);
    expect(pose.vFovRad).toBeGreaterThan(0);
  });

  it("supports visual offset scaling without changing camera orientation", () => {
    const device = cockpitCamera();
    const pose = mountedSensorPose(
      device,
      { position: vec3(10, 20, 30), orientation: quatIdentity() },
      { offsetScale: 2 },
    );

    expect(pose.eye.y).toBeCloseTo(20.9);
    expect(pose.eye.z).toBeCloseTo(21.6);
    expect(pose.orientation).toEqual(quatIdentity());
  });
});
