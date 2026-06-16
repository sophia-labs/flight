import type { Quaternion, Vec3 } from "../protocol/schema";
import { add, cross, dot, length, quatIdentity, rotateVec, scale, sub, vec3 } from "./math";
import type {
  AircraftModel,
  AircraftState,
  FuelTankMass,
  Inertia,
  MassElement,
  MassProperties,
  Mat3,
} from "./types";

interface Basis {
  right: Vec3;
  up: Vec3;
  forward: Vec3;
}

export const ZERO_MAT3: Mat3 = {
  xx: 0,
  xy: 0,
  xz: 0,
  yx: 0,
  yy: 0,
  yz: 0,
  zx: 0,
  zy: 0,
  zz: 0,
};

export function mat3(
  xx: number,
  xy: number,
  xz: number,
  yx: number,
  yy: number,
  yz: number,
  zx: number,
  zy: number,
  zz: number,
): Mat3 {
  return { xx, xy, xz, yx, yy, yz, zx, zy, zz };
}

export function mat3Diagonal(xx: number, yy: number, zz: number): Mat3 {
  return mat3(xx, 0, 0, 0, yy, 0, 0, 0, zz);
}

export function mat3Add(a: Mat3, b: Mat3): Mat3 {
  return mat3(
    a.xx + b.xx,
    a.xy + b.xy,
    a.xz + b.xz,
    a.yx + b.yx,
    a.yy + b.yy,
    a.yz + b.yz,
    a.zx + b.zx,
    a.zy + b.zy,
    a.zz + b.zz,
  );
}

export function mat3Scale(m: Mat3, scalar: number): Mat3 {
  return mat3(
    m.xx * scalar,
    m.xy * scalar,
    m.xz * scalar,
    m.yx * scalar,
    m.yy * scalar,
    m.yz * scalar,
    m.zx * scalar,
    m.zy * scalar,
    m.zz * scalar,
  );
}

export function mat3Vec(m: Mat3, v: Vec3): Vec3 {
  return vec3(
    m.xx * v.x + m.xy * v.y + m.xz * v.z,
    m.yx * v.x + m.yy * v.y + m.yz * v.z,
    m.zx * v.x + m.zy * v.y + m.zz * v.z,
  );
}

export function mat3Mul(a: Mat3, b: Mat3): Mat3 {
  return mat3(
    a.xx * b.xx + a.xy * b.yx + a.xz * b.zx,
    a.xx * b.xy + a.xy * b.yy + a.xz * b.zy,
    a.xx * b.xz + a.xy * b.yz + a.xz * b.zz,
    a.yx * b.xx + a.yy * b.yx + a.yz * b.zx,
    a.yx * b.xy + a.yy * b.yy + a.yz * b.zy,
    a.yx * b.xz + a.yy * b.yz + a.yz * b.zz,
    a.zx * b.xx + a.zy * b.yx + a.zz * b.zx,
    a.zx * b.xy + a.zy * b.yy + a.zz * b.zy,
    a.zx * b.xz + a.zy * b.yz + a.zz * b.zz,
  );
}

export function mat3Transpose(m: Mat3): Mat3 {
  return mat3(m.xx, m.yx, m.zx, m.xy, m.yy, m.zy, m.xz, m.yz, m.zz);
}

export function mat3Inverse(m: Mat3): Mat3 {
  const c00 = m.yy * m.zz - m.yz * m.zy;
  const c01 = -(m.yx * m.zz - m.yz * m.zx);
  const c02 = m.yx * m.zy - m.yy * m.zx;
  const c10 = -(m.xy * m.zz - m.xz * m.zy);
  const c11 = m.xx * m.zz - m.xz * m.zx;
  const c12 = -(m.xx * m.zy - m.xy * m.zx);
  const c20 = m.xy * m.yz - m.xz * m.yy;
  const c21 = -(m.xx * m.yz - m.xz * m.yx);
  const c22 = m.xx * m.yy - m.xy * m.yx;
  const det = m.xx * c00 + m.xy * c01 + m.xz * c02;
  if (Math.abs(det) < 1e-9 || !Number.isFinite(det)) {
    return mat3Diagonal(
      1 / Math.max(m.xx, 1),
      1 / Math.max(m.yy, 1),
      1 / Math.max(m.zz, 1),
    );
  }
  const invDet = 1 / det;
  return mat3(
    c00 * invDet,
    c10 * invDet,
    c20 * invDet,
    c01 * invDet,
    c11 * invDet,
    c21 * invDet,
    c02 * invDet,
    c12 * invDet,
    c22 * invDet,
  );
}

