// Time-on-balloon metric — the first scoring rule of the embodied-Body flight benchmark.
//
// The balloon scenario (FILM_SCENARIO=balloon) flies the embodied Body (blue-1) at a single static red
// balloon. A run is "good" to the degree the Body holds the balloon inside the gun solution it can
// actually score on — so we score the run PER FRAME against the EXACT cone + range resolveWeapons uses
// for a balloon target (src/sim/flight.ts): cone half-angle 0.42 rad, max range 2900 m. A fired shot
// only damages the balloon when angle < coneRad AND range < maxRangeM, so "on-solution" must match that
// gate or the metric would reward shots that can't land.
//
// Everything here is read from the recorded MatchReplay (frames + events + bodyTicks): the metric is a
// pure fold over a replay, so it is deterministic, re-runnable, and never re-flies the sim.

import { basisFromQuat, dot, length, normalize, sub } from "../sim/math";
import type { AircraftSnapshot, MatchReplay } from "../protocol/schema";

const BODY_ID = "blue-1";
const BALLOON_ID = "balloon";

// The balloon weapon envelope, copied from resolveWeapons (src/sim/flight.ts). If those change, change
// these — the metric MUST mirror what a fired shot would actually hit. Cone half-angle in radians; a
// frame is on-solution when the angle from the nose to the balloon is <= this, i.e. onNose >= cos(it).
export const BALLOON_CONE_HALF_ANGLE_RAD = 0.42;
export const BALLOON_MAX_GUN_RANGE_M = 2_900;
const ON_SOLUTION_COS = Math.cos(BALLOON_CONE_HALF_ANGLE_RAD);

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

    const onSolution = onNose >= ON_SOLUTION_COS && range <= BALLOON_MAX_GUN_RANGE_M;
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
