import type {
  Airframe,
  AircraftSnapshot,
  ControlInput,
  Quaternion,
  ReplayEvent,
  SurfaceControlSnapshot,
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

export type ControlAxis = "pitch" | "roll" | "yaw";

export interface AeroSurfaceControl {
  axis: ControlAxis;
  sign: number;
  maxDeflectionRad: number;
  effectiveness: number;
}

export interface AeroSurface {
  id: string;
  areaM2: number;
  spanM: number;
  chordM: number;
  aspectRatio: number;
  localOffset: Vec3;
  localForward: Vec3;
  localUp: Vec3;
  kind: "horizontal" | "vertical";
  liftSlope: number;
  zeroLiftCl: number;
  cd0: number;
  stallAoARad: number;
  control?: AeroSurfaceControl;
}

export interface ThrustPoint {
  id: string;
  maxThrustN: number;
  localOffset: Vec3;
  localForward: Vec3;
}

export interface AircraftModel {
  // --- builder summary scalars and compatibility ratings ---
  massKg: number;
  wingAreaM2: number;
  maxThrustN: number;
  // Handling ratings derived from control area and lever arms. They are displayed/reported but the
  // v0.7 surface-force physics below reads aeroSurfaces instead of treating rates as torque motors.
  maxPitchRate: number;
  maxRollRate: number;
  maxYawRate: number;
  stallAoARad: number;
  // --- v0.7 surface-force rigid body: derived from airframe geometry by compileAirframe ---
  inertia: Inertia; // resists angular acceleration; from part masses + layout (box self + parallel axis)
  com: Vec3; // centre of mass, body frame (m); the point moment arms + inertia are measured from
  aeroCenterZ: number; // area-weighted longitudinal centre of the lifting surfaces (m, body Z)
  staticMarginM: number; // aeroCenterZ − com.z; > 0 = CoM ahead of AC = statically stable
  aspectRatio: number; // span²/area of the lifting surfaces; drives induced drag
  aeroSurfaces: AeroSurface[];
  thrustPoints: ThrustPoint[];
  controlAuthority: Record<ControlAxis, number>;
  parasiteDragAreaM2: number;
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
  // Rigid-body state: body-frame angular velocity (rad/s; x=roll, y=pitch, z=yaw) carried
  // between frames — the momentum the kinematic puppet never had — and remaining fuel mass (kg).
  angularVelocity: Vec3;
  fuelKg: number;
  devices?: SensorDevice[]; // v0.4.0: mounted sensors (camera, …). Static config, not per-frame state.
  // v0.5.0: the source airframe this aircraft was compiled from (model + devices above are its output).
  // Config-time metadata, NOT copied into AircraftSnapshot — runMatch records it onto the replay so the
  // viewer can render the plane that was built.
  airframe?: Airframe;
  // Populated by the physics step, then copied into AircraftSnapshot. This is per-frame measured
  // surface state; when absent, snapshots still expose command-derived deflections.
  surfaceControls?: SurfaceControlSnapshot[];
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

export function surfaceHingeDeflectionRad(surface: AeroSurface, controls: ControlInput): number {
  if (!surface.control) return 0;
  return controls[surface.control.axis] * surface.control.sign * surface.control.maxDeflectionRad;
}

export function surfaceEffectiveDeflectionRad(surface: AeroSurface, controls: ControlInput): number {
  if (!surface.control) return 0;
  return surfaceHingeDeflectionRad(surface, controls) * surface.control.effectiveness;
}

export interface SurfaceAerodynamicState {
  localAoADeg: number;
  totalAoADeg: number;
  stallSeverity: number;
  loadN: number;
}

export function surfaceControlSnapshot(
  surface: AeroSurface,
  aircraft: AircraftState,
  measured?: Partial<SurfaceAerodynamicState>,
): SurfaceControlSnapshot | null {
  if (!surface.control) return null;

  const control = surface.control;
  return {
    id: surface.id,
    axis: control.axis,
    input: aircraft.controls[control.axis],
    deflectionDeg: surfaceHingeDeflectionRad(surface, aircraft.controls) * (180 / Math.PI),
    effectiveAoADeg: surfaceEffectiveDeflectionRad(surface, aircraft.controls) * (180 / Math.PI),
    ...(measured ?? {}),
  };
}

export function surfaceControlSnapshots(aircraft: AircraftState): SurfaceControlSnapshot[] {
  const measuredById = new Map((aircraft.surfaceControls ?? []).map((surface) => [surface.id, surface]));
  return aircraft.model.aeroSurfaces
    .filter((surface) => surface.control)
    .map((surface) => surfaceControlSnapshot(surface, aircraft, measuredById.get(surface.id))!);
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
    surfaceControls: surfaceControlSnapshots(aircraft),
  };
}
