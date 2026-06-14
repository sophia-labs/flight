import type { Airframe, Part, Vec3 } from "../protocol/schema";
import { add, clamp, normalize, quatIdentity, rotateVec, scale, vec3 } from "./math";
import type { SensorDevice } from "./parts";
import type { AeroSurface, AircraftModel, ControlAxis, Inertia, ThrustPoint } from "./types";

// The aircraft builder's keystone: a PURE fold from a parts list to the physical AircraftModel that
// stepAircraft consumes. Wings become aerodynamic surfaces with local axes and optional moving control
// panels; engines become thrust points; massful parts set CoM + inertia. A sensor is still a part, so
// "place a camera" and "fly from a camera" are one data path.
//
// Determinism is load-bearing. The legacy handling ratings still anchor to the DEFAULT airframe's own
// computed authority (so reports stay stable), but the v0.7 physics no longer reads those ratings as
// torque motors. The plane now handles because surfaces push on air at their placed locations.

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

// The default's reference handling ratings (rad/s) and stall AoA. These remain useful UI/reporting
// numbers, but surface-force physics reads model.aeroSurfaces.
const BASE_PITCH_RATE = 0.92;
const BASE_ROLL_RATE = 1.75;
const BASE_YAW_RATE = 0.34;
const STALL_AOA_RAD = 0.42;
const WING_THICKNESS_M = 0.1; // nominal slab thickness for a wing's box-inertia/mesh extents
const DEFAULT_DIHEDRAL_RAD = 0.075;

// No hidden safety floor: a control-surface-free build really has no control authority on that axis.
const RATE_RATIO_MIN = 0;
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

function normalizedAreaFraction(controlArea: number | undefined, totalArea: number): number {
  if (!controlArea || totalArea <= 0) return 0;
  return clamp(controlArea / totalArea, 0, 1.4);
}

function controlFor(axis: ControlAxis, sign: number, fraction: number): AeroSurface["control"] {
  if (fraction <= 0) return undefined;
  return {
    axis,
    sign,
    maxDeflectionRad: 0.24,
    // A small aileron should matter, and a huge full-span surface should saturate rather than explode.
    effectiveness: clamp(0.06 + fraction * 0.24, 0.06, 0.34),
  };
}

function makeSurface(
  part: Extract<Part, { kind: "wing" }>,
  opts: {
    id: string;
    areaM2: number;
    spanM: number;
    offset: Vec3;
    forward: Vec3;
    up: Vec3;
    kind: AeroSurface["kind"];
    control?: AeroSurface["control"];
  },
): AeroSurface {
  const aspectRatio = opts.areaM2 > 0 ? (opts.spanM * opts.spanM) / opts.areaM2 : 1;
  const vertical = opts.kind === "vertical";
  return {
    id: opts.id,
    areaM2: opts.areaM2,
    spanM: opts.spanM,
    chordM: part.planform.chord,
    aspectRatio: Math.max(aspectRatio, 0.2),
    localOffset: opts.offset,
    localForward: opts.forward,
    localUp: opts.up,
    kind: opts.kind,
    liftSlope: vertical ? 3.8 : 4.7,
    zeroLiftCl: vertical ? 0 : 0.24,
    cd0: vertical ? 0.018 : 0.026,
    stallAoARad: STALL_AOA_RAD,
    ...(opts.control ? { control: opts.control } : {}),
  };
}

