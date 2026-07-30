import type {
  Airframe,
  AircraftSnapshot,
  MatchReplay,
  ProjectileSnapshot,
  Quaternion,
  ReplayEvent,
  ReplayFrame,
  SurfaceControlSnapshot,
  Vec3,
} from "../protocol/schema";
import { defaultAirframe } from "../sim/airframe";
import { basisFromQuat, add, clamp, length, lerp, normalize, scale, sub, vec3, WORLD_UP } from "../sim/math";
import { mountedSensorPose, selectCameraDevice } from "../sim/mountedSensor";
import { sampleReplayFrame } from "../viewer/replaySample";
import { deriveSurfaceControls } from "../viewer/surfaceTelemetry";
import { computeCockpitRig, computePilotForces } from "../viewer/pilotRig";
import { buildPilotPose, type PilotPose } from "../viewer/pilotPose";

import { computePilotCinemaShot } from "../viewer/pilotCinema";
export type NativeCameraMode =
  | "birdseye"
  | "cinematic"
  | "chase"
  | "cockpit"
  | "director"
  | "orbit"
  | "pilot-cinema"
  | "pilot-hero"
  | "split-balloon"
  | "split-dogfight";

export interface NativeRenderTimelineOptions {
  fps?: number;
  seconds?: number;
  width?: number;
  height?: number;
  pilotId?: string;
  cameraMode?: NativeCameraMode;
  avatarPath?: string;
  loop?: boolean;
}

export interface NativeRenderTimeline {
  schemaVersion: 1;
  generator: "flight-native-render";
  units: "meters";
  coordinateSystem: "sim-x-right-y-up-forward-negative-z";
  replayId: string;
  pilotId: string;
  cameraMode: NativeCameraMode;
  layout?: "single" | "split-screen";
  fps: number;
  width: number;
  height: number;
  durationSeconds: number;
  airframes: Record<string, Airframe>;
  avatar?: NativeRenderAvatar;
  subtitles?: NativeRenderSubtitle[];
  frames: NativeRenderFrame[];
}

export interface NativeRenderAvatar {
  pilotId: string;
  source: string;
  rootLocal: Vec3;
  headLocal: Vec3;
  scale: number;
  yawDeg: number;
}

export interface NativeRenderFrame {
  index: number;
  time: number;
  replayPosition: number;
  // Per-frame pilot pose derived from the same computePilotForces + buildPilotPose pipeline the React
  // viewer uses — full per-bone rotations, expression weights, and lookAt, not a lossy summary.
  camera: NativeRenderCamera;
  pilotPose?: NativePilotPose;
  externalCamera?: NativeRenderCamera;
  aircraft: NativeRenderAircraft[];
  events: ReplayEvent[];
  projectiles?: ProjectileSnapshot[];
}

export interface NativeRenderSubtitle {
  start: number;
  end: number;
  label: "FEEL" | "FPS" | "REPLAY" | "THOUGHT";
  text: string;
}

/** Full per-frame pilot pose — the same shape that buildPilotPose in pilotPose.ts produces.
 *  Carries per-bone Euler rotations (radians), expression blend weights (0-1),
 *  and a lookAt offset (normalized screen-space). A Blender importer applies bones
 *  as offset-from-rest quaternions and maps expression names to VRM blend shapes. */
export interface NativePilotPose {
  bones: Record<string, { x: number; y: number; z: number }>;
  expressions: Record<string, number>;
  lookAt: { x: number; y: number };
}

export interface NativeRenderCamera {
  mode: NativeCameraMode;
  shot: string;
  eye: Vec3;
  target: Vec3;
  up: Vec3;
  verticalFovDeg: number;
  focusDistanceM?: number;
  fStop?: number;
}

export interface NativeRenderAircraft {
  id: string;
  callsign: string;
  team: AircraftSnapshot["team"];
  color: string;
  airframeId: string;
  position: Vec3;
  velocity: Vec3;
  orientation: Quaternion;
  controls: AircraftSnapshot["controls"];
  surfaceControls: SurfaceControlSnapshot[];
  health: number;
  airspeed: number;
  altitude: number;
  aoaDeg: number;
  gLoad: number;
  mach?: number;
  dynamicPressurePa?: number;
  sweepDeg?: number;
  afterburner?: boolean;
  engineSpool?: number;
  stalled: boolean;
  static?: boolean;
}

const DEFAULT_FPS = 24;
const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 720;
const DEFAULT_DURATION_SECONDS = 12;
const DEFAULT_VERTICAL_FOV_DEG = 42;
const PI_TO_DEG = 180 / Math.PI;
const DEFAULT_AVATAR_ROOT_LOCAL = vec3(0, -0.34, -4.2);
const DEFAULT_AVATAR_HEAD_LOCAL = vec3(0, 0.78, -4.2);

