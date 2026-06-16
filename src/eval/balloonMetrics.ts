// Time-on-balloon metric — the first scoring rule of the embodied-Body flight benchmark.
//
// The balloon scenario (FILM_SCENARIO=balloon) flies the embodied Body (blue-1) at a single static red
// balloon. A run is "good" to the degree the Body holds a REAL GUN SOLUTION it can actually score on.
//
// v0.9.x — projectiles replace the hitscan cone, so "on-solution" now means "a bullet fired THIS frame
// would actually intercept the balloon" — i.e. the gun axis (the ray from the muzzle along the nose)
// passes within the balloon's hit radius (its perceivedRadiusM, ~42 m) before the round overranges.
// For the stationary balloon that is the swept closest-approach of the boresight ray to the balloon
// centre <= HIT_RADIUS, which is roughly "within angle atan(HIT_RADIUS/range) of dead-on" — FAR tighter
// than the old 0.42 rad (~24deg) cone at long range. This is the exact geometry resolveWeapons /
// stepProjectiles use (src/sim/flight.ts): a round goes where the muzzle points, not toward the target.
//
// Everything here is read from the recorded MatchReplay (frames + events + bodyTicks): the metric is a
// pure fold over a replay, so it is deterministic, re-runnable, and never re-flies the sim.

import { add, basisFromQuat, clamp, dot, length, normalize, scale, sub } from "../sim/math";
import type { AircraftSnapshot, MatchReplay, Vec3 } from "../protocol/schema";

const BODY_ID = "blue-1";
const BALLOON_ID = "balloon";

// The balloon hit geometry, mirrored from src/sim/flight.ts (MUZZLE_OFFSET_M, the balloon hit radius,
// and the round's max range). If those change, change these — the metric MUST mirror what a fired round
// would actually hit. HIT_RADIUS is the balloon's perceived radius (its capture radius for a round).
export const BALLOON_HIT_RADIUS_M = 42;
export const BALLOON_MAX_GUN_RANGE_M = 2_900;
const MUZZLE_OFFSET_M = 18;
// Retained for the bench/leaderboard header (it reports the on-solution geometry). The on-solution test
// is now the swept ray test below, but this cone is still a useful "how dead-on" reference at the kill
// range and is kept exported so the bench markdown + tests have a stable handle.
export const BALLOON_CONE_HALF_ANGLE_RAD = 0.42;

// Closest approach (squared) of the gun-axis segment muzzle->reach to the balloon centre. Mirrors the
// swept hit test stepProjectiles runs on a live round (sans gravity/shooter-velocity drift — the
// stationary-balloon on-axis aim metric the brief specifies).
function gunAxisClosestSq(muzzle: Vec3, forward: Vec3, reachM: number, c: Vec3): number {
  const p1 = add(muzzle, scale(forward, reachM));
  const seg = sub(p1, muzzle);
  const segLenSq = dot(seg, seg);
  if (segLenSq < 1e-9) {
    const d = sub(c, muzzle);
    return dot(d, d);
  }
  const t = clamp(dot(sub(c, muzzle), seg) / segLenSq, 0, 1);
  const closest = add(muzzle, scale(seg, t));
  const d = sub(c, closest);
  return dot(d, d);
}

// Would a round fired this frame intercept the balloon? The gun axis is the ray from the muzzle (nose,
// MUZZLE_OFFSET_M ahead of the ship) along the body-forward; it must pass within HIT_RADIUS of the
// balloon centre within the round's reach. This is the exact projectile geometry, stationary target.
export function bulletWouldHitBalloon(body: AircraftSnapshot, balloon: AircraftSnapshot): boolean {
  const forward = basisFromQuat(body.orientation).forward;
  const muzzle = add(body.position, scale(forward, MUZZLE_OFFSET_M));
  const reach = BALLOON_MAX_GUN_RANGE_M; // the round despawns past this travelled distance
  const closestSq = gunAxisClosestSq(muzzle, forward, reach, balloon.position);
  // The closest approach must also be AHEAD of the muzzle (a balloon behind the nose is never hit); the
  // segment-clamped t already enforces that, but guard the degenerate "balloon behind" with a range gate.
  const range = length(sub(balloon.position, body.position));
  return closestSq <= BALLOON_HIT_RADIUS_M * BALLOON_HIT_RADIUS_M && range <= BALLOON_MAX_GUN_RANGE_M;
}

