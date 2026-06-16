import fs from "node:fs";
import { describe, expect, test } from "vitest";
import * as THREE from "three";
import type { GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { type VRM, type VRMHumanBoneName, VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";
import { solveCcdIk } from "../src/viewer/contactIk";
import { aircraftArchetypes } from "../src/sim/aircraftCatalog";
import { computePilotCinemaShot, pilotCinemaShotKeys } from "../src/viewer/pilotCinema";
import {
  type CanopyEnvelope,
  computeCockpitFitDiagnostics,
  computeCockpitRig,
  neutralControls,
  positionAvatarRootForSeat,
  resolvePilotStation,
  sampleAvatarJointInCockpit,
  SAMPLE_AVATAR_REST_METERS,
} from "../src/viewer/pilotRig";
import { CONTROLLED_PILOT_BONES } from "../src/viewer/pilotPose";

describe("pilot cockpit rig", () => {
  test("keeps the measured VRM skeleton close enough to every cockpit control target", () => {
    const diagnostics = computeCockpitFitDiagnostics();

    expect(diagnostics.headToCamera).toBeLessThan(0.015);
    expect(diagnostics.leftArm.ratio).toBeLessThan(0.95);
    expect(diagnostics.rightArm.ratio).toBeLessThan(1.25);
    expect(diagnostics.leftLeg.ratio).toBeLessThan(1.25);
    expect(diagnostics.rightLeg.ratio).toBeLessThan(1.25);

    const hip = sampleAvatarJointInCockpit("hips", diagnostics.root);
    expect(hip.distanceTo(computeCockpitRig(neutralControls()).anchors.seatHip)).toBeLessThan(1e-8);
  });

  test("moves stick, throttle, and pedals monotonically from control inputs", () => {
    const neutral = computeCockpitRig(neutralControls());
    const pitchUp = computeCockpitRig({ ...neutralControls(), pitch: 1 });
    const rollRight = computeCockpitRig({ ...neutralControls(), roll: 1 });
    const yawRight = computeCockpitRig({ ...neutralControls(), yaw: 1 });
    const throttleFull = computeCockpitRig({ ...neutralControls(), throttle: 1 });

    expect(pitchUp.anchors.rightGrip.z).toBeGreaterThan(neutral.anchors.rightGrip.z);
    expect(rollRight.anchors.rightGrip.x).toBeGreaterThan(neutral.anchors.rightGrip.x);
    expect(yawRight.anchors.leftFoot.z).toBeGreaterThan(neutral.anchors.leftFoot.z);
    expect(yawRight.anchors.rightFoot.z).toBeLessThan(neutral.anchors.rightFoot.z);
    expect(throttleFull.anchors.leftThrottle.z).toBeGreaterThan(neutral.anchors.leftThrottle.z);
  });

  test("root placement is the exact inverse of the measured hip transform", () => {
    const seatHip = computeCockpitRig(neutralControls()).anchors.seatHip;
    const root = positionAvatarRootForSeat({
      hipLocalMeters: new THREE.Vector3(
        SAMPLE_AVATAR_REST_METERS.hips.x,
        SAMPLE_AVATAR_REST_METERS.hips.y,
        SAMPLE_AVATAR_REST_METERS.hips.z,
      ),
      seatHip,
    });
    const hip = sampleAvatarJointInCockpit("hips", root);

    expect(hip.distanceTo(seatHip)).toBeLessThan(1e-8);
  });

  test("uses authored crew stations for each catalog aircraft and keeps the pilot inside the canopy", () => {
    for (const archetype of aircraftArchetypes) {
      const parts = archetype.airframe.parts;
      const station = resolvePilotStation(parts);
      const cockpit = computeCockpitRig(neutralControls(), parts);
      const diagnostics = computeCockpitFitDiagnostics(neutralControls(), parts);

      expect(station.source, archetype.id).toBe("crew-station");
      expect(station.stationId, archetype.id).toBe("pilot-station");
      expect(station.canopy, archetype.id).not.toBeNull();
      expect(cockpit.station.faceTarget.distanceTo(station.faceTarget), archetype.id).toBeLessThan(1e-8);
      expect(diagnostics.headToCamera, archetype.id).toBeLessThan(0.015);

      const canopy = station.canopy as CanopyEnvelope;
      const hip = sampleAvatarJointInCockpit("hips", diagnostics.root);
      const head = sampleAvatarJointInCockpit("head", diagnostics.root);
      expectInsideCanopy(head, canopy, archetype.id);
      expectInsideCanopy(hip, canopy, archetype.id, { yBelow: 0.04, zScale: 0.64 });
      expectInsideCanopy(cockpit.anchors.rightGrip, canopy, archetype.id, { yBelow: 0.02, zScale: 0.72 });
      expectInsideCanopy(cockpit.anchors.leftThrottle, canopy, archetype.id, { yBelow: 0.02, zScale: 0.72 });
    }
  });
});

describe("pilot cinema camera script", () => {
  test("has several authored shots with stable local camera distances", () => {
    expect(pilotCinemaShotKeys()).toEqual([
      "canopy-face",
      "right-shoulder-stick",
      "left-throttle",
      "pedals",
      "canopy-profile",
      "panel-over-shoulder",
    ]);

    for (let time = 0; time < 18; time += 0.8) {
      const shot = computePilotCinemaShot({ controls: neutralControls(), time });
      expect(shot.fov).toBeGreaterThanOrEqual(31);
      expect(shot.fov).toBeLessThanOrEqual(43);
      expect(shot.eye.distanceTo(shot.target)).toBeGreaterThan(0.08);
      expect(shot.eye.distanceTo(shot.target)).toBeLessThan(0.5);
      expect(Number.isFinite(shot.eye.x + shot.eye.y + shot.eye.z)).toBe(true);
      expect(Number.isFinite(shot.target.x + shot.target.y + shot.target.z)).toBe(true);
    }
  });

  test("control-oriented shots follow live stick, throttle, and pedal targets", () => {
    const neutral = neutralControls();
    const yawed = { ...neutral, yaw: 1 };
    const sticked = { ...neutral, pitch: 1, roll: 1 };
    const throttled = { ...neutral, throttle: 1 };

    const stickShotA = computePilotCinemaShot({ controls: neutral, time: 2.8 });
    const stickShotB = computePilotCinemaShot({ controls: sticked, time: 2.8 });
    expect(stickShotB.target.distanceTo(stickShotA.target)).toBeGreaterThan(0.006);

    const throttleShotA = computePilotCinemaShot({ controls: neutral, time: 5.6 });
    const throttleShotB = computePilotCinemaShot({ controls: throttled, time: 5.6 });
    expect(throttleShotB.target.distanceTo(throttleShotA.target)).toBeGreaterThan(0.002);

    const pedalShotA = computePilotCinemaShot({ controls: neutral, time: 8.0 });
    const pedalShotB = computePilotCinemaShot({ controls: yawed, time: 8.0 });
    expect(pedalShotB.target.distanceTo(pedalShotA.target)).toBeGreaterThan(0.0005);
  });
});

describe("pilot contact IK", () => {
  test("reduces end-effector error on a parented three-bone chain", () => {
    const root = new THREE.Object3D();
    const shoulder = new THREE.Object3D();
    const upper = new THREE.Object3D();
    const lower = new THREE.Object3D();
    const hand = new THREE.Object3D();
    const target = new THREE.Object3D();

    root.add(shoulder);
    shoulder.add(upper);
    upper.position.x = 1;
    upper.add(lower);
    lower.position.x = 1;
    lower.add(hand);
    hand.position.x = 1;
    target.position.set(1.7, 1.3, 0);
    root.add(target);
    root.updateMatrixWorld(true);

    const before = hand.getWorldPosition(new THREE.Vector3()).distanceTo(target.getWorldPosition(new THREE.Vector3()));
    const result = solveCcdIk({
      chain: [shoulder, upper, lower],
      effector: hand,
      iterations: 16,
      maxAngle: 0.55,
      target,
      updateWorld: () => root.updateMatrixWorld(true),
      weight: 1,
    });
    const after = hand.getWorldPosition(new THREE.Vector3()).distanceTo(target.getWorldPosition(new THREE.Vector3()));

    expect(result.parented).toBe(true);
    expect(result.rotations).toBeGreaterThan(0);
    expect(after).toBeLessThan(before * 0.2);
    expect(result.endError).not.toBeNull();
    expect(result.endError as number).toBeLessThan(0.08);
  });
});

describe("pilot VRM asset", () => {
  test("loads headlessly and exposes the humanoid bones needed by the cockpit rig", async () => {
    installThreeNodeShims();
    const vrm = await loadPilotVrm();
    VRMUtils.rotateVRM0(vrm);

    for (const boneName of CONTROLLED_PILOT_BONES) {
      expect(
        vrm.humanoid.getNormalizedBoneNode(boneName as VRMHumanBoneName) ??
          vrm.humanoid.getRawBoneNode(boneName as VRMHumanBoneName),
        boneName,
      ).toBeTruthy();
    }

    const box = new THREE.Box3().setFromObject(vrm.scene);
    const size = box.getSize(new THREE.Vector3());
    expect(size.y).toBeGreaterThan(1.4);
    expect(size.y).toBeLessThan(1.8);
  });
});

async function loadPilotVrm(): Promise<VRM> {
  const file = fs.readFileSync(new URL("../public/models/VRM1_Constraint_Twist_Sample.vrm", import.meta.url));
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));
  const arrayBuffer = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
  const gltf = await new Promise<GLTF>((resolve, reject) => {
    loader.parse(arrayBuffer, "", resolve, reject);
  });
  const vrm = gltf.userData.vrm as VRM | undefined;
  if (!vrm) throw new Error("VRM fixture did not parse as VRM.");
  return vrm;
}