export function rotationMatrixFromQuat(q: Quaternion = quatIdentity()): Mat3 {
  const x = rotateVec(q, vec3(1, 0, 0));
  const y = rotateVec(q, vec3(0, 1, 0));
  const z = rotateVec(q, vec3(0, 0, 1));
  return mat3(x.x, y.x, z.x, x.y, y.y, z.y, x.z, y.z, z.z);
}

export function rotateInertiaTensor(localTensor: Mat3, rotation: Quaternion = quatIdentity()): Mat3 {
  const r = rotationMatrixFromQuat(rotation);
  return mat3Mul(mat3Mul(r, localTensor), mat3Transpose(r));
}

export function boxInertiaTensor(massKg: number, dimX: number, dimY: number, dimZ: number): Mat3 {
  const mass = Math.max(massKg, 0);
  return mat3Diagonal(
    (mass * (dimY * dimY + dimZ * dimZ)) / 12,
    (mass * (dimX * dimX + dimZ * dimZ)) / 12,
    (mass * (dimX * dimX + dimY * dimY)) / 12,
  );
}

function parallelAxisTensor(massKg: number, offset: Vec3): Mat3 {
  const r2 = dot(offset, offset);
  return mat3(
    massKg * (r2 - offset.x * offset.x),
    -massKg * offset.x * offset.y,
    -massKg * offset.x * offset.z,
    -massKg * offset.y * offset.x,
    massKg * (r2 - offset.y * offset.y),
    -massKg * offset.y * offset.z,
    -massKg * offset.z * offset.x,
    -massKg * offset.z * offset.y,
    massKg * (r2 - offset.z * offset.z),
  );
}

export function inertiaAboutCom(element: MassElement, com: Vec3): Mat3 {
  return mat3Add(element.localInertia, parallelAxisTensor(element.massKg, sub(element.localOffset, com)));
}

export function inertiaSummary(tensor: Mat3): Inertia {
  return {
    roll: Math.max(tensor.zz, 1),
    pitch: Math.max(tensor.xx, 1),
    yaw: Math.max(tensor.yy, 1),
  };
}

function fuelElement(tank: FuelTankMass, fuelKg: number): MassElement | null {
  const fuel = Math.max(0, Math.min(tank.capacityKg, fuelKg));
  if (fuel <= 0 || tank.capacityKg <= 0) return null;
  return {
    id: `${tank.id}:fuel`,
    massKg: fuel,
    localOffset: tank.localOffset,
    localInertia: mat3Scale(tank.localInertiaFull, fuel / tank.capacityKg),
  };
}

export function computeMassProperties(
  fixedMassElements: MassElement[],
  fuelTanks: FuelTankMass[] = [],
  fuelByTankKg: Record<string, number> = {},
): MassProperties {
  const elements: MassElement[] = [...fixedMassElements];
  for (const tank of fuelTanks) {
    const element = fuelElement(tank, fuelByTankKg[tank.id] ?? 0);
    if (element) elements.push(element);
  }

  let massKg = 0;
  let weighted = vec3(0, 0, 0);
  for (const element of elements) {
    massKg += element.massKg;
    weighted = add(weighted, scale(element.localOffset, element.massKg));
  }

  const com = massKg > 0 ? scale(weighted, 1 / massKg) : vec3(0, 0, 0);
  let inertiaTensor = ZERO_MAT3;
  for (const element of elements) {
    inertiaTensor = mat3Add(inertiaTensor, inertiaAboutCom(element, com));
  }
  inertiaTensor = mat3(
    Math.max(inertiaTensor.xx, 1),
    inertiaTensor.xy,
    inertiaTensor.xz,
    inertiaTensor.yx,
    Math.max(inertiaTensor.yy, 1),
    inertiaTensor.yz,
    inertiaTensor.zx,
    inertiaTensor.zy,
    Math.max(inertiaTensor.zz, 1),
  );

  return {
    massKg,
    com,
    inertiaTensor,
    inertia: inertiaSummary(inertiaTensor),
  };
}