export function buildNativeRenderTimeline(
  replay: MatchReplay,
  options: NativeRenderTimelineOptions = {},
): NativeRenderTimeline {
  const fps = positiveFinite(options.fps ?? DEFAULT_FPS, "fps");
  const width = positiveInteger(options.width ?? DEFAULT_WIDTH, "width");
  const height = positiveInteger(options.height ?? DEFAULT_HEIGHT, "height");
  const pilotId = options.pilotId ?? "blue-1";
  const cameraMode = options.cameraMode ?? "cinematic";
  const splitScreen = isSplitScreenMode(cameraMode);
  const durationSeconds = positiveFinite(options.seconds ?? defaultDuration(replay), "seconds");
  const frameCount = Math.max(1, Math.round(durationSeconds * fps));
  const airframes = resolveAirframes(replay);
  const duration = frameCount / fps;
  // THOUGHT track (the slow planner's per-turn rationale) is carried in every mode so a render can show
  // subtitles + drive an expression/lipsync puppet; FEEL (the Body's proprioception) stays split-screen.
  const subtitles = [
    ...buildThoughtSubtitles(replay, pilotId, duration),
    ...(splitScreen ? buildFeelSubtitles(replay, pilotId, duration) : []),
  ].sort((a, b) => a.start - b.start);
  const frames: NativeRenderFrame[] = [];

  for (let index = 0; index < frameCount; index += 1) {
    const time = index / fps;
    const replayPosition = replayPositionAt(replay, time, options.loop ?? true);
    const sampled = sampleReplayFrame(replay.frames, replayPosition);
    if (!sampled) throw new Error("cannot build a native render timeline from an empty replay");
    const projectiles = sampleProjectiles(replay.frames, replayPosition);

    const aircraft = sampled.aircraft.map((ship) => {
      const airframe = airframes[ship.id] ?? fallbackAirframe(ship.id);
      return serializeAircraft(ship, airframe);
    });
    const pilot = aircraft.find((ship) => ship.id === pilotId) ?? aircraft[0];
    // Camera shake is Blender-specific; the React viewer handles shake via VRM bone animation.
    const shake = pilot ? computeCameraShake(pilot, time) : undefined;
    // Pilot pose computed by the SAME pipeline the React viewer uses — not a lossy clone.
    const pilotPose: NativePilotPose | undefined = pilot
      ? buildPilotPose({
          elapsed: time,
          forces: computePilotForces(pilot),
          trigger: pilot.controls.trigger,
        })
      : undefined;

    frames.push({
      index,
      time,
      replayPosition,
      camera: splitScreen && pilot
        ? pilotHeroCamera(pilot, shake?.shake ?? vec3(0, 0, 0), shake?.strain ?? 0, time)
        : computeCamera({
            aircraft,
            airframes,
            pilotId,
            cameraShake: shake,
            projectiles,
            mode: cameraMode,
            width,
            height,
            time,
            durationSeconds,
          }),
      ...(splitScreen ? { externalCamera: splitExternalCamera(aircraft, pilotId, time, cameraMode) } : {}),
      ...(pilotPose ? { pilotPose } : {}),
      aircraft,
      events: sampled.events,
      ...(projectiles.length ? { projectiles } : {}),
    });
  }

  return {
    schemaVersion: 1,
    generator: "flight-native-render",
    units: "meters",
    coordinateSystem: "sim-x-right-y-up-forward-negative-z",
    replayId: replay.id,
    pilotId,
    cameraMode,
    ...(splitScreen ? { layout: "split-screen" as const } : {}),
    fps,
    width,
    height,
    durationSeconds: frameCount / fps,
    airframes,
    ...(options.avatarPath
      ? {
          avatar: {
            pilotId,
            source: options.avatarPath,
            rootLocal: DEFAULT_AVATAR_ROOT_LOCAL,
            headLocal: DEFAULT_AVATAR_HEAD_LOCAL,
            scale: 0.78,
            yawDeg: 0,
          },
        }
      : {}),
    ...(subtitles.length ? { subtitles } : {}),
    frames,
  };
}

// The planner's THOUGHTS as a subtitle track — its per-turn rationale, with each line held until the next
// decision. This is what a render shows as captions and can feed to an expression/lipsync VTuber puppet.
function buildThoughtSubtitles(replay: MatchReplay, pilotId: string, durationSeconds: number): NativeRenderSubtitle[] {
  const thoughts = (replay.decisions ?? [])
    .filter((d) => d.agentId === pilotId && typeof d.rationale === "string" && d.rationale.trim().length > 0)
    .map((d) => ({ time: d.observation.time, text: (d.rationale ?? "").trim() }))
    .filter((d) => Number.isFinite(d.time) && d.time >= 0 && d.time < durationSeconds && d.text.length > 0)
    .sort((a, b) => a.time - b.time);
  return thoughts.map((thought, index) => {
    const next = thoughts[index + 1]?.time ?? durationSeconds;
    return {
      start: thought.time,
      end: Math.min(durationSeconds, Math.max(thought.time + 1.2, next)),
      label: "THOUGHT" as const,
      text: thought.text,
    };
  });
}

