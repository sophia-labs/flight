// Interview the pilot. Take a no-twitch coach run (reports/coach/<tag>.json + .digest.json), reconstruct
// per-turn GROUND TRUTH the planner never saw (peak G, min altitude, peak AoA, overshoot), and put the
// model back in front of its own flight as a debrief. It is the same model reflecting on the same trace —
// not a continuous mind — but confronted with the physics it was blind to. Its self-report plus the
// physics read is how we "arrive at how to fly the plane better" before touching a prompt.
//
//   COACH_TAG=baseline npm run coach:interview
//   PLANNER_MODEL=deepseek-v4-pro COACH_TAG=baseline npm run coach:interview
import { complete, type TextContent } from "@earendil-works/pi-ai";
import { readFileSync, writeFileSync } from "node:fs";
import { resolveOpenRouterModel } from "../agent/controllers/pi";
import { basisFromQuat, dot, length, normalize, sub } from "../sim/math";
import type { MatchReplay } from "../protocol/schema";

const PILOT_ID = "blue-1";
const BALLOON_ID = "balloon";
const RAD2DEG = 180 / Math.PI;

const plannerModel = process.env.PLANNER_MODEL ?? "deepseek-v4-pro";
const tag = process.env.COACH_TAG ?? "baseline";
const maxTokens = Number(process.env.INTERVIEW_MAX_TOKENS ?? 2_000);

interface TurnTruth {
  turn: number;
  rangeStartM: number;
  rangeEndM: number;
  offNoseStartDeg: number;
  offNoseEndDeg: number;
  peakG: number;
  minAltM: number;
  peakAoADeg: number;
  overshot: boolean; // nose passed behind the balloon during the turn
}

function offNose(forwardDotDir: number): number {
  return Math.acos(Math.max(-1, Math.min(1, forwardDotDir))) * RAD2DEG;
}

function perTurnTruth(replay: MatchReplay): TurnTruth[] {
  const byTurn = new Map<number, TurnTruth>();
  for (const f of replay.frames) {
    if (f.turn < 1) continue;
    const body = f.aircraft.find((a) => a.id === PILOT_ID);
    const balloon = f.aircraft.find((a) => a.id === BALLOON_ID);
    if (!body || !balloon) continue;
    const to = sub(balloon.position, body.position);
    const range = length(to);
    const fwd = basisFromQuat(body.orientation).forward;
    const onNose = dot(fwd, normalize(to));
    const offDeg = offNose(onNose);
    let t = byTurn.get(f.turn);
    if (!t) {
      t = {
        turn: f.turn,
        rangeStartM: range,
        rangeEndM: range,
        offNoseStartDeg: offDeg,
        offNoseEndDeg: offDeg,
        peakG: body.gLoad,
        minAltM: body.altitude,
        peakAoADeg: body.aoaDeg,
        overshot: false,
      };
      byTurn.set(f.turn, t);
    }
    t.rangeEndM = range;
    t.offNoseEndDeg = offDeg;
    t.peakG = Math.max(t.peakG, body.gLoad);
    t.minAltM = Math.min(t.minAltM, body.altitude);
    t.peakAoADeg = Math.max(t.peakAoADeg, body.aoaDeg);
    if (onNose < 0) t.overshot = true; // balloon went behind the nose
  }
  return [...byTurn.values()].sort((a, b) => a.turn - b.turn);
}

function f1(x: number): string {
  return x.toFixed(1);
}