function installThreeNodeShims() {
  const globals = globalThis as typeof globalThis & {
    createImageBitmap?: () => Promise<{ close: () => void; height: number; width: number }>;
  };
  Reflect.set(globalThis, "self", globalThis);
  globals.createImageBitmap ??= async () => ({ close() {}, height: 1, width: 1 });
}

function expectInsideCanopy(
  point: THREE.Vector3,
  canopy: CanopyEnvelope,
  label: string,
  options: { yBelow?: number; zScale?: number } = {},
) {
  const xHalf = canopy.size.x * 0.5;
  const yHalf = canopy.size.y * 0.5;
  const zHalf = canopy.size.z * 0.5 * (options.zScale ?? 1);
  expect(Math.abs(point.x - canopy.center.x), `${label} x`).toBeLessThanOrEqual(xHalf);
  expect(point.y, `${label} y floor`).toBeGreaterThanOrEqual(canopy.center.y - yHalf - (options.yBelow ?? 0));
  expect(point.y, `${label} y roof`).toBeLessThanOrEqual(canopy.center.y + yHalf);
  expect(point.z, `${label} z front`).toBeGreaterThanOrEqual(canopy.center.z - zHalf);
  expect(point.z, `${label} z aft`).toBeLessThanOrEqual(canopy.center.z + zHalf);
}