function buildFeelSubtitles(replay: MatchReplay, pilotId: string, durationSeconds: number): NativeRenderSubtitle[] {
  const ticks = (replay.bodyTicks ?? [])
    .filter((tick) => tick.agentId === pilotId && tick.parsed.feel)
    .map((tick) => ({
      time: tick.time,
      text: tick.parsed.feel?.trim() ?? "",
    }))
    .filter((tick) => Number.isFinite(tick.time) && tick.time >= 0 && tick.time < durationSeconds && tick.text.length > 0)
    .sort((a, b) => a.time - b.time);
  const selected: { time: number; text: string }[] = [];
  let nextAllowed = -Infinity;
  for (const tick of ticks) {
    if (tick.time + 1e-6 < nextAllowed) continue;
    if (selected.at(-1)?.text === tick.text) continue;
    selected.push(tick);
    nextAllowed = tick.time + 0.85;
  }

  return selected.map((tick, index) => {
    const next = selected[index + 1]?.time ?? durationSeconds;
    return {
      start: tick.time,
      end: Math.min(durationSeconds, Math.max(tick.time + 0.75, next)),
      label: "FEEL" as const,
      text: tick.text,
    };
  });
}

function isSplitScreenMode(mode: NativeCameraMode): boolean {
  return mode === "split-balloon" || mode === "split-dogfight";
}

function defaultDuration(replay: MatchReplay): number {
  const replaySeconds = Math.max(replay.frameDt, (replay.frames.length - 1) * replay.frameDt);
  return Math.min(DEFAULT_DURATION_SECONDS, replaySeconds || DEFAULT_DURATION_SECONDS);
}

function replayPositionAt(replay: MatchReplay, time: number, loop: boolean): number {
  const position = time / replay.frameDt;
  const maxIndex = Math.max(0, replay.frames.length - 1);
  if (maxIndex === 0) return 0;
  return loop ? position % maxIndex : Math.min(maxIndex, position);
}

function sampleProjectiles(frames: ReplayFrame[], position: number): ProjectileSnapshot[] {
  if (frames.length === 0) return [];
  const index = Math.max(0, Math.min(frames.length - 1, Math.round(position)));
  return frames[index]?.projectiles ?? [];
}

function resolveAirframes(replay: MatchReplay): Record<string, Airframe> {
  const airframes: Record<string, Airframe> = {};
  for (const ship of replay.frames[0]?.aircraft ?? []) {
    airframes[ship.id] = replay.airframes?.[ship.id] ?? fallbackAirframe(ship.id);
  }
  for (const [id, airframe] of Object.entries(replay.airframes ?? {})) {
    airframes[id] = airframe;
  }
  return airframes;
}

function fallbackAirframe(id: string): Airframe {
  return { ...defaultAirframe(), id: `${id}-default-airframe` };
}

function serializeAircraft(ship: AircraftSnapshot, airframe: Airframe): NativeRenderAircraft {
  return {
    id: ship.id,
    callsign: ship.callsign,
    team: ship.team,
    color: ship.color,
    airframeId: airframe.id,
    position: ship.position,
    velocity: ship.velocity,
    orientation: ship.orientation,
    controls: ship.controls,
    surfaceControls: ship.surfaceControls ?? deriveSurfaceControls(airframe.parts, ship.controls),
    health: ship.health,
    airspeed: ship.airspeed,
    altitude: ship.altitude,
    aoaDeg: ship.aoaDeg,
    gLoad: ship.gLoad,
    ...(ship.mach !== undefined ? { mach: ship.mach } : {}),
    ...(ship.dynamicPressurePa !== undefined ? { dynamicPressurePa: ship.dynamicPressurePa } : {}),
    ...(ship.sweepDeg !== undefined ? { sweepDeg: ship.sweepDeg } : {}),
    ...(ship.afterburner !== undefined ? { afterburner: ship.afterburner } : {}),
    ...(ship.engineSpool !== undefined ? { engineSpool: ship.engineSpool } : {}),
    stalled: ship.stalled,
    ...(ship.static ? { static: true } : {}),
  };
}

function computeCamera({
  aircraft,
  airframes,
  pilotId,
  cameraShake,
  projectiles,
  mode,
  width,
  height,
  time,
  durationSeconds,
}: {
  aircraft: NativeRenderAircraft[];
  airframes: Record<string, Airframe>;
  pilotId: string;
  cameraShake: { shake: Vec3; strain: number } | undefined;
  projectiles: ProjectileSnapshot[];
  mode: NativeCameraMode;
  width: number;
  height: number;
  time: number;
  durationSeconds: number;
}): NativeRenderCamera {
  const pilot = aircraft.find((ship) => ship.id === pilotId) ?? aircraft[0];
  if (!pilot) {
    return sanitizeCamera({
      mode,
      shot: "empty-world",
      eye: vec3(0, 20, 40),
      target: vec3(0, 0, 0),
      up: WORLD_UP,
      verticalFovDeg: DEFAULT_VERTICAL_FOV_DEG,
    });
  }

  if (mode === "cockpit") return cockpitCamera(pilot, airframes[pilot.id], width / height);
  if (mode === "birdseye") return birdseyeCamera(pilot, airframes[pilot.id]);
  if (mode === "pilot-cinema") return pilotCinemaCamera(pilot, airframes[pilot.id], time);
  if (mode === "pilot-hero") return pilotHeroCamera(pilot, cameraShake?.shake ?? vec3(0, 0, 0), cameraShake?.strain ?? 0, time);
  if (isSplitScreenMode(mode)) return pilotHeroCamera(pilot, cameraShake?.shake ?? vec3(0, 0, 0), cameraShake?.strain ?? 0, time);
  if (mode === "chase") return chaseCamera(pilot, "chase");
  if (mode === "orbit") return orbitCamera(aircraft, time);
  if (mode === "director") {
    return directorCamera(pilot, aircraft, airframes[pilot.id], width / height, time, durationSeconds, projectiles);
  }
  return cinematicCamera(pilot, aircraft, airframes[pilot.id], width / height, time);
}

