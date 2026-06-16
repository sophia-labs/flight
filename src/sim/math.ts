import type { Quaternion, Vec3 } from "../protocol/schema";

export const ZERO: Vec3 = { x: 0, y: 0, z: 0 };
export const WORLD_UP: Vec3 = { x: 0, y: 1, z: 0 };

export function vec3(x: number, y: number, z: number): Vec3 {
  return { x, y, z };
}

export function add(a: Vec3, b: Vec3): Vec3 {
  return vec3(a.x + b.x, a.y + b.y, a.z + b.z);
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return vec3(a.x - b.x, a.y - b.y, a.z - b.z);
}

export function scale(v: Vec3, scalar: number): Vec3 {
  return vec3(v.x * scalar, v.y * scalar, v.z * scalar);
}

export function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return vec3(
    a.y * b.z - a.z * b.y,
    a.z * b.x - a.x * b.z,
    a.x * b.y - a.y * b.x,
  );
}

export function length(v: Vec3): number {
  return Math.hypot(v.x, v.y, v.z);
}

export function normalize(v: Vec3, fallback: Vec3 = ZERO): Vec3 {
  const magnitude = length(v);
  if (magnitude < 1e-8) {
    return fallback;
  }

  return scale(v, 1 / magnitude);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function quatIdentity(): Quaternion {
  return { x: 0, y: 0, z: 0, w: 1 };
}

export function quatNormalize(q: Quaternion): Quaternion {
  const magnitude = Math.hypot(q.x, q.y, q.z, q.w);
  if (magnitude < 1e-8) {
    return quatIdentity();
  }

  return {
    x: q.x / magnitude,
    y: q.y / magnitude,
    z: q.z / magnitude,
    w: q.w / magnitude,
  };
}

export function quatMultiply(a: Quaternion, b: Quaternion): Quaternion {
  return {
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  };
}

export function quatFromAxisAngle(axis: Vec3, angle: number): Quaternion {
  const normal = normalize(axis, WORLD_UP);
  const half = angle / 2;
  const sine = Math.sin(half);

  return quatNormalize({
    x: normal.x * sine,
    y: normal.y * sine,
    z: normal.z * sine,
    w: Math.cos(half),
  });
}

export function rotateVec(q: Quaternion, v: Vec3): Vec3 {
  const x2 = q.x + q.x;
  const y2 = q.y + q.y;
  const z2 = q.z + q.z;
  const xx = q.x * x2;
  const xy = q.x * y2;
  const xz = q.x * z2;
  const yy = q.y * y2;
  const yz = q.y * z2;
  const zz = q.z * z2;
  const wx = q.w * x2;
  const wy = q.w * y2;
  const wz = q.w * z2;

  return vec3(
    (1 - (yy + zz)) * v.x + (xy - wz) * v.y + (xz + wy) * v.z,
    (xy + wz) * v.x + (1 - (xx + zz)) * v.y + (yz - wx) * v.z,
    (xz - wy) * v.x + (yz + wx) * v.y + (1 - (xx + yy)) * v.z,
  );
}

export function basisFromQuat(q: Quaternion) {
  return {
    right: rotateVec(q, vec3(1, 0, 0)),
    up: rotateVec(q, vec3(0, 1, 0)),
    forward: rotateVec(q, vec3(0, 0, -1)),
  };
}

export function rotateAroundWorldAxis(q: Quaternion, axis: Vec3, angle: number): Quaternion {
  return quatNormalize(quatMultiply(quatFromAxisAngle(axis, angle), q));
}

export function integrateLocalAngularVelocity(q: Quaternion, localAngularVelocity: Vec3, dt: number): Quaternion {
  const angularSpeed = length(localAngularVelocity);
  if (angularSpeed < 1e-8 || dt <= 0) {
    return quatNormalize(q);
  }

  return quatNormalize(
    quatMultiply(q, quatFromAxisAngle(localAngularVelocity, angularSpeed * dt)),
  );
}

export function quatLookRotation(forwardInput: Vec3, upInput: Vec3 = WORLD_UP): Quaternion {
  const forward = normalize(forwardInput, vec3(0, 0, -1));
  let right = normalize(cross(forward, upInput), vec3(1, 0, 0));
  let up = normalize(cross(right, forward), WORLD_UP);

  if (length(right) < 1e-8) {
    right = vec3(1, 0, 0);
    up = WORLD_UP;
  }

  const back = scale(forward, -1);
  const m00 = right.x;
  const m01 = up.x;
  const m02 = back.x;
  const m10 = right.y;
  const m11 = up.y;
  const m12 = back.y;
  const m20 = right.z;
  const m21 = up.z;
  const m22 = back.z;
  const trace = m00 + m11 + m22;

  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    return quatNormalize({
      w: 0.25 * s,
      x: (m21 - m12) / s,
      y: (m02 - m20) / s,
      z: (m10 - m01) / s,
    });
  }

  if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    return quatNormalize({
      w: (m21 - m12) / s,
      x: 0.25 * s,
      y: (m01 + m10) / s,
      z: (m02 + m20) / s,
    });
  }

  if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    return quatNormalize({
      w: (m02 - m20) / s,
      x: (m01 + m10) / s,
      y: 0.25 * s,
      z: (m12 + m21) / s,
    });
  }

  const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
  return quatNormalize({
    w: (m10 - m01) / s,
    x: (m02 + m20) / s,
    y: (m12 + m21) / s,
    z: 0.25 * s,
  });
}
