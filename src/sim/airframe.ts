import type { Airframe, Part, Vec3 } from "../protocol/schema";
import { quatIdentity, vec3 } from "./math";
import type { SensorDevice } from "./parts";
import type { AircraftModel, Inertia } from "./types";

// The aircraft builder's keystone: a PURE fold from a parts list to the flat 7-scalar AircraftModel the
// physics already reads (src/sim/flight.ts → stepAircraft) plus the mounted SensorDevices. The physics
// is UNCHANGED — the compiler's whole job is to PRODUCE its inputs from geometry. A sensor is a part,
// so "place a camera" and "fly from a camera" are one data path.
//
// Determinism is load-bearing (byte-identical replays). The rates anchor to the DEFAULT airframe's own
// computed authority: rate = BASE * clamp(authority / DEFAULT_AUTHORITY). For the default that ratio is
// x/x = 1.0 EXACTLY in IEEE754, so compileAirframe(defaultAirframe()).model === DEFAULT_MODEL to the
// bit and every existing match stays byte-identical; for a user build it scales. Mass/area/thrust are
// plain sums; the default's part values are chosen to land on 9200 / 22.5 / 74000 exactly.

// The forward nose camera, expressed as a part so it serializes inside the airframe. Lives here (not in
// runtime/scenario) so the default airframe — the determinism anchor — can include it with no import
// cycle. A fresh instance per call (devices are static config, never mutated, but never shared either).
export function noseCamera(): SensorDevice {
  return {
    id: "nose-cam",
    kind: "sensor",
    modality: "camera",
    pose: { offset: vec3(0, 0, -18), rotation: quatIdentity() },
    for: { halfAngleRad: 0.7, maxRangeM: 8_000 },
    optics: { hFovRad: Math.PI / 3, aspect: 1.6 },
  };
}

// The canonical default airframe. By construction it compiles to exactly DEFAULT_MODEL (verified by a
// test), so all 24 existing replays and the scripted duel stay byte-identical. A factory (fresh objects)
// so two aircraft never share a mutable part reference. Part masses are integers summing to 9200; wing
// areas sum to 22.5 (13*1.5 + 4*0.75, the fin's 2*1 excluded as a vertical/yaw surface).
export function defaultAirframe(): Airframe {
  const body = quatIdentity();
  return {
    id: "default",
    parts: [
      {
        id: "fuselage",
        kind: "fuselage",
        pose: { offset: vec3(0, 0, 0), rotation: body },
        dims: { length: 12, width: 1.2, height: 1.2 },
        massKg: 6_000,
      },
      {
        id: "main-wing",
        kind: "wing",
        pose: { offset: vec3(0, 0, 0.3), rotation: body },
        planform: { span: 13, chord: 1.5 }, // 19.5 m²
        massKg: 1_500,
        control: { axis: "roll", area: 2 },
      },
      {
        id: "tailplane",
        kind: "wing",
        pose: { offset: vec3(0, 0.4, 5), rotation: body },
        planform: { span: 4, chord: 0.75 }, // 3.0 m²
        massKg: 400,
        control: { axis: "pitch", area: 2.4 },
      },
      {
        id: "fin",
        kind: "wing",
        pose: { offset: vec3(0, 0.8, 5), rotation: body },
        planform: { span: 2, chord: 1 }, // vertical: excluded from lift area
        massKg: 300,
        control: { axis: "yaw", area: 1.4 },
      },
      {
        id: "engine",
        kind: "engine",
        pose: { offset: vec3(0, 0, 4), rotation: body },
        thrustN: 74_000,
        massKg: 1_000,
        dims: { radius: 0.5, length: 2.4 },
      },
      noseCamera(),
    ],
  };
}

interface Authorities {
  roll: number;
  pitch: number;
  yaw: number;
}

// Control authority per axis = surface area * moment arm. Ailerons act at the wing semi-span; the
// elevator/rudder act at their longitudinal distance down the tail. This is the lever the existing sim
// actually rewards (control-surface size, NOT wing area, which only adds drag). A crude stand-in for
// torque/inertia — when the rigid-body stage lands, these same numbers feed a real moment.
function authorities(parts: Part[]): Authorities {
  const auth: Authorities = { roll: 0, pitch: 0, yaw: 0 };
  for (const part of parts) {
    if (part.kind !== "wing" || !part.control) continue;
    const arm =
      part.control.axis === "roll" ? part.planform.span / 2 : Math.abs(part.pose.offset.z);
    auth[part.control.axis] += part.control.area * arm;
  }
  return auth;
}

