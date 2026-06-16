import type {
  Airframe,
  AircraftSnapshot,
  ControlInput,
  PropCurvePoint,
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

export interface Mat3 {
  xx: number;
  xy: number;
  xz: number;
  yx: number;
  yy: number;
  yz: number;
  zx: number;
  zy: number;
  zz: number;
}

export interface MassElement {
  id: string;
  massKg: number;
  localOffset: Vec3;
  localInertia: Mat3; // inertia about this element's centroid, expressed in body axes
}

export interface FuelTankMass {
  id: string;
  capacityKg: number;
  localOffset: Vec3;
  localInertiaFull: Mat3; // fuel inertia about the tank centroid at full capacity, body axes
}

export interface MassProperties {
  massKg: number;
  com: Vec3;
  inertiaTensor: Mat3; // about current CoM, expressed in body axes (+X right, +Y up, +Z aft)
  inertia: Inertia; // compatibility summary: roll=Izz, pitch=Ixx, yaw=Iyy
}

export type ControlAxis = "pitch" | "roll" | "yaw";

export interface AeroSurfaceControl {
  axis: ControlAxis;
  sign: number;
  maxDeflectionRad: number;
  effectiveness: number;
}

export interface VariableSweep {
  minSweepDeg: number;
  maxSweepDeg: number;
  machForward: number;
  machSwept: number;
  affectedAreaFraction?: number;
}

export interface MachAeroProfile {
  dragRiseMach: number;
  waveDragCd: number;
  supersonicWaveDragCd: number;
  parasiteAreaScale?: number;
  maxMach?: number;
  qLimitPa?: number;
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
  sweep?: VariableSweep;
}

export interface ThrustPoint {
  id: string;
  maxThrustN: number;
  localOffset: Vec3;
  localForward: Vec3;
}

export interface JetPropulsionPoint {
  id: string;
  engineId: string;
  dryThrustN: number;
  afterburnerThrustN: number;
  idleThrustFraction: number;
  afterburnerThrottle: number;
  localOffset: Vec3;
  localForward: Vec3;
}

export interface PropulsionPoint {
  id: string;
  engineId: string;
  propId: string;
  maxPowerW: number;
  criticalAltitudeM: number;
  idleRpm: number;
  maxRpm: number;
  diameterM: number;
  pitchM: number;
  bladeCount: number;
  mode: "fixed-pitch" | "constant-speed";
  curve: PropCurvePoint[];
  localOffset: Vec3;
  localForward: Vec3;
}

export interface WeaponStation {
  id: string;
  kind: "gun" | "rocket" | "missile" | "bomb";
  guidance: "none" | "heat-seeking";
  count: number;
  caliberMm: number;
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
  inertiaTensor: Mat3; // full wet inertia tensor about com; old inertia is the diagonal summary
  com: Vec3; // centre of mass, body frame (m); the point moment arms + inertia are measured from
  aeroCenterZ: number; // area-weighted longitudinal centre of the lifting surfaces (m, body Z)
  staticMarginM: number; // aeroCenterZ − com.z; > 0 = CoM ahead of AC = statically stable
  aspectRatio: number; // span²/area of the lifting surfaces; drives induced drag
  fixedMassElements: MassElement[];
  fuelTanks: FuelTankMass[];
  wetMassProperties: MassProperties;
  dryMassProperties: MassProperties;
  aeroSurfaces: AeroSurface[];
  thrustPoints: ThrustPoint[];
  jetPropulsions: JetPropulsionPoint[];
  propulsions: PropulsionPoint[];
  weaponStations: WeaponStation[];
  variableSweep?: VariableSweep;
  machAero?: MachAeroProfile;
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
  fuelByTankKg?: Record<string, number>;
  massProperties?: MassProperties;
  engineSpool?: number; // jet throttle response state, 0..1; prop aircraft ignore it
  devices?: SensorDevice[]; // v0.4.0: mounted sensors (camera, …). Static config, not per-frame state.
  // v0.5.0: the source airframe this aircraft was compiled from (model + devices above are its output).
  // Config-time metadata, NOT copied into AircraftSnapshot — runMatch records it onto the replay so the
  // viewer can render the plane that was built.
  airframe?: Airframe;
  // Populated by the physics step, then copied into AircraftSnapshot. This is per-frame measured
  // surface state; when absent, snapshots still expose command-derived deflections.
  surfaceControls?: SurfaceControlSnapshot[];
  // v0.8.x balloon target: a STATIC contact (a tethered balloon). When set, the physics step skips
  // flight integration entirely (it hovers in place — no fall/stall/move), but it still lives in the
  // world `aircraft` list so perception, the Pilot's Observation, and resolveWeapons treat it as a
  // normal contact with health. Config-time metadata; copied into AircraftSnapshot so the replay
  // renderer can draw it as a sphere instead of an airframe.
  static?: boolean;
  // Perceived size override (m). When set, perception uses this instead of AIRFRAME_RADIUS_M so a fat
  // balloon shows as a big glyph from far away and is acquirable by a weak shooter. Static config.
  perceivedRadiusM?: number;
  // v0.9.x firing edge: the trigger level on the previous step. The gun discharges on a rising edge
  // (false→true) gated by cooldown, so a held trigger fires one round per cooldown rather than auto-
  // repeating every frame. Runtime-only; not copied into AircraftSnapshot. Absent ⇒ treated as false.
  prevTrigger?: boolean;
  // Runtime ammo buckets keyed by WeaponStation.id. Absent means "not initialized yet"; the first
  // missile shot seeds from the station's configured count. Guns remain unlimited for now.
  weaponAmmo?: Record<string, number>;
}

export interface FlightMetrics {
  airspeed: number;
  altitude: number;
  aoaDeg: number;
  gLoad: number;
  stalled: boolean;
  mach?: number;
  dynamicPressurePa?: number;
  sweepDeg?: number;
  afterburner?: boolean;
  engineSpool?: number;
}

// v0.9.x simulated projectile (a bullet in flight). Spawned at the muzzle on a fired shot, integrated
// pos += vel*dt every physics step, swept against enemy targets for a hit, and despawned on hit /
// lifetime / max-range. Runtime-only state carried across steps by the match loop (NOT part of the
// serialized AircraftState); a per-frame ProjectileSnapshot is what lands on the replay.
export interface Projectile {
  id: string;
  kind: "bullet" | "missile";
  guidance?: "none" | "heat-seeking";
  missileModel?: "aim-9m";
  lockState?: "none" | "acquired" | "lost";
  position: Vec3;
  velocity: Vec3;
  ownerId: string;
  team: Team;
  spawnTime: number;
  distanceTravelledM: number;
  targetId?: string;
  seekerAngleRad?: number;
  targetHeat?: number;
  lockSignal?: number;
}

export interface StepResult {
  aircraft: AircraftState[];
  events: ReplayEvent[];
  // Live projectiles after this step (post-integration, post-despawn). The match loop threads the
  // previous step's surviving rounds back in as input and records these onto the frame.
  projectiles: Projectile[];
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
    ...(aircraft.metrics.mach !== undefined ? { mach: aircraft.metrics.mach } : {}),
    ...(aircraft.metrics.dynamicPressurePa !== undefined
      ? { dynamicPressurePa: aircraft.metrics.dynamicPressurePa }
      : {}),
    ...(aircraft.metrics.sweepDeg !== undefined ? { sweepDeg: aircraft.metrics.sweepDeg } : {}),
    ...(aircraft.metrics.afterburner !== undefined ? { afterburner: aircraft.metrics.afterburner } : {}),
    ...(aircraft.metrics.engineSpool !== undefined ? { engineSpool: aircraft.metrics.engineSpool } : {}),
    health: aircraft.health,
    weaponCooldown: aircraft.weaponCooldown,
    stalled: aircraft.metrics.stalled,
    surfaceControls: surfaceControlSnapshots(aircraft),
    ...(aircraft.static ? { static: true } : {}),
  };
}
