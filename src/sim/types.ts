import type {
  Airframe,
  AircraftSnapshot,
  ControlInput,
  Quaternion,
  ReplayEvent,
  Vec3,
} from "../protocol/schema";
import type { SensorDevice } from "./parts";

export type Team = "blue" | "red";

// Body-axis moments of inertia (kg·m²): roll about the longitudinal (forward/-Z) axis, pitch about
// the lateral (right/+X) axis, yaw about the vertical (up/+Y) axis.
export interface Inertia {
  roll: number;
  pitch: number;
  yaw: number;
}

export interface AircraftModel {
  // --- base scalars (the calibration anchors; maxRates are the full-stick steady rates) ---
  massKg: number;
  wingAreaM2: number;
  maxThrustN: number;
  maxPitchRate: number;
  maxRollRate: number;
  maxYawRate: number;
  stallAoARad: number;
  // --- v0.6.0 rigid-body physics: derived from the airframe geometry by compileAirframe ---
  inertia: Inertia; // resists angular acceleration; from part masses + layout (box self + parallel axis)
  com: Vec3; // centre of mass, body frame (m); the point moment arms + inertia are measured from
  aeroCenterZ: number; // area-weighted longitudinal centre of the lifting surfaces (m, body Z)
  staticMarginM: number; // aeroCenterZ − com.z; > 0 = CoM ahead of AC = statically stable
  aspectRatio: number; // span²/area of the lifting surfaces; drives induced drag
  dryMassKg: number; // massKg − fuelCapacityKg (structure + payload, no fuel)
  fuelCapacityKg: number; // total fuel a full airframe carries (0 = no tanks ⇒ effectively infinite)
}

export interface AircraftState {
  id: string;
  callsign: string;
  team: Team;
  color: string;
  position: Vec3;
  velocity: Vec3;
  orientation: Quaternion;
  controls: ControlInput;
  health: number;
  weaponCooldown: number;
  model: AircraftModel;
  metrics: FlightMetrics;
  // v0.6.0 rigid-body state: body-frame angular velocity (rad/s; x=roll, y=pitch, z=yaw) carried
  // between frames — the momentum the kinematic puppet never had — and remaining fuel mass (kg).
  angularVelocity: Vec3;
  fuelKg: number;
  devices?: SensorDevice[]; // v0.4.0: mounted sensors (camera, …). Static config, not per-frame state.
  // v0.5.0: the source airframe this aircraft was compiled from (model + devices above are its output).
  // Config-time metadata, NOT copied into AircraftSnapshot — runMatch records it onto the replay so the
  // viewer can render the plane that was built.
  airframe?: Airframe;
}

export interface FlightMetrics {
  airspeed: number;
  altitude: number;
  aoaDeg: number;
  gLoad: number;
  stalled: boolean;
}

export interface StepResult {
  aircraft: AircraftState[];
  events: ReplayEvent[];
}

export function toSnapshot(aircraft: AircraftState): AircraftSnapshot {
  return {
    id: aircraft.id,
    callsign: aircraft.callsign,
    team: aircraft.team,
    color: aircraft.color,
    position: aircraft.position,
    velocity: aircraft.velocity,
    orientation: aircraft.orientation,
    controls: aircraft.controls,
    airspeed: aircraft.metrics.airspeed,
    altitude: aircraft.metrics.altitude,
    aoaDeg: aircraft.metrics.aoaDeg,
    gLoad: aircraft.metrics.gLoad,
    health: aircraft.health,
    weaponCooldown: aircraft.weaponCooldown,
    stalled: aircraft.metrics.stalled,
  };
}