// Computed once from the default. The anchor that makes the default's rate ratio exactly 1.0.
const DEFAULT_AUTHORITY = authorities(defaultAirframe().parts);

// The default's reference full-stick steady rates (rad/s) and stall AoA — the ratio anchors to these so
// the default compiles to exactly these values (see rateFor). These WERE DEFAULT_MODEL's literals; they
// live here now so flight.ts can define DEFAULT_MODEL = compileAirframe(defaultAirframe()).model without
// an import cycle.
const BASE_PITCH_RATE = 0.92;
const BASE_ROLL_RATE = 1.75;
const BASE_YAW_RATE = 0.34;
const STALL_AOA_RAD = 0.42;
const WING_THICKNESS_M = 0.1; // nominal slab thickness for a wing's box-inertia/mesh extents

// A build with no surface on an axis still gets some authority (floor), and no build can exceed 3×, so
// the compiler never emits a dead or absurd rate. The default's ratio is 1.0 — inside the band, untouched.
const RATE_RATIO_MIN = 0.2;
const RATE_RATIO_MAX = 3.0;

function rateFor(base: number, authority: number, defaultAuthority: number): number {
  if (defaultAuthority <= 0) return base;
  const ratio = Math.max(RATE_RATIO_MIN, Math.min(RATE_RATIO_MAX, authority / defaultAuthority));
  return base * ratio;
}

export interface CompiledAirframe {
  model: AircraftModel;
  devices: SensorDevice[];
}

interface PartBox {
  mass: number;
  offset: Vec3;
  dimX: number; // body lateral extent (m)
  dimY: number; // body vertical extent
  dimZ: number; // body longitudinal extent
}

// A massive part's mass, body-frame position, and bounding-box extents — the inputs to CoM + box
// inertia. Sensors are treated as massless structure and contribute nothing. (Tanks: fuel milestone.)
function partBox(part: Part): PartBox | null {
  switch (part.kind) {
    case "fuselage":
      return { mass: part.massKg, offset: part.pose.offset, dimX: part.dims.width, dimY: part.dims.height, dimZ: part.dims.length };
    case "wing": {
      const vertical = part.control?.axis === "yaw"; // a fin's span runs up the Y axis
      return vertical
        ? { mass: part.massKg, offset: part.pose.offset, dimX: WING_THICKNESS_M, dimY: part.planform.span, dimZ: part.planform.chord }
        : { mass: part.massKg, offset: part.pose.offset, dimX: part.planform.span, dimY: WING_THICKNESS_M, dimZ: part.planform.chord };
    }
    case "engine":
      return { mass: part.massKg, offset: part.pose.offset, dimX: part.dims.radius * 2, dimY: part.dims.radius * 2, dimZ: part.dims.length };
    default:
      return null; // sensor
  }
}

// Solid-box inertia about the part's own centroid + parallel-axis transfer to the aircraft CoM.
// roll = about body Z (forward); pitch = about body X (right); yaw = about body Y (up). The box self
// term is what gives a long fuselage its real pitch/yaw inertia (m·L²/12) — a point mass would miss it.
function addBoxInertia(acc: Inertia, box: PartBox, com: Vec3): void {
  const { mass: m, dimX, dimY, dimZ } = box;
  const dx = box.offset.x - com.x;
  const dy = box.offset.y - com.y;
  const dz = box.offset.z - com.z;
  acc.roll += (m * (dimX * dimX + dimY * dimY)) / 12 + m * (dx * dx + dy * dy);
  acc.pitch += (m * (dimY * dimY + dimZ * dimZ)) / 12 + m * (dy * dy + dz * dz);
  acc.yaw += (m * (dimX * dimX + dimZ * dimZ)) / 12 + m * (dx * dx + dz * dz);
}

