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

export interface AircraftModel {
  massKg: number;
  wingAreaM2: number;
  maxThrustN: number;
  maxPitchRate: number;
  maxRollRate: number;
  maxYawRate: number;
  stallAoARad: number;
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