function main(): void {
  const model = resolveOpenRouterModel(plannerModel);
  const replay = JSON.parse(readFileSync(`reports/coach/${tag}.json`, "utf8")) as MatchReplay;
  const digest = JSON.parse(readFileSync(`reports/coach/${tag}.digest.json`, "utf8"));
  const truth = perTurnTruth(replay);
  const records: any[] = digest.records;

  // Salient moments, derived from the flight (so the questions stay specific yet reusable across runs).
  const overshootTurn = truth.find((t) => t.offNoseStartDeg < 30 && t.offNoseEndDeg > 90);
  const peakGTurn = truth.reduce((a, b) => (b.peakG > a.peakG ? b : a), truth[0]);
  const minAltTurn = truth.reduce((a, b) => (b.minAltM < a.minAltM ? b : a), truth[0]);
  const wouldHit: number[] = records.filter((r) => r.wouldHitDuringTurn).map((r) => r.turn);

  const traceLines = records.map((r) => {
    const t = truth.find((x) => x.turn === r.turn);
    const s = r.seen;
    const tape = r.tape
      ? `pitch ${f1(r.tape.pitch.start)}→${f1(r.tape.pitch.end)}, roll ${f1(r.tape.roll.start)}→${f1(
          r.tape.roll.end,
        )}, throttle ${f1(r.tape.throttle.start)}`
      : "(no tape)";
    const real = t
      ? `ACTUAL: range ${t.rangeStartM.toFixed(0)}→${t.rangeEndM.toFixed(0)}m, peakG ${t.peakG.toFixed(
          1,
        )}, minAlt ${t.minAltM.toFixed(0)}m, peakAoA ${t.peakAoADeg.toFixed(0)}°${t.overshot ? ", OVERSHOT (balloon passed behind your nose)" : ""}`
      : "";
    return (
      `Turn ${r.turn}: SAW range=${s.rangeM?.toFixed(0)}m offNose=${s.offNoseDeg?.toFixed(0)}° ` +
      `bearingUp=${s.bearingUp?.toFixed(2)} closure=${s.closureRate?.toFixed(0)}m/s alt=${s.altitude.toFixed(
        0,
      )}m speed=${s.airspeed.toFixed(0)}m/s | COMMANDED ${tape} | ${real} | YOU SAID: "${r.rationale}"`
    );
  });

  const systemPrompt = `You are a fighter pilot debriefing your own flight with a coach who can see the flight physics you could not see in the cockpit. You flew a slow "motor program" planner: each turn you saw a JSON observation and authored a 2.5-second control tape (pitch/roll/yaw/throttle samples). Your task was simple: fly your jet to a STATIONARY red balloon and hold it in your gun pipper. There was no twitch body and you never fired — this debrief is only about whether you FLEW the jet well.

Be ruthlessly concrete and self-critical. Do not be agreeable for its own sake. Use the physics numbers. The floor is 55 m; the wing stalls past ~24° AoA; sustained turns above ~7 G bleed energy fast. Answer in tight prose, not bullet lists of platitudes.`;

  const userPrompt = `Here is your flight, with the ground truth you could not see at the time:

${traceLines.join("\n")}

Summary you could not see: you reached a perfect gun solution early (would-hit on turns ${wouldHit.join(
    ", ",
  )}), peaked at ${peakGTurn.peakG.toFixed(1)} G on turn ${peakGTurn.turn}, and descended to ${minAltTurn.minAltM.toFixed(
    0,
  )} m on turn ${minAltTurn.turn} (floor is 55 m).

Answer these, numbered:

1. You held throttle near 1.00 the whole flight while closing on a STATIONARY target, accelerating past 250 m/s. ${
    overshootTurn
      ? `On turn ${overshootTurn.turn} the balloon passed behind your nose — you overshot.`
      : "You overshot the balloon."
  } At what point should you have recognized the overshoot was coming, and what specifically should the tape have done instead?

2. After overshooting you flew a reversal that hit ${peakGTurn.peakG.toFixed(
    1,
  )} G and dumped your altitude to ${minAltTurn.minAltM.toFixed(
    0,
  )} m — nearly into the ground. What were you trying to do, and what was the flying error?

3. Your early intercept (turns 1–5) used only numeric bearings and was flawless. Did you actually need a visual picture, or were the numbers enough? Be honest about where numbers stop being enough.

4. Name the SINGLE most useful change: either one line to add to your briefing, OR one extra field to add to your observation, that would most have prevented the overshoot-and-dive. One concrete thing, and why.`;

  console.error(`interview: ${plannerModel} debriefing run "${tag}" (${records.length} turns)`);

  complete(
    model,
    {
      systemPrompt,
      messages: [{ role: "user", content: userPrompt, timestamp: 0 }],
    },
    { maxTokens, maxRetries: 4 },
  ).then((response) => {
    const text = response.content
      .filter((b): b is TextContent => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    const out = `# Pilot interview — ${tag} (${plannerModel})\n\n${text}\n`;
    writeFileSync(`reports/coach/${tag}.interview.md`, out);
    console.log("\n" + out);
    console.error(
      `\nwrote reports/coach/${tag}.interview.md  (cost $${response.usage.cost.total.toFixed(4)})`,
    );
  });
}

main();
