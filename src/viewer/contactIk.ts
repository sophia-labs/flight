import * as THREE from "three";

export interface CcdIkResult {
  availableReach: number | null;
  endError: number | null;
  maxAppliedAngle: number;
  parented: boolean | null;
  requiredReach: number | null;
  rotations: number;
  startError: number | null;
  unweightedStartError: number | null;
}

const scratch = {
  anchorTarget: new THREE.Vector3(),
  bonePosition: new THREE.Vector3(),
  boneWorld: new THREE.Quaternion(),
  current: new THREE.Vector3(),
  deltaWorld: new THREE.Quaternion(),
  desiredLocal: new THREE.Quaternion(),
  desiredWorld: new THREE.Quaternion(),
  effectorPosition: new THREE.Vector3(),
  effectorVector: new THREE.Vector3(),
  identity: new THREE.Quaternion(),
  limitedDeltaWorld: new THREE.Quaternion(),
  parentWorld: new THREE.Quaternion(),
  parentWorldInverse: new THREE.Quaternion(),
  target: new THREE.Vector3(),
  targetVector: new THREE.Vector3(),
};

export function solveCcdIk({
  chain,
  effector,
  iterations = 4,
  maxAngle = 0.3,
  target,
  updateWorld = () => {},
  weight = 1,
}: {
  chain: Array<THREE.Object3D | null | undefined>;
  effector: THREE.Object3D | null | undefined;
  iterations?: number;
  maxAngle?: number;
  target: THREE.Object3D | THREE.Vector3 | null | undefined;
  updateWorld?: () => void;
  weight?: number;
}): CcdIkResult {
  const bones = chain.filter((bone): bone is THREE.Object3D => Boolean(bone));
  const result: CcdIkResult = {
    availableReach: null,
    endError: null,
    maxAppliedAngle: 0,
    parented: null,
    requiredReach: null,
    rotations: 0,
    startError: null,
    unweightedStartError: null,
  };

  if (!effector || bones.length === 0 || !target) return result;

  const anchorTarget = resolveTargetPosition(target, scratch.anchorTarget);
  const current = effector.getWorldPosition(scratch.current);
  const weightedTarget = scratch.target.lerpVectors(
    current,
    anchorTarget,
    THREE.MathUtils.clamp(weight, 0, 1),
  );
  const reach = measureContactReach(bones, effector, weightedTarget);

  result.availableReach = reach.available;
  result.requiredReach = reach.required;
  result.startError = current.distanceTo(weightedTarget);
  result.unweightedStartError = current.distanceTo(anchorTarget);
  result.parented = bones.every((bone) => isAncestorOf(bone, effector));

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    for (let index = bones.length - 1; index >= 0; index -= 1) {
      const bone = bones[index];
      bone.getWorldPosition(scratch.bonePosition);
      effector.getWorldPosition(scratch.effectorPosition);

      scratch.effectorVector.subVectors(scratch.effectorPosition, scratch.bonePosition);
      scratch.targetVector.subVectors(weightedTarget, scratch.bonePosition);
      if (scratch.effectorVector.lengthSq() < 0.000001 || scratch.targetVector.lengthSq() < 0.000001) {
        continue;
      }

      scratch.effectorVector.normalize();
      scratch.targetVector.normalize();
      let angle = scratch.effectorVector.angleTo(scratch.targetVector);
      if (angle < 0.002) continue;

      scratch.deltaWorld.setFromUnitVectors(scratch.effectorVector, scratch.targetVector);
      if (angle > maxAngle) {
        scratch.limitedDeltaWorld.copy(scratch.identity).slerp(scratch.deltaWorld, maxAngle / angle);
        scratch.deltaWorld.copy(scratch.limitedDeltaWorld);
        angle = maxAngle;
      }

      scratch.parentWorld.identity();
      bone.parent?.getWorldQuaternion(scratch.parentWorld);
      scratch.parentWorldInverse.copy(scratch.parentWorld).invert();
      bone.getWorldQuaternion(scratch.boneWorld);
      scratch.desiredWorld.copy(scratch.deltaWorld).multiply(scratch.boneWorld);
      scratch.desiredLocal.copy(scratch.parentWorldInverse).multiply(scratch.desiredWorld);
      bone.quaternion.copy(scratch.desiredLocal);
      bone.updateMatrixWorld(true);
      updateWorld();
      result.rotations += 1;
      result.maxAppliedAngle = Math.max(result.maxAppliedAngle, angle);
    }
  }

  updateWorld();
  result.endError = effector.getWorldPosition(scratch.effectorPosition).distanceTo(weightedTarget);
  return result;
}

export function measureContactReach(chain: THREE.Object3D[], effector: THREE.Object3D, target: THREE.Vector3) {
  if (chain.length === 0) return { available: 0, required: 0 };

  let available = 0;
  const previous = chain[0].getWorldPosition(new THREE.Vector3());
  const current = new THREE.Vector3();
  for (let index = 1; index < chain.length; index += 1) {
    chain[index].getWorldPosition(current);
    available += previous.distanceTo(current);
    previous.copy(current);
  }

  effector.getWorldPosition(current);
  available += previous.distanceTo(current);

  return {
    available,
    required: chain[0].getWorldPosition(new THREE.Vector3()).distanceTo(target),
  };
}

export function isAncestorOf(candidate: THREE.Object3D, node: THREE.Object3D): boolean {
  let cursor: THREE.Object3D | null = node;
  while (cursor) {
    if (cursor === candidate) return true;
    cursor = cursor.parent;
  }
  return false;
}

function resolveTargetPosition(target: THREE.Object3D | THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  if (target instanceof THREE.Object3D) return target.getWorldPosition(out);
  return out.copy(target as THREE.Vector3);
}
