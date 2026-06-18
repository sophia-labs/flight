import { readFileSync } from "node:fs";
import { balloonMetrics, BALLOON_MAX_GUN_RANGE_M } from "../eval/balloonMetrics";
import { basisFromQuat, dot, length, normalize, sub } from "../sim/math";
import type { MatchReplay } from "../protocol/schema";

const TIGHT_COS = Math.cos((8 * Math.PI) / 180); // pipper-precision band: within 8 deg of the nose

// Tight time-on-target (8 deg) + continuous mean aim error (deg), both measured only while the balloon
// is alive and inside gun range — "how cleanly was it actually tracking," which the 24deg gun cone hides.
function tightAndAim(replay: MatchReplay) {
  const times = replay.frames.map((f) => f.time);
  const deltas: number[] = [];
  for (let i = 1; i < times.length; i += 1) if (times[i] - times[i - 1] > 1e-6) deltas.push(times[i] - times[i - 1]);
  deltas.sort((a, b) => a - b);
  const dt = deltas.length ? deltas[Math.floor(deltas.length / 2)] : 0.16;
  let tightFrames = 0, aimSum = 0, aimN = 0, killed = false;
  for (const f of replay.frames) {
    const b = f.aircraft.find((a) => a.id === "blue-1");
    const bal = f.aircraft.find((a) => a.id === "balloon");
    if (!b || !bal) continue;
    if (bal.health <= 0) killed = true;
    if (killed) continue;
    const to = sub(bal.position, b.position);
    if (length(to) > BALLOON_MAX_GUN_RANGE_M) continue;
    const onNose = dot(basisFromQuat(b.orientation).forward, normalize(to));
    aimSum += (Math.acos(Math.max(-1, Math.min(1, onNose))) * 180) / Math.PI;
    aimN += 1;
    if (onNose >= TIGHT_COS) tightFrames += 1;
  }
  return { tightSec: tightFrames * dt, meanAimDeg: aimN ? aimSum / aimN : NaN };
}

const agg: Record<string, any[]> = {};
for (const p of process.argv.slice(2)) {
  const r = JSON.parse(readFileSync(p, "utf8")) as MatchReplay;
  const model = p.split("/").pop()!.replace(/-run\d+\.json$/, "");
  (agg[model] ??= []).push({ ...balloonMetrics(r), ...tightAndAim(r) });
}
const mean = (runs: any[], k: string) => runs.reduce((s, x) => s + x[k], 0) / runs.length;
const rows = Object.entries(agg).map(([model, runs]) => ({
  model,
  n: runs.length,
  kills: runs.filter((x) => x.killed).length,
  aimDeg: mean(runs, "meanAimDeg"),
  tight: mean(runs, "tightSec"),
  gun: mean(runs, "timeOnBalloonBeforeKillSec"),
  lat: mean(runs, "meanLatencyMs") / 1000,
  cost: mean(runs, "costUsd"),
}));
rows.sort((a, b) => a.aimDeg - b.aimDeg); // cleanest tracker (lowest aim error) first
for (const r of rows) {
  console.log(
    `${r.model.padEnd(42)} kills=${r.kills}/${r.n}` +
      ` aimErr=${r.aimDeg.toFixed(1)}deg` +
      ` tight8=${r.tight.toFixed(2)}s` +
      ` gun24=${r.gun.toFixed(2)}s` +
      ` lat=${r.lat.toFixed(2)}s` +
      ` $${r.cost.toFixed(4)}`,
  );
}