export interface BalloonMetrics {
  timeOnBalloonSec: number; // on-solution frame count * frameDt
  killed: boolean; // balloon health reached 0
  timeToKillSec: number | null; // first frame time the balloon hit 0 health (null if never)
  timeToFirstSolutionSec: number | null; // first frame time the Body held a valid gun solution
  timeOnBalloonBeforeKillSec: number; // on-solution time accrued up to the kill (or all of it if no kill)
  peakOnNose: number; // best (max) onNose dot over the run; 1 = dead-on
  closestRangeM: number; // closest the Body ever got to the balloon
  shots: number; // shot events the Body fired at the balloon
  hits: number; // hit events the Body landed on the balloon
  parseRate: number; // ok bodyTicks / total bodyTicks (1 if no ticks recorded)
  meanLatencyMs: number; // mean Body tick latency (0 if unrecorded)
  costUsd: number; // total Body-tick spend on this run
}

function find(frameAircraft: AircraftSnapshot[], id: string): AircraftSnapshot | undefined {
  return frameAircraft.find((a) => a.id === id);
}

// Median spacing of frame timestamps — robust to a stray duplicate/zero timestamp, and falls back to
// the replay's declared frameDt (then a hard 0.16) when frames are too sparse to infer it.
function deriveFrameDt(replay: MatchReplay): number {
  const times = replay.frames.map((f) => f.time);
  const deltas: number[] = [];
  for (let i = 1; i < times.length; i += 1) {
    const d = times[i] - times[i - 1];
    if (d > 1e-6) deltas.push(d);
  }
  if (deltas.length === 0) return replay.frameDt > 0 ? replay.frameDt : 0.16;
  deltas.sort((a, b) => a - b);
  return deltas[Math.floor(deltas.length / 2)];
}

export function balloonMetrics(replay: MatchReplay): BalloonMetrics {
  const frameDt = deriveFrameDt(replay);

  let onSolutionFrames = 0;
  let onSolutionFramesBeforeKill = 0;
  let peakOnNose = -1;
  let closestRangeM = Infinity;
  let timeToFirstSolutionSec: number | null = null;
  let timeToKillSec: number | null = null;
  let killed = false;

  for (const frame of replay.frames) {
    const body = find(frame.aircraft, BODY_ID);
    const balloon = find(frame.aircraft, BALLOON_ID);
    if (!body || !balloon) continue;

    if (!killed && balloon.health <= 0) {
      killed = true;
      timeToKillSec = frame.time;
    }

    const toBalloon = sub(balloon.position, body.position);
    const range = length(toBalloon);
    if (range < closestRangeM) closestRangeM = range;

    const forward = basisFromQuat(body.orientation).forward;
    const dir = normalize(toBalloon);
    const onNose = dot(forward, dir);
    if (onNose > peakOnNose) peakOnNose = onNose;

    // On-solution = a bullet fired this frame would actually intercept the balloon (the swept gun-axis
    // test, the exact projectile geometry) — not the old generous cone.
    const onSolution = bulletWouldHitBalloon(body, balloon);
    if (onSolution) {
      onSolutionFrames += 1;
      if (timeToFirstSolutionSec === null) timeToFirstSolutionSec = frame.time;
      // Accrue toward the "useful" tally only while the balloon is still alive — time spent lined up on
      // an already-dead balloon is not a kill credential.
      if (!killed) onSolutionFramesBeforeKill += 1;
    }
  }

  // Shots/hits on the balloon, read from the recorded events (matches what the gun actually resolved).
  let shots = 0;
  let hits = 0;
  for (const frame of replay.frames) {
    for (const ev of frame.events) {
      if (ev.actorId !== BODY_ID || ev.targetId !== BALLOON_ID) continue;
      if (ev.type === "shot") shots += 1;
      else if (ev.type === "hit") hits += 1;
    }
  }

  // Body health: parse rate, latency, cost — read from the bodyTicks for blue-1.
  const ticks = (replay.bodyTicks ?? []).filter((t) => t.agentId === BODY_ID);
  const okTicks = ticks.filter((t) => t.parsed.status === "ok").length;
  const parseRate = ticks.length > 0 ? okTicks / ticks.length : 1;
  const latencies = ticks.map((t) => t.latencyMs).filter((x): x is number => typeof x === "number");
  const meanLatencyMs =
    latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0;
  const costUsd = ticks.reduce((sum, t) => sum + (t.usage?.costUsd ?? 0), 0);

  return {
    timeOnBalloonSec: onSolutionFrames * frameDt,
    killed,
    timeToKillSec,
    timeToFirstSolutionSec,
    timeOnBalloonBeforeKillSec: onSolutionFramesBeforeKill * frameDt,
    peakOnNose: peakOnNose < -0.5 ? 0 : peakOnNose,
    closestRangeM: Number.isFinite(closestRangeM) ? closestRangeM : Infinity,
    shots,
    hits,
    parseRate,
    meanLatencyMs,
    costUsd,
  };
}