export function compileAirframe(airframe: Airframe): CompiledAirframe {
  let massKg = 0;
  let wingAreaM2 = 0;
  let maxThrustN = 0;
  const fuelCapacityKg = 0; // milestone 4 (tanks) sums this; no tanks today ⇒ effectively infinite fuel
  let liftArea = 0;
  let liftAreaZ = 0;
  let maxLiftSpan = 0;
  const devices: SensorDevice[] = [];

  // Pass 1: scalar sums, lift geometry, and mass-weighted CoM accumulation.
  let comMassX = 0;
  let comMassY = 0;
  let comMassZ = 0;
  for (const part of airframe.parts) {
    const box = partBox(part);
    if (box) {
      comMassX += box.mass * box.offset.x;
      comMassY += box.mass * box.offset.y;
      comMassZ += box.mass * box.offset.z;
    }
    switch (part.kind) {
      case "fuselage":
        massKg += part.massKg;
        break;
      case "wing":
        massKg += part.massKg;
        // Vertical (yaw) surfaces drive yaw but make no lift, so they don't add to the lift area.
        if (part.control?.axis !== "yaw") {
          const area = part.planform.span * part.planform.chord;
          wingAreaM2 += area;
          liftArea += area;
          liftAreaZ += area * part.pose.offset.z;
          if (part.planform.span > maxLiftSpan) maxLiftSpan = part.planform.span;
        }
        break;
      case "engine":
        massKg += part.massKg;
        maxThrustN += part.thrustN;
        break;
      case "sensor":
        devices.push(part);
        break;
    }
  }

  const com: Vec3 = massKg > 0 ? vec3(comMassX / massKg, comMassY / massKg, comMassZ / massKg) : vec3(0, 0, 0);

  // Pass 2: inertia about the CoM. Floor each axis so a degenerate (massless) build can't divide by 0.
  const inertia: Inertia = { roll: 0, pitch: 0, yaw: 0 };
  for (const part of airframe.parts) {
    const box = partBox(part);
    if (box) addBoxInertia(inertia, box, com);
  }
  inertia.roll = Math.max(inertia.roll, 1);
  inertia.pitch = Math.max(inertia.pitch, 1);
  inertia.yaw = Math.max(inertia.yaw, 1);

  // Aerodynamic centre = area-weighted longitudinal centre of the lifting surfaces; aspect ratio from
  // the widest lifting span. Both fall back to safe values for a wingless build.
  const aeroCenterZ = liftArea > 0 ? liftAreaZ / liftArea : com.z;
  const aspectRatio = liftArea > 0 && maxLiftSpan > 0 ? (maxLiftSpan * maxLiftSpan) / liftArea : 6;

  const auth = authorities(airframe.parts);
  const model: AircraftModel = {
    massKg,
    wingAreaM2,
    maxThrustN,
    maxPitchRate: rateFor(BASE_PITCH_RATE, auth.pitch, DEFAULT_AUTHORITY.pitch),
    maxRollRate: rateFor(BASE_ROLL_RATE, auth.roll, DEFAULT_AUTHORITY.roll),
    maxYawRate: rateFor(BASE_YAW_RATE, auth.yaw, DEFAULT_AUTHORITY.yaw),
    stallAoARad: STALL_AOA_RAD,
    inertia,
    com,
    aeroCenterZ,
    staticMarginM: aeroCenterZ - com.z, // > 0 ⇒ CoM ahead of AC ⇒ statically stable
    aspectRatio,
    dryMassKg: massKg - fuelCapacityKg,
    fuelCapacityKg,
  };

  return { model, devices };
}

export interface AirframeReport {
  thrustToWeight: number;
  wingLoadingNm2: number;
  maxPitchRate: number;
  maxRollRate: number;
  maxYawRate: number;
  warnings: string[];
}

// Flyability cues for the builder, computed against the EXACT sim constants (9.81 m/s², the 62 m/s
// stall floor that stepAircraft enforces). Warnings, not hard blocks — feeling a bad design is the game.
export function airframeReport(model: AircraftModel): AirframeReport {
  const weightN = model.massKg * 9.81;
  const thrustToWeight = model.maxThrustN / weightN;
  const wingLoadingNm2 = model.wingAreaM2 > 0 ? weightN / model.wingAreaM2 : Infinity;
  const warnings: string[] = [];

  if (model.wingAreaM2 <= 0) {
    warnings.push("no wing area: the aircraft cannot generate lift");
  } else if (wingLoadingNm2 > 6_000) {
    warnings.push("very high wing loading: needs high speed to stay airborne");
  }
  if (thrustToWeight < 0.3) {
    warnings.push("low thrust-to-weight (<0.3): may not accelerate past the 62 m/s stall floor");
  }
  const flagRate = (axis: string, rate: number, base: number) => {
    if (rate < base * 0.3) warnings.push(`barely controllable in ${axis} (<0.3× default rate)`);
  };
  flagRate("roll", model.maxRollRate, BASE_ROLL_RATE);
  flagRate("pitch", model.maxPitchRate, BASE_PITCH_RATE);
  flagRate("yaw", model.maxYawRate, BASE_YAW_RATE);

  return {
    thrustToWeight,
    wingLoadingNm2,
    maxPitchRate: model.maxPitchRate,
    maxRollRate: model.maxRollRate,
    maxYawRate: model.maxYawRate,
    warnings,
  };
}
