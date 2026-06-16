import type {
  Airframe,
  AircraftSnapshot,
  MatchReplay,
  Quaternion,
  ReplayEvent,
  SurfaceControlSnapshot,
  Vec3,
} from "../protocol/schema";
import { defaultAirframe } from "../sim/airframe";
import { basisFromQuat, add, clamp, length, normalize, scale, sub, vec3, WORLD_UP } from "../sim/math";
import { mountedSensorPose, selectCameraDevice } from "../sim/mountedSensor";
import { sampleReplayFrame } from "../viewer/replaySample";
import { deriveSurfaceControls } from "../viewer/surfaceTelemetry";

export type NativeCameraMode = "cinematic" | "chase" | "cockpit" | "orbit" | "pilot-hero";

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
  fps: number;
  width: number;
  height: number;
  durationSeconds: number;
  airframes: Record<string, Airframe>;
  avatar?: NativeRenderAvatar;
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
  camera: NativeRenderCamera;
  pilotDynamics?: NativePilotDynamics;
  aircraft: NativeRenderAircraft[];
  events: ReplayEvent[];
}

export interface NativePilotDynamics {
  pilotId: string;
  gLoad: number;
  strain: number;
  rootPitchDeg: number;
  rootRollDeg: number;
  headPitchDeg: number;
  headRollDeg: number;
  seatSinkM: number;
  cameraShakeLocal: Vec3;
}

export interface NativeRenderCamera {
  mode: NativeCameraMode;
  shot: string;
  eye: Vec3;
  target: Vec3;
  up: Vec3;
  verticalFovDeg: number;
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
  const durationSeconds = positiveFinite(options.seconds ?? defaultDuration(replay), "seconds");
  const frameCount = Math.max(1, Math.round(durationSeconds * fps));
  const airframes = resolveAirframes(replay);
  const frames: NativeRenderFrame[] = [];

  for (let index = 0; index < frameCount; index += 1) {
    const time = index / fps;
    const replayPosition = replayPositionAt(replay, time, options.loop ?? true);
    const sampled = sampleReplayFrame(replay.frames, replayPosition);
    if (!sampled) throw new Error("cannot build a native render timeline from an empty replay");

    const aircraft = sampled.aircraft.map((ship) => {
      const airframe = airframes[ship.id] ?? fallbackAirframe(ship.id);
      return serializeAircraft(ship, airframe);
    });
    const pilot = aircraft.find((ship) => ship.id === pilotId) ?? aircraft[0];
    const pilotDynamics = pilot ? computePilotDynamics(pilot, time) : undefined;

    frames.push({
      index,
      time,
      replayPosition,
      camera: computeCamera({
        aircraft,
        airframes,
        pilotId,
        pilotDynamics,
        mode: cameraMode,
        width,
        height,
        time,
      }),
      ...(pilotDynamics ? { pilotDynamics } : {}),
      aircraft,
      events: sampled.events,
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
    frames,
  };
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
    stalled: ship.stalled,
    ...(ship.static ? { static: true } : {}),
  };
}

function computeCamera({
  aircraft,
  airframes,
  pilotId,
  pilotDynamics,
  mode,
  width,
  height,
  time,
}: {
  aircraft: NativeRenderAircraft[];
  airframes: Record<string, Airframe>;
  pilotId: string;
  pilotDynamics?: NativePilotDynamics;
  mode: NativeCameraMode;
  width: number;
  height: number;
  time: number;
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
  if (mode === "pilot-hero") return pilotHeroCamera(pilot, pilotDynamics, time);
  if (mode === "chase") return chaseCamera(pilot, "chase");
  if (mode === "orbit") return orbitCamera(aircraft, time);
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

function pilotHeroCamera(
  ship: NativeRenderAircraft,
  dynamics: NativePilotDynamics | undefined,
  time: number,
): NativeRenderCamera {
  const shake = dynamics?.cameraShakeLocal ?? vec3(0, 0, 0);
  const gFocus = dynamics?.strain ?? 0;
  const driftX = Math.sin(time * 1.7) * 0.035;
  return sanitizeCamera({
    mode: "pilot-hero",
    shot: "pilot-hero-canopy",
    eye: localToWorld(ship, vec3(0.38 + driftX + shake.x, 0.74 + shake.y, -6.45 + shake.z)),
    target: localToWorld(ship, vec3(0.01 + shake.x * 0.28, 0.34 - gFocus * 0.1 + shake.y * 0.18, -4.25)),
    up: basisFromQuat(ship.orientation).up,
    verticalFovDeg: 54,
  });
}

function computePilotDynamics(ship: NativeRenderAircraft, time: number): NativePilotDynamics {
  const gExcess = clamp(ship.gLoad - 1, -1.2, 5.5);
  const strain = clamp((ship.gLoad - 1.15) / 4.2, 0, 1);
  const rollInput = clamp(ship.controls.roll, -1, 1);
  const pitchInput = clamp(ship.controls.pitch, -1, 1);
  const yawInput = clamp(ship.controls.yaw, -1, 1);
  const buffet = clamp((Math.abs(ship.aoaDeg) - 8) / 12, 0, 1) + (ship.stalled ? 0.7 : 0);
  const buzz = 0.35 + strain * 1.2 + buffet * 1.4;

  return {
    pilotId: ship.id,
    gLoad: ship.gLoad,
    strain,
    rootPitchDeg: clamp(-gExcess * 3.1 + pitchInput * 3.5, -12, 9),
    rootRollDeg: clamp(-rollInput * 8.5 - yawInput * 2.8, -13, 13),
    headPitchDeg: clamp(-gExcess * 2.2 + pitchInput * 1.5, -9, 5),
    headRollDeg: clamp(-rollInput * 4.2 - yawInput * 1.2, -7, 7),
    seatSinkM: clamp(gExcess * 0.018, -0.012, 0.075),
    cameraShakeLocal: vec3(
      (Math.sin(time * 23.0) * 0.022 + Math.sin(time * 41.0) * 0.008) * buzz,
      (Math.sin(time * 19.0 + 0.4) * 0.016) * buzz - strain * 0.018,
      Math.sin(time * 29.0 + 1.1) * 0.012 * buzz,
    ),
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