function localToWorld(ship: NativeRenderAircraft, local: Vec3): Vec3 {
  const basis = basisFromQuat(ship.orientation);
  return add(ship.position, add(add(scale(basis.right, local.x), scale(basis.up, local.y)), scale(basis.forward, -local.z)));
}

function cockpitCamera(ship: NativeRenderAircraft, airframe: Airframe | undefined, aspect: number): NativeRenderCamera {
  const device = selectCameraDevice(airframe?.parts, "cockpit-cam");
  const pose = mountedSensorPose(
    device,
    { position: ship.position, orientation: ship.orientation },
    { aspectOverride: aspect },
  );
  return sanitizeCamera({
    mode: "cockpit",
    shot: device.id,
    eye: pose.eye,
    target: add(pose.eye, scale(pose.boresight, 100)),
    up: pose.basis.up,
    verticalFovDeg: pose.vFovRad * PI_TO_DEG,
  });
}

/** Cockpit interior camera using the same 6-shot sequence the React viewer cycles through.
 *  computePilotCinemaShot calls computeCockpitRig internally to place cameras relative to the
 *  actual crew station — canopy frame, stick/throttle/pedal positions, instrument panel. */
function pilotCinemaCamera(
  ship: NativeRenderAircraft,
  airframe: Airframe | undefined,
  time: number,
): NativeRenderCamera {
  const shot = computePilotCinemaShot({
    controls: ship.controls,
    parts: airframe?.parts,
    time,
  });
  return sanitizeCamera({
    mode: "pilot-cinema",
    shot: shot.key,
    eye: localToWorld(ship, { x: shot.eye.x, y: shot.eye.y, z: shot.eye.z }),
    target: localToWorld(ship, { x: shot.target.x, y: shot.target.y, z: shot.target.z }),
    up: basisFromQuat(ship.orientation).up,
    verticalFovDeg: shot.fov,
    focusDistanceM: 1.8,
    fStop: 3.5,
  });
}

function chaseCamera(ship: NativeRenderAircraft, shot: string): NativeRenderCamera {
  const basis = basisFromQuat(ship.orientation);
  const eye = add(add(ship.position, scale(basis.forward, -38)), add(scale(basis.up, 10), scale(basis.right, 8)));
  const target = add(ship.position, add(scale(basis.forward, 28), scale(basis.up, 2.8)));
  return sanitizeCamera({
    mode: "chase",
    shot,
    eye,
    target,
    up: basis.up,
    verticalFovDeg: 38,
  });
}

function birdseyeCamera(ship: NativeRenderAircraft, airframe: Airframe | undefined): NativeRenderCamera {
  const basis = basisFromQuat(ship.orientation);
  const velocityHeading = normalize(vec3(ship.velocity.x, 0, ship.velocity.z), vec3(0, 0, -1));
  const heading = normalize(vec3(basis.forward.x, 0, basis.forward.z), velocityHeading);
  const height = birdseyeCameraHeight(airframe);
  return sanitizeCamera({
    mode: "birdseye",
    shot: "birdseye-ownship-follow",
    eye: add(ship.position, scale(WORLD_UP, height)),
    target: ship.position,
    // Keep the aircraft nose generally "up" in frame while the camera stays vertically overhead.
    up: heading,
    verticalFovDeg: 34,
    focusDistanceM: height,
    fStop: 9,
  });
}

function birdseyeCameraHeight(airframe: Airframe | undefined): number {
  const footprint = Math.max(airframeFootprintM(airframe), 12);
  return clamp(footprint * 5.4, 72, 170);
}

function airframeFootprintM(airframe: Airframe | undefined): number {
  let footprint = 0;
  for (const part of airframe?.parts ?? []) {
    const p = part as any;
    if (p.kind === "fuselage" || p.kind === "canopy" || p.kind === "weapon" || p.kind === "tank") {
      footprint = Math.max(footprint, positiveDimension(p.dims?.length), positiveDimension(p.dims?.width));
    } else if (p.kind === "wing") {
      footprint = Math.max(footprint, positiveDimension(p.planform?.span), positiveDimension(p.planform?.chord));
    } else if (p.kind === "engine") {
      footprint = Math.max(footprint, positiveDimension(p.dims?.length), positiveDimension(p.dims?.radius) * 2);
    } else if (p.kind === "prop") {
      footprint = Math.max(footprint, positiveDimension(p.radius) * 2);
    } else if (p.kind === "gear") {
      footprint = Math.max(footprint, positiveDimension(p.trackM), positiveDimension(p.heightM));
    }
  }
  return footprint;
}