export function fullFuelByTank(model: Pick<AircraftModel, "fuelTanks">): Record<string, number> {
  return Object.fromEntries(model.fuelTanks.map((tank) => [tank.id, tank.capacityKg]));
}

export function normalizeFuelState(aircraft: AircraftState): Record<string, number> {
  const tanks = aircraft.model.fuelTanks;
  if (tanks.length === 0) {
    aircraft.fuelKg = 0;
    aircraft.fuelByTankKg = undefined;
    return {};
  }

  if (!aircraft.fuelByTankKg) {
    const total = Math.max(0, Math.min(aircraft.model.fuelCapacityKg, aircraft.fuelKg));
    const fillFraction = aircraft.model.fuelCapacityKg > 0 ? total / aircraft.model.fuelCapacityKg : 0;
    aircraft.fuelByTankKg = Object.fromEntries(
      tanks.map((tank) => [tank.id, Math.min(tank.capacityKg, tank.capacityKg * fillFraction)]),
    );
  }

  const next: Record<string, number> = {};
  for (const tank of tanks) {
    next[tank.id] = Math.max(0, Math.min(tank.capacityKg, aircraft.fuelByTankKg[tank.id] ?? 0));
  }
  aircraft.fuelByTankKg = next;
  aircraft.fuelKg = Object.values(next).reduce((sum, fuel) => sum + fuel, 0);
  return next;
}

export function burnFuel(aircraft: AircraftState, burnKg: number): void {
  const fuelByTank = normalizeFuelState(aircraft);
  let remainingBurn = Math.max(0, burnKg);
  while (remainingBurn > 1e-9) {
    const fuelTotal = Object.values(fuelByTank).reduce((sum, fuel) => sum + fuel, 0);
    if (fuelTotal <= 0) break;
    const burnThisPass = Math.min(remainingBurn, fuelTotal);
    for (const tank of aircraft.model.fuelTanks) {
      const current = fuelByTank[tank.id] ?? 0;
      fuelByTank[tank.id] = Math.max(0, current - burnThisPass * (current / fuelTotal));
    }
    remainingBurn -= burnThisPass;
  }
  aircraft.fuelByTankKg = fuelByTank;
  aircraft.fuelKg = Object.values(fuelByTank).reduce((sum, fuel) => sum + fuel, 0);
}

export function currentMassProperties(aircraft: AircraftState): MassProperties {
  const fuelByTank = normalizeFuelState(aircraft);
  const mass = computeMassProperties(aircraft.model.fixedMassElements, aircraft.model.fuelTanks, fuelByTank);
  aircraft.massProperties = mass;
  return mass;
}

export function bodyRatesToLocalOmega(bodyRates: Vec3): Vec3 {
  return vec3(bodyRates.y, bodyRates.z, -bodyRates.x);
}

export function localOmegaToBodyRates(localOmega: Vec3): Vec3 {
  return vec3(-localOmega.z, localOmega.x, localOmega.y);
}

export function localVectorToWorld(local: Vec3, basis: Basis): Vec3 {
  return add(
    add(scale(basis.right, local.x), scale(basis.up, local.y)),
    scale(basis.forward, -local.z),
  );
}

export function worldVectorToLocal(world: Vec3, basis: Basis): Vec3 {
  return vec3(dot(world, basis.right), dot(world, basis.up), -dot(world, basis.forward));
}

export function integrateBodyAngularVelocity(
  omegaLocal: Vec3,
  torqueLocal: Vec3,
  inertiaTensor: Mat3,
  dt: number,
): Vec3 {
  const angularMomentum = mat3Vec(inertiaTensor, omegaLocal);
  const gyroscopicTorque = cross(omegaLocal, angularMomentum);
  const omegaDot = mat3Vec(mat3Inverse(inertiaTensor), sub(torqueLocal, gyroscopicTorque));
  const next = add(omegaLocal, scale(omegaDot, dt));
  return length(next) > 1e-8 && Number.isFinite(length(next)) ? next : vec3(0, 0, 0);
}
