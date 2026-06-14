import type { Airframe, Part } from "../protocol/schema";
import { DEFAULT_MODEL } from "./flight";
import { quatIdentity, vec3 } from "./math";
import type { SensorDevice } from "./parts";
import type { AircraftModel } from "./types";

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

export function compileAirframe(airframe: Airframe): CompiledAirframe {
  let massKg = 0;
  let wingAreaM2 = 0;
  let maxThrustN = 0;
  const devices: SensorDevice[] = [];

  for (const part of airframe.parts) {
    switch (part.kind) {
      case "fuselage":
        massKg += part.massKg;
        break;
      case "wing":
        massKg += part.massKg;
        // Vertical (yaw) surfaces drive yaw but make no lift, so they don't add to the lift area.
        if (part.control?.axis !== "yaw") wingAreaM2 += part.planform.span * part.planform.chord;
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

  const auth = authorities(airframe.parts);
  const model: AircraftModel = {
    massKg,
    wingAreaM2,
    maxThrustN,
    maxPitchRate: rateFor(DEFAULT_MODEL.maxPitchRate, auth.pitch, DEFAULT_AUTHORITY.pitch),
    maxRollRate: rateFor(DEFAULT_MODEL.maxRollRate, auth.roll, DEFAULT_AUTHORITY.roll),
    maxYawRate: rateFor(DEFAULT_MODEL.maxYawRate, auth.yaw, DEFAULT_AUTHORITY.yaw),
    stallAoARad: DEFAULT_MODEL.stallAoARad, // no part drives stall yet (reserved: wing camber)
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
  flagRate("roll", model.maxRollRate, DEFAULT_MODEL.maxRollRate);
  flagRate("pitch", model.maxPitchRate, DEFAULT_MODEL.maxPitchRate);
  flagRate("yaw", model.maxYawRate, DEFAULT_MODEL.maxYawRate);

  return {
    thrustToWeight,
    wingLoadingNm2,
    maxPitchRate: model.maxPitchRate,
    maxRollRate: model.maxRollRate,
    maxYawRate: model.maxYawRate,
    warnings,
  };
}