function wingSurfaces(part: Extract<Part, { kind: "wing" }>): AeroSurface[] {
  const area = part.planform.span * part.planform.chord;
  if (area <= 0) return [];

  const yawSurface = part.control?.axis === "yaw";
  const forward = rotateVec(part.pose.rotation, vec3(0, 0, -1));
  const up = rotateVec(part.pose.rotation, yawSurface ? vec3(1, 0, 0) : vec3(0, 1, 0));
  const spanAxis = rotateVec(part.pose.rotation, yawSurface ? vec3(0, 1, 0) : vec3(1, 0, 0));
  const fraction = normalizedAreaFraction(part.control?.area, area);

  if (part.control?.axis === "roll") {
    const halfArea = area / 2;
    const halfSpan = part.planform.span / 2;
    return [-1, 1].map((side) =>
      {
        const panelUp = normalize(add(up, scale(spanAxis, -side * Math.sin(DEFAULT_DIHEDRAL_RAD))), up);
        return makeSurface(part, {
          id: `${part.id}-${side < 0 ? "left" : "right"}`,
          areaM2: halfArea,
          spanM: halfSpan,
          offset: add(part.pose.offset, scale(spanAxis, side * part.planform.span * 0.25)),
          forward,
          up: panelUp,
          kind: "horizontal",
          control: controlFor("roll", -side, fraction),
        });
      },
    );
  }

  const control =
    part.control?.axis === "pitch"
      ? controlFor("pitch", -1, fraction)
      : part.control?.axis === "yaw"
        ? controlFor("yaw", -1, fraction)
        : undefined;

  return [
    makeSurface(part, {
      id: part.id,
      areaM2: area,
      spanM: part.planform.span,
      offset: part.pose.offset,
      forward,
      up,
      kind: yawSurface ? "vertical" : "horizontal",
      control,
    }),
  ];
}

function thrustPoint(part: Extract<Part, { kind: "engine" }>): ThrustPoint {
  return {
    id: part.id,
    maxThrustN: part.thrustN,
    localOffset: part.pose.offset,
    localForward: rotateVec(part.pose.rotation, vec3(0, 0, -1)),
  };
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
    case "tank":
      // Full (wet) mass for CoM + inertia; inertia is held at the wet value as fuel burns (a stated cut).
      return { mass: part.dryMassKg + part.fuelKg, offset: part.pose.offset, dimX: part.dims.radius * 2, dimY: part.dims.radius * 2, dimZ: part.dims.length };
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
  let parasiteDragAreaM2 = 0;
  let fuelCapacityKg = 0; // Σ tank fuel; 0 (no tanks) ⇒ effectively infinite fuel (no burn)
  let liftArea = 0;
  let liftAreaZ = 0;
  let maxLiftSpan = 0;
  const devices: SensorDevice[] = [];
  const aeroSurfaces: AeroSurface[] = [];
  const thrustPoints: ThrustPoint[] = [];

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
        parasiteDragAreaM2 += part.dims.width * part.dims.height * 0.25;
        break;
      case "wing":
        massKg += part.massKg;
        aeroSurfaces.push(...wingSurfaces(part));
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
        thrustPoints.push(thrustPoint(part));
        parasiteDragAreaM2 += Math.PI * part.dims.radius * part.dims.radius * 0.25;
        break;
      case "tank":
        massKg += part.dryMassKg + part.fuelKg; // full mass; the fuel portion is burnable
        fuelCapacityKg += part.fuelKg;
        parasiteDragAreaM2 += Math.PI * part.dims.radius * part.dims.radius * 0.2;
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
  const controlAuthority: Record<ControlAxis, number> = {
    roll: auth.roll,
    pitch: auth.pitch,
    yaw: auth.yaw,
  };
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
    aeroSurfaces,
    thrustPoints,
    controlAuthority,
    parasiteDragAreaM2,
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
  surfaceCount: number;
  thrustPointCount: number;
  controlAuthority: Record<ControlAxis, number>;
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
  if (model.aeroSurfaces.length === 0) {
    warnings.push("no aerodynamic surfaces: the aircraft is ballistic");
  }
  if (model.thrustPoints.length === 0 && model.maxThrustN > 0) {
    warnings.push("thrust has no mounted engine point");
  }
  for (const axis of ["roll", "pitch", "yaw"] as const) {
    if (model.controlAuthority[axis] <= 0) warnings.push(`no ${axis} control surface`);
  }
  const flagRate = (axis: string, rate: number, base: number) => {
    if (rate > 0 && rate < base * 0.3) warnings.push(`weak ${axis} authority (<0.3× default rating)`);
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
    surfaceCount: model.aeroSurfaces.length,
    thrustPointCount: model.thrustPoints.length,
    controlAuthority: model.controlAuthority,
    warnings,
  };
}