function positiveDimension(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function pilotHeroCamera(
  ship: NativeRenderAircraft,
  shake: Vec3,
  strain: number,
  time: number,
): NativeRenderCamera {
  const driftX = Math.sin(time * 1.7) * 0.035;
  return sanitizeCamera({
    mode: "pilot-hero",
    shot: "pilot-hero-canopy",
    eye: localToWorld(ship, vec3(0.62 + driftX + shake.x, 1.24 + shake.y, -5.22 + shake.z)),
    target: localToWorld(ship, vec3(0.05 + shake.x * 0.2, 0.16 - strain * 0.06 + shake.y * 0.14, -4.35)),
    up: basisFromQuat(ship.orientation).up,
    verticalFovDeg: 46,
    focusDistanceM: 2.4,
    fStop: 4,
  });
}

/** Camera-shake and strain for pilot-hero / director camera positioning.
 *  This is a Blender-specific effect — the React viewer does not shake the camera;
 *  VRM bone animation handles cockpit shake there. */
function computeCameraShake(ship: NativeRenderAircraft, time: number): { shake: Vec3; strain: number } {
  const gExcess = clamp(ship.gLoad - 1, -1.2, 5.5);
  const strain = clamp((ship.gLoad - 1.15) / 4.2, 0, 1);
  const buffet = clamp((Math.abs(ship.aoaDeg) - 8) / 12, 0, 1) + (ship.stalled ? 0.7 : 0);
  const buzz = 0.35 + strain * 1.2 + buffet * 1.4;
  return {
    shake: vec3(
      (Math.sin(time * 23.0) * 0.022 + Math.sin(time * 41.0) * 0.008) * buzz,
      (Math.sin(time * 19.0 + 0.4) * 0.016) * buzz - strain * 0.018,
      Math.sin(time * 29.0 + 1.1) * 0.012 * buzz,
    ),
    strain,
  };
}

function orbitCamera(aircraft: NativeRenderAircraft[], time: number): NativeRenderCamera {
  const center = averagePosition(aircraft);
  const radius = 62;
  const angle = time * 0.18;
  const eye = add(center, vec3(Math.cos(angle) * radius, 52 + Math.sin(time * 0.23) * 10, Math.sin(angle) * radius));
  return sanitizeCamera({
    mode: "orbit",
    shot: "world-orbit",
    eye,
    target: center,
    up: WORLD_UP,
    verticalFovDeg: 36,
  });
}

function splitExternalCamera(
  aircraft: NativeRenderAircraft[],
  pilotId: string,
  time: number,
  mode: NativeCameraMode,
): NativeRenderCamera {
  const pilot = aircraft.find((ship) => ship.id === pilotId) ?? aircraft[0];
  if (!pilot) {
    return sanitizeCamera({
      mode: "orbit",
      shot: mode === "split-dogfight" ? "split-dogfight-empty" : "split-balloon-empty",
      eye: vec3(0, 80, 160),
      target: vec3(0, 0, 0),
      up: WORLD_UP,
      verticalFovDeg: 36,
    });
  }

  const targetShip = splitTargetAircraft(aircraft, pilot, mode);
  const basis = basisFromQuat(pilot.orientation);
  const aim = targetShip ? normalize(sub(targetShip.position, pilot.position), basis.forward) : basis.forward;
  const flatAim = normalize(vec3(aim.x, 0, aim.z), vec3(basis.forward.x, 0, basis.forward.z));
  const lateral = normalize(vec3(-flatAim.z, 0, flatAim.x), basis.right);
  const range = targetShip ? length(sub(targetShip.position, pilot.position)) : 900;
  const side = 76 + Math.sin(time * 0.32) * 18;
  const back = clamp(112 + range * 0.012, 120, 165);
  const height = 38 + Math.sin(time * 0.27) * 10;
  const lookAhead = mode === "split-dogfight" ? clamp(range * 0.55, 80, 460) : clamp(range * 0.16, 220, 430);

  return sanitizeCamera({
    mode: "orbit",
    shot: mode === "split-dogfight" ? "split-dogfight-orbit" : "split-balloon-orbit",
    eye: add(pilot.position, add(scale(aim, -back), add(scale(lateral, side), scale(WORLD_UP, height)))),
    target: add(pilot.position, add(scale(aim, lookAhead), scale(WORLD_UP, 8))),
    up: WORLD_UP,
    verticalFovDeg: 49,
  });
}

function splitTargetAircraft(
  aircraft: NativeRenderAircraft[],
  pilot: NativeRenderAircraft,
  mode: NativeCameraMode,
): NativeRenderAircraft | undefined {
  const others = aircraft.filter((ship) => ship.id !== pilot.id);
  if (mode === "split-balloon") {
    return (
      nearestAircraft(pilot, others.filter((ship) => ship.static)) ??
      nearestAircraft(pilot, others.filter((ship) => ship.team !== pilot.team)) ??
      nearestAircraft(pilot, others)
    );
  }
  return (
    nearestAircraft(pilot, others.filter((ship) => ship.team !== pilot.team && !ship.static)) ??
    nearestAircraft(pilot, others.filter((ship) => ship.team !== pilot.team)) ??
    nearestAircraft(pilot, others.filter((ship) => !ship.static)) ??
    nearestAircraft(pilot, others)
  );
}

function nearestAircraft(
  origin: NativeRenderAircraft,
  candidates: NativeRenderAircraft[],
): NativeRenderAircraft | undefined {
  let nearest: NativeRenderAircraft | undefined;
  let nearestDistance = Infinity;
  for (const ship of candidates) {
    const distance = length(sub(ship.position, origin.position));
    if (distance < nearestDistance) {
      nearest = ship;
      nearestDistance = distance;
    }
  }
  return nearest;
}

function cinematicCamera(
  pilot: NativeRenderAircraft,
  aircraft: NativeRenderAircraft[],
  airframe: Airframe | undefined,
  aspect: number,
  time: number,
): NativeRenderCamera {
  const basis = basisFromQuat(pilot.orientation);
  const shotIndex = Math.floor((time % 24) / 4);
  const phase = (time % 4) / 4;
  const breathe = Math.sin(phase * Math.PI * 2);

  if (shotIndex === 0) {
    const eye = add(pilot.position, add(scale(basis.forward, 42), add(scale(basis.right, 12 + breathe * 3), scale(basis.up, 8))));
    return sanitizeCamera({
      mode: "cinematic",
      shot: "lead-pass",
      eye,
      target: add(pilot.position, add(scale(basis.forward, 6), scale(basis.up, 3))),
      up: WORLD_UP,
      verticalFovDeg: 30,
    });
  }

  if (shotIndex === 1) {
    return chaseCamera(pilot, "tail-chase");
  }

  if (shotIndex === 2) {
    const eye = add(pilot.position, add(scale(basis.right, 24), add(scale(basis.up, 5 + breathe * 1.5), scale(basis.forward, -8))));
    return sanitizeCamera({
      mode: "cinematic",
      shot: "wing-low",
      eye,
      target: add(pilot.position, add(scale(basis.forward, 16), scale(basis.up, 1.8))),
      up: basis.up,
      verticalFovDeg: 28,
    });
  }

  if (shotIndex === 3) {
    const cockpit = cockpitCamera(pilot, airframe, aspect);
    return sanitizeCamera({
      ...cockpit,
      mode: "cinematic",
      shot: "cockpit-controls",
      target: add(cockpit.target, vec3(0, -8, 0)),
      verticalFovDeg: cockpit.verticalFovDeg,
    });
  }

  if (shotIndex === 4) {
    const center = averagePosition(aircraft);
    const target = add(center, scale(sub(pilot.position, center), 0.35));
    const eye = add(target, add(scale(basis.right, -34), add(scale(basis.forward, -22), scale(basis.up, 16))));
    return sanitizeCamera({
      mode: "cinematic",
      shot: "rival-crossing",
      eye,
      target,
      up: WORLD_UP,
      verticalFovDeg: 40,
    });
  }

  const orbit = orbitCamera(aircraft, time);
  return { ...orbit, mode: "cinematic", shot: "wide-orbit" };
}

function directorCamera(
  pilot: NativeRenderAircraft,
  aircraft: NativeRenderAircraft[],
  airframe: Airframe | undefined,
  aspect: number,
  time: number,
  durationSeconds: number,
  projectiles: ProjectileSnapshot[],
): NativeRenderCamera {
  const launchTime = 10.7;
  const impactTime = 16.5;

  if (time < 2.4) {
    return directorOpeningJetCamera(pilot, segmentT(time, 0, 2.4), time);
  }

  if (time < 4.4) {
    return directorLeadPassCamera(pilot, segmentT(time, 2.4, 4.4));
  }

  if (time < 5.8) {
    const cs = computeCameraShake(pilot, time);
    const hero = pilotHeroCamera(pilot, cs.shake, cs.strain, time);
    return sanitizeCamera({
      ...hero,
      mode: "director",
      shot: "director-pilot-pressure-insert",
      verticalFovDeg: 41,
      focusDistanceM: 1.7,
      fStop: 3.2,
    });
  }
  if (time < impactTime - 0.75) {
    const missile = projectiles.find((projectile) => projectile.kind === "missile" && projectile.team === pilot.team);
    if (missile) {
      return directorMissileChaseCamera(pilot, aircraft, missile, segmentT(time, launchTime + 1.45, impactTime - 0.75), time);
    }
    return {
      ...splitExternalCamera(aircraft, pilot.id, time, "split-balloon"),
      mode: "director",
      shot: "director-hunt-wide",
      verticalFovDeg: 34,
      focusDistanceM: 220,
      fStop: 7.5,
    };
  }

  if (time < impactTime + 1) {
    return directorTerminalCamera(pilot, aircraft, segmentT(time, impactTime - 0.75, impactTime + 1), time);
  }

  return directorAftermathCamera(pilot, aircraft, segmentT(time, impactTime + 1, durationSeconds), time);
}

function directorOpeningJetCamera(pilot: NativeRenderAircraft, t: number, time: number): NativeRenderCamera {
  const basis = basisFromQuat(pilot.orientation);
  const slash = easeInOut(t);
  const eye = add(
    pilot.position,
    add(
      scale(basis.forward, lerp(-46, -38, slash)),
      add(scale(basis.right, lerp(-22, 10, slash)), scale(WORLD_UP, lerp(12, 9, slash) + Math.sin(time * 2.2) * 0.9)),
    ),
  );
  const target = add(pilot.position, add(scale(basis.forward, lerp(8, 14, slash)), scale(basis.up, 1.9)));
  return sanitizeCamera({
    mode: "director",
    shot: "director-jet-immediate",
    eye,
    target,
    up: WORLD_UP,
    verticalFovDeg: lerp(37, 34, slash),
    focusDistanceM: length(sub(target, eye)),
    fStop: 5.6,
  });
}

function directorLeadPassCamera(pilot: NativeRenderAircraft, t: number): NativeRenderCamera {
  const basis = basisFromQuat(pilot.orientation);
  const dolly = easeInOut(t);
  const eye = add(
    pilot.position,
    add(
      scale(basis.forward, lerp(86, 24, dolly)),
      add(scale(basis.right, lerp(-46, 34, dolly)), scale(WORLD_UP, lerp(17, 8, dolly) + Math.sin(t * Math.PI) * 5)),
    ),
  );
  const target = add(pilot.position, add(scale(basis.forward, lerp(5, 36, dolly)), scale(basis.up, 2.4)));
  return sanitizeCamera({
    mode: "director",
    shot: "director-lead-pass-dolly",
    eye,
    target,
    up: WORLD_UP,
    verticalFovDeg: lerp(29, 24, dolly),
    focusDistanceM: length(sub(target, eye)),
    fStop: 5.6,
  });
}

function directorWingGlideCamera(pilot: NativeRenderAircraft, t: number, time: number): NativeRenderCamera {
  const basis = basisFromQuat(pilot.orientation);
  const drift = easeInOut(t);
  const skyLift = Math.sin(time * 0.9) * 1.2;
  const eye = add(
    pilot.position,
    add(
      scale(basis.right, lerp(42, -30, drift)),
      add(scale(basis.forward, lerp(-76, -68, drift)), scale(WORLD_UP, lerp(-24, -18, drift) + skyLift)),
    ),
  );
  const target = add(pilot.position, add(scale(basis.forward, lerp(5, 10, drift)), scale(WORLD_UP, 5.5)));
  return sanitizeCamera({
    mode: "director",
    shot: "director-wing-glide",
    eye,
    target,
    up: WORLD_UP,
    verticalFovDeg: lerp(45, 44, drift),
    focusDistanceM: length(sub(target, eye)),
    fStop: 6.3,
  });
}

function directorCockpitLaunchCamera(
  pilot: NativeRenderAircraft,
  airframe: Airframe | undefined,
  aspect: number,
  t: number,
): NativeRenderCamera {
  void airframe;
  void aspect;

  const basis = basisFromQuat(pilot.orientation);
  const flight = normalize(pilot.velocity, basis.forward);
  const flatFlight = normalize(vec3(flight.x, 0, flight.z), basis.forward);
  const lateral = normalize(vec3(-flatFlight.z, 0, flatFlight.x), basis.right);
  const belly = normalize(add(scale(basis.up, -1), scale(WORLD_UP, -0.25)), scale(WORLD_UP, -1));
  const squeeze = easeInOut(t);
  const railKick = Math.sin(clamp(t, 0, 1) * Math.PI);
  const eye = add(
    pilot.position,
    add(
      scale(flight, lerp(-52, -62, squeeze)),
      add(
        scale(lateral, lerp(-34, 10, squeeze)),
        add(scale(belly, lerp(18, 16, squeeze)), scale(WORLD_UP, lerp(-4, -1, squeeze) - railKick * 2.2)),
      ),
    ),
  );
  const target = add(
    pilot.position,
    add(scale(flight, lerp(10, 14, squeeze)), add(scale(basis.up, -1.5), scale(WORLD_UP, lerp(5, 12, squeeze)))),
  );
  return sanitizeCamera({
    mode: "director",
    shot: "director-rail-launch",
    eye,
    target,
    up: WORLD_UP,
    verticalFovDeg: lerp(31, 38, squeeze),
    focusDistanceM: length(sub(target, eye)),
    fStop: 5.6,
  });
}

function directorMissileChaseCamera(
  pilot: NativeRenderAircraft,
  aircraft: NativeRenderAircraft[],
  missile: ProjectileSnapshot,
  t: number,
  time: number,
): NativeRenderCamera {
  const targetShip = splitTargetAircraft(aircraft, pilot, "split-balloon");
  const missileDir = normalize(missile.velocity, normalize(sub(targetShip?.position ?? pilot.position, missile.position), vec3(0, 0, -1)));
  const flat = normalize(vec3(missileDir.x, 0, missileDir.z), vec3(0, 0, -1));
  const lateral = normalize(vec3(-flat.z, 0, flat.x), basisFromQuat(pilot.orientation).right);
  const chase = easeInOut(t);
  const roll = Math.sin(time * 1.15) * 0.6;
  const sideSweep = Math.sin(chase * Math.PI * 1.15 + 0.2);
  const eye = add(
    missile.position,
    add(
      scale(missileDir, lerp(-140, -92, chase)),
      add(
        scale(lateral, sideSweep * lerp(42, 28, chase)),
        scale(WORLD_UP, lerp(-44, -24, chase) + Math.sin(time * 1.8) * 3.2),
      ),
    ),
  );
  const forwardAim = add(missile.position, add(scale(missileDir, lerp(110, 180, chase)), scale(WORLD_UP, lerp(28, 18, chase))));
  const lookTarget = targetShip ? mixVec3(forwardAim, add(targetShip.position, scale(WORLD_UP, 18)), clamp((chase - 0.58) / 0.42, 0, 1) * 0.72) : forwardAim;
  return sanitizeCamera({
    mode: "director",
    shot: "director-missile-chase",
    eye,
    target: lookTarget,
    up: normalize(add(WORLD_UP, scale(lateral, roll * 0.18)), WORLD_UP),
    verticalFovDeg: lerp(46, 34, chase),
    focusDistanceM: length(sub(lookTarget, eye)),
    fStop: 6.3,
  });
}

function directorTerminalCamera(
  pilot: NativeRenderAircraft,
  aircraft: NativeRenderAircraft[],
  t: number,
  time: number,
): NativeRenderCamera {
  const targetShip = splitTargetAircraft(aircraft, pilot, "split-balloon") ?? pilot;
  const line = normalize(sub(targetShip.position, pilot.position), basisFromQuat(pilot.orientation).forward);
  const lateral = normalize(vec3(-line.z, 0, line.x), basisFromQuat(pilot.orientation).right);
  const beat = easeInOut(t);
  const eye = add(
    targetShip.position,
    add(scale(line, lerp(-180, -72, beat)), add(scale(lateral, lerp(-82, 28, beat)), scale(WORLD_UP, 52 + Math.sin(time * 1.7) * 7))),
  );
  const target = mixVec3(add(targetShip.position, scale(WORLD_UP, 12)), pilot.position, lerp(0.15, 0.46, beat));
  return sanitizeCamera({
    mode: "director",
    shot: "director-terminal-cross",
    eye,
    target,
    up: WORLD_UP,
    verticalFovDeg: lerp(38, 30, beat),
    focusDistanceM: length(sub(target, eye)),
    fStop: 8,
  });
}

function directorAftermathCamera(
  pilot: NativeRenderAircraft,
  aircraft: NativeRenderAircraft[],
  t: number,
  time: number,
): NativeRenderCamera {
  const targetShip = splitTargetAircraft(aircraft, pilot, "split-balloon") ?? pilot;
  const center = mixVec3(pilot.position, targetShip.position, 0.58);
  const angle = time * 0.18 + 1.4;
  const radius = lerp(210, 310, easeInOut(t));
  const eye = add(center, vec3(Math.cos(angle) * radius, 132 + t * 28, Math.sin(angle) * radius));
  return sanitizeCamera({
    mode: "director",
    shot: "director-aftermath-wide",
    eye,
    target: add(center, scale(WORLD_UP, 10)),
    up: WORLD_UP,
    verticalFovDeg: 33,
    focusDistanceM: length(sub(center, eye)),
    fStop: 9,
  });
}

function segmentT(time: number, start: number, end: number): number {
  return clamp((time - start) / Math.max(0.001, end - start), 0, 1);
}

function easeInOut(t: number): number {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}

function mixVec3(a: Vec3, b: Vec3, t: number): Vec3 {
  const x = clamp(t, 0, 1);
  return vec3(lerp(a.x, b.x, x), lerp(a.y, b.y, x), lerp(a.z, b.z, x));
}

function averagePosition(aircraft: NativeRenderAircraft[]): Vec3 {
  if (aircraft.length === 0) return vec3(0, 0, 0);
  const sum = aircraft.reduce((acc, ship) => add(acc, ship.position), vec3(0, 0, 0));
  return scale(sum, 1 / aircraft.length);
}

function sanitizeCamera(camera: NativeRenderCamera): NativeRenderCamera {
  const toTarget = sub(camera.target, camera.eye);
  const up = normalize(camera.up, WORLD_UP);
  if (length(toTarget) < 1e-6) {
    return { ...camera, target: add(camera.eye, vec3(0, 0, -1)), up };
  }
  return { ...camera, up };
}

function positiveFinite(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive finite number`);
  }
  return value;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}
