import type {
  AircraftSnapshot,
  ControlInput,
  ReplayEvent,
  ReplayFrame,
  SurfaceControlSnapshot,
  Vec3,
} from "../protocol/schema";

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpVec3(a: Vec3, b: Vec3, t: number): Vec3 {
  return {
    x: lerp(a.x, b.x, t),
    y: lerp(a.y, b.y, t),
    z: lerp(a.z, b.z, t),
  };
}

function lerpMaybe(a: number | undefined, b: number | undefined, t: number): number | undefined {
  if (a === undefined && b === undefined) return undefined;
  if (a === undefined) return b;
  if (b === undefined) return a;
  return lerp(a, b, t);
}

function lerpControl(a: ControlInput, b: ControlInput, t: number): ControlInput {
  return {
    pitch: lerp(a.pitch, b.pitch, t),
    roll: lerp(a.roll, b.roll, t),
    yaw: lerp(a.yaw, b.yaw, t),
    throttle: lerp(a.throttle, b.throttle, t),
    trigger: t < 0.5 ? a.trigger : b.trigger,
  };
}

function slerpQuat(
  a: AircraftSnapshot["orientation"],
  b: AircraftSnapshot["orientation"],
  t: number,
): AircraftSnapshot["orientation"] {
  let bx = b.x;
  let by = b.y;
  let bz = b.z;
  let bw = b.w;
  let cosHalfTheta = a.x * bx + a.y * by + a.z * bz + a.w * bw;

  if (cosHalfTheta < 0) {
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
    cosHalfTheta = -cosHalfTheta;
  }

  if (cosHalfTheta > 0.9995) {
    const x = lerp(a.x, bx, t);
    const y = lerp(a.y, by, t);
    const z = lerp(a.z, bz, t);
    const w = lerp(a.w, bw, t);
    const invLen = 1 / Math.max(Math.hypot(x, y, z, w), 1e-9);
    return { x: x * invLen, y: y * invLen, z: z * invLen, w: w * invLen };
  }

  const halfTheta = Math.acos(cosHalfTheta);
  const sinHalfTheta = Math.sqrt(1 - cosHalfTheta * cosHalfTheta);
  const ratioA = Math.sin((1 - t) * halfTheta) / sinHalfTheta;
  const ratioB = Math.sin(t * halfTheta) / sinHalfTheta;
  return {
    x: a.x * ratioA + bx * ratioB,
    y: a.y * ratioA + by * ratioB,
    z: a.z * ratioA + bz * ratioB,
    w: a.w * ratioA + bw * ratioB,
  };
}

function lerpSurface(
  a: SurfaceControlSnapshot,
  b: SurfaceControlSnapshot | undefined,
  t: number,
): SurfaceControlSnapshot {
  if (!b) return a;
  return {
    id: a.id,
    axis: a.axis,
    input: lerp(a.input, b.input, t),
    deflectionDeg: lerp(a.deflectionDeg, b.deflectionDeg, t),
    effectiveAoADeg: lerp(a.effectiveAoADeg, b.effectiveAoADeg, t),
    ...(lerpMaybe(a.localAoADeg, b.localAoADeg, t) !== undefined
      ? { localAoADeg: lerpMaybe(a.localAoADeg, b.localAoADeg, t) }
      : {}),
    ...(lerpMaybe(a.totalAoADeg, b.totalAoADeg, t) !== undefined
      ? { totalAoADeg: lerpMaybe(a.totalAoADeg, b.totalAoADeg, t) }
      : {}),
    ...(lerpMaybe(a.stallSeverity, b.stallSeverity, t) !== undefined
      ? { stallSeverity: lerpMaybe(a.stallSeverity, b.stallSeverity, t) }
      : {}),
    ...(lerpMaybe(a.loadN, b.loadN, t) !== undefined ? { loadN: lerpMaybe(a.loadN, b.loadN, t) } : {}),
  };
}

function lerpAircraft(a: AircraftSnapshot, b: AircraftSnapshot | undefined, t: number): AircraftSnapshot {
  if (!b) return a;
  const bSurfaces = new Map((b.surfaceControls ?? []).map((surface) => [surface.id, surface]));
  return {
    id: a.id,
    callsign: a.callsign,
    team: a.team,
    color: a.color,
    position: lerpVec3(a.position, b.position, t),
    velocity: lerpVec3(a.velocity, b.velocity, t),
    orientation: slerpQuat(a.orientation, b.orientation, t),
    controls: lerpControl(a.controls, b.controls, t),
    airspeed: lerp(a.airspeed, b.airspeed, t),
    altitude: lerp(a.altitude, b.altitude, t),
    aoaDeg: lerp(a.aoaDeg, b.aoaDeg, t),
    gLoad: lerp(a.gLoad, b.gLoad, t),
    health: lerp(a.health, b.health, t),
    weaponCooldown: lerp(a.weaponCooldown, b.weaponCooldown, t),
    stalled: t < 0.5 ? a.stalled : b.stalled,
    ...(a.surfaceControls
      ? { surfaceControls: a.surfaceControls.map((surface) => lerpSurface(surface, bSurfaces.get(surface.id), t)) }
      : {}),
  };
}

function visibleEvents(a: ReplayEvent[], b: ReplayEvent[], t: number): ReplayEvent[] {
  return t < 0.5 ? a : b;
}

export function sampleReplayFrame(frames: ReplayFrame[], position: number): ReplayFrame | undefined {
  if (frames.length === 0) return undefined;
  const clamped = Math.max(0, Math.min(frames.length - 1, position));
  const i = Math.floor(clamped);
  const j = Math.min(frames.length - 1, i + 1);
  const t = clamp01(clamped - i);
  const fa = frames[i];
  const fb = frames[j];
  const bById = new Map(fb.aircraft.map((ship) => [ship.id, ship]));
  return {
    index: i,
    time: lerp(fa.time, fb.time, t),
    turn: t < 0.5 ? fa.turn : fb.turn,
    aircraft: fa.aircraft.map((ship) => lerpAircraft(ship, bById.get(ship.id), t)),
    events: visibleEvents(fa.events, fb.events, t),
  };
}
