// Grounding context for "Talk to pilot" — reconstruct, from a replay alone, the per-turn FLIGHT TRUTH
// the planner could not see in the cockpit (peak G, min altitude, peak AoA, overshoot, range/off-nose
// arc) and pair it with what the Pilot actually SAW and COMMANDED. This is the evidence floor for an
// honest debrief: the model answers only from this reconstruction, never from invented events.
//
// The per-turn truth derivation mirrors the headless coachInterview grounding, deliberately copied here
// (not imported) so the server route never depends on the coach harness. The seen/commanded read is
// recovered from replay.decisions (a server replay has no separate digest file), so this works on any
// recorded MatchReplay, not just a coach run.
import {
  type Action,
  type MatchReplay,
  type MotorProgramAction,
  type TurnDecision,
} from "../protocol/schema";
import { basisFromQuat, dot, length, normalize, sub } from "../sim/math";

const RAD2DEG = 180 / Math.PI;

export interface TurnTruth {
  turn: number;
  rangeStartM: number;
  rangeEndM: number;
  offNoseStartDeg: number;
  offNoseEndDeg: number;
  peakG: number;
  minAltM: number;
  peakAoADeg: number;
  overshot: boolean; // the target passed behind the nose during the turn
}

export interface DebriefGrounding {
  replayId: string;
  pilotId: string;
  pilotLabel: string;
  bodyLabel?: string;
  targetId?: string;
  durationSeconds: number;
  focusTime: number;
  turnTruth: TurnTruth[];
  phaseCounts: { planner: number; body: number; twitch: number };
  // Salient flight moments derived from the truth, so the system prompt stays specific yet reusable.
  peakG?: { turn: number; value: number };
  minAlt?: { turn: number; value: number };
  overshootTurn?: number;
  outcome?: { resolved: boolean; reason: string; survived: boolean };
  hits: number;
  shots: number;
  // The text the model reads: a per-turn trace of SAW / COMMANDED / ACTUAL / "you said".
  traceLines: string[];
  // Last-decision and last-body-tick narrative around the focus time.
  lastDecisionContext?: string;
  lastBodyContext?: string;
}

function offNoseDeg(forwardDotDir: number): number {
  return Math.acos(Math.max(-1, Math.min(1, forwardDotDir))) * RAD2DEG;
}

// Per-turn ground truth, reconstructed from the physics frames. Picks the first non-static OTHER
// aircraft as the target (the balloon, or an opponent) when no explicit targetId is supplied.
export function perTurnTruth(
  replay: MatchReplay,
  pilotId: string,
  targetId?: string,
): { truth: TurnTruth[]; targetId?: string } {
  const resolvedTarget = targetId ?? inferTargetId(replay, pilotId);
  if (!resolvedTarget) return { truth: ownshipTurnTruth(replay, pilotId) };
  const byTurn = new Map<number, TurnTruth>();
  for (const f of replay.frames) {
    if (f.turn < 1) continue;
    const body = f.aircraft.find((a) => a.id === pilotId);
    const target = f.aircraft.find((a) => a.id === resolvedTarget);
    if (!body || !target) continue;
    const to = sub(target.position, body.position);
    const range = length(to);
    const fwd = basisFromQuat(body.orientation).forward;
    const onNose = dot(fwd, normalize(to));
    const offDeg = offNoseDeg(onNose);
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
    if (onNose < 0) t.overshot = true; // target went behind the nose
  }
  return { truth: [...byTurn.values()].sort((a, b) => a.turn - b.turn), targetId: resolvedTarget };
}

function ownshipTurnTruth(replay: MatchReplay, pilotId: string): TurnTruth[] {
  const byTurn = new Map<number, TurnTruth>();
  for (const f of replay.frames) {
    if (f.turn < 1) continue;
    const body = f.aircraft.find((a) => a.id === pilotId);
    if (!body) continue;
    let t = byTurn.get(f.turn);
    if (!t) {
      t = {
        turn: f.turn,
        rangeStartM: 0,
        rangeEndM: 0,
        offNoseStartDeg: 0,
        offNoseEndDeg: 0,
        peakG: body.gLoad,
        minAltM: body.altitude,
        peakAoADeg: body.aoaDeg,
        overshot: false,
      };
      byTurn.set(f.turn, t);
    }
    t.peakG = Math.max(t.peakG, body.gLoad);
    t.minAltM = Math.min(t.minAltM, body.altitude);
    t.peakAoADeg = Math.max(t.peakAoADeg, body.aoaDeg);
  }
  return [...byTurn.values()].sort((a, b) => a.turn - b.turn);
}

function inferTargetId(replay: MatchReplay, pilotId: string): string | undefined {
  const lastFrame = replay.frames.at(-1);
  if (!lastFrame) return undefined;
  // Prefer a balloon (static target); otherwise the first other aircraft.
  const balloon = lastFrame.aircraft.find((a) => a.id !== pilotId && a.static);
  if (balloon) return balloon.id;
  const other = lastFrame.aircraft.find((a) => a.id !== pilotId);
  return other?.id;
}

function f1(x: number): string {
  return x.toFixed(1);
}

function actionSummary(action: Action): string {
  if (action.kind === "motor-program") {
    const weapons = action.heldActions.find((held) => held.kind === "weapons_free");
    return `motor-program ${action.durationMs}ms/${action.sampleDtMs}ms samples=${action.samples.length} weapons_free=${weapons ? `${weapons.coneDeg ?? "?"}deg/${weapons.rangeM ?? "?"}m` : "none"}`;
  }
  if (action.kind === "pilot-intent") {
    return `pilot-intent ${action.goal} urgency=${action.urgency.toFixed(2)} style=${action.style}`;
  }
  return action.kind;
}

// Recover the SAW / COMMANDED summary for one decision straight from the replay (no digest file).
function tapeSummary(action: Action): string {
  if (action.kind !== "motor-program") return actionSummary(action);
  const tape = action as MotorProgramAction;
  const first = tape.samples[0];
  const last = tape.samples[tape.samples.length - 1];
  return `pitch ${f1(first.pitch)}->${f1(last.pitch)}, roll ${f1(first.roll)}->${f1(last.roll)}, throttle ${f1(first.throttle)}`;
}

function seenSummary(decision: TurnDecision): string {
  const self = decision.observation.self;
  const contact = decision.observation.contacts[0];
  const seen = contact
    ? `range=${contact.range.toFixed(0)}m bearingFwd=${contact.bearingForward.toFixed(2)} bearingUp=${contact.bearingUp.toFixed(2)} closure=${contact.closureRate.toFixed(0)}m/s`
    : "no contact in view";
  return `${seen} alt=${self.altitude.toFixed(0)}m speed=${self.airspeed.toFixed(0)}m/s aoa=${self.aoaDeg.toFixed(0)}deg`;
}

export function buildDebriefGrounding(
  replay: MatchReplay,
  options: { pilotId?: string; time?: number; targetId?: string } = {},
): DebriefGrounding {
  const pilotId = options.pilotId ?? "blue-1";
  const durationSeconds = replay.frames.at(-1)?.time ?? 0;
  const focusTime = clampTime(options.time ?? durationSeconds, durationSeconds);
  const { truth, targetId } = perTurnTruth(replay, pilotId, options.targetId);
  const agent = replay.agents?.find((entry) => entry.id === pilotId);
  const pilotLabel = agent?.label ?? pilotId;
  const bodyLabel =
    stringConfig(agent?.config, "bodyModel") ?? stringConfig(agent?.config, "twitchBodyModel");

  const decisions = (replay.decisions ?? [])
    .filter((d) => d.agentId === pilotId)
    .sort((a, b) => a.turn - b.turn || a.observation.time - b.observation.time);

  const traceLines = decisions.map((decision) => {
    const t = truth.find((x) => x.turn === decision.turn);
    const real = t
      ? targetId
        ? `ACTUAL range ${t.rangeStartM.toFixed(0)}->${t.rangeEndM.toFixed(0)}m, peakG ${t.peakG.toFixed(1)}, minAlt ${t.minAltM.toFixed(0)}m, peakAoA ${t.peakAoADeg.toFixed(0)}deg${t.overshot ? ", OVERSHOT (target passed behind your nose)" : ""}`
        : `ACTUAL ownship peakG ${t.peakG.toFixed(1)}, minAlt ${t.minAltM.toFixed(0)}m, peakAoA ${t.peakAoADeg.toFixed(0)}deg`
      : "ACTUAL (no physics for this turn)";
    const said = decision.rationale ? ` | YOU SAID: "${decision.rationale}"` : "";
    const src = decision.source === "fallback" ? " [FALLBACK — not your decision]" : "";
    return `Turn ${decision.turn}${src}: SAW ${seenSummary(decision)} | COMMANDED ${tapeSummary(decision.action)} | ${real}${said}`;
  });

  const peakGTurn = truth.length ? truth.reduce((a, b) => (b.peakG > a.peakG ? b : a)) : undefined;
  const minAltTurn = truth.length ? truth.reduce((a, b) => (b.minAltM < a.minAltM ? b : a)) : undefined;
  const overshoot = truth.find((t) => t.offNoseStartDeg < 30 && t.offNoseEndDeg > 90) ?? truth.find((t) => t.overshot);

  const competence = replay.outcome?.competence?.[pilotId];
  const lastTick = (replay.bodyTicks ?? [])
    .filter((tick) => tick.agentId === pilotId && tick.time <= focusTime + 1e-6)
    .sort((a, b) => b.time - a.time)[0];
  const lastDecision = decisions
    .filter((d) => d.observation.time <= focusTime + 1e-6)
    .sort((a, b) => b.observation.time - a.observation.time || b.turn - a.turn)[0];

  return {
    replayId: replay.id,
    pilotId,
    pilotLabel,
    ...(bodyLabel ? { bodyLabel } : {}),
    ...(targetId ? { targetId } : {}),
    durationSeconds,
    focusTime,
    turnTruth: truth,
    phaseCounts: {
      planner: countPhases(replay, pilotId, "planner"),
      body: countPhases(replay, pilotId, "body"),
      twitch: countPhases(replay, pilotId, "twitch"),
    },
    ...(peakGTurn ? { peakG: { turn: peakGTurn.turn, value: peakGTurn.peakG } } : {}),
    ...(minAltTurn ? { minAlt: { turn: minAltTurn.turn, value: minAltTurn.minAltM } } : {}),
    ...(overshoot ? { overshootTurn: overshoot.turn } : {}),
    ...(replay.outcome
      ? {
          outcome: {
            resolved: replay.outcome.resolved,
            reason: replay.outcome.reason,
            survived: competence?.survived ?? false,
          },
        }
      : {}),
    hits: competence?.hits ?? 0,
    shots: competence?.shots ?? 0,
    traceLines,
    ...(lastDecision
      ? {
          lastDecisionContext: [
            `Around t=${focusTime.toFixed(1)}s, your last command was on turn ${lastDecision.turn} (source: ${lastDecision.source}).`,
            `Action: ${actionSummary(lastDecision.action)}`,
            lastDecision.rationale ? `Your rationale then: "${lastDecision.rationale}"` : undefined,
            lastDecision.observation.text ? `Cockpit view you read:\n${lastDecision.observation.text}` : undefined,
          ]
            .filter(Boolean)
            .join("\n"),
        }
      : {}),
    ...(lastTick
      ? {
          lastBodyContext: [
            `Body (${bodyLabel ?? "unknown"}) at t=${lastTick.time.toFixed(1)}s reported status "${lastTick.parsed.status}"${lastTick.parsed.solution ? `, solution ${lastTick.parsed.solution}` : ""}.`,
            lastTick.parsed.feel ? `Body feel: ${lastTick.parsed.feel}` : undefined,
          ]
            .filter(Boolean)
            .join("\n"),
        }
      : {}),
  };
}

// Build the grounded system + user-context strings the chat model is steered by. The conversation
// history is appended separately by the caller; this is the fixed evidence frame.
export function debriefSystemPrompt(g: DebriefGrounding): string {
  return `You are a fighter pilot being debriefed about a flight you just flew, by a coach who can see the flight physics you could not see from the cockpit. You answer AS THE PILOT, in the first person, in tight honest prose.

GROUND RULES — read carefully:
- Answer ONLY from the replay evidence given below. This is the single source of truth about what happened.
- If the evidence does not contain something you are asked about, say so plainly ("the trace doesn't show that") instead of inventing it. Never fabricate events, kills, maneuvers, or numbers that are not in the evidence.
- Use the actual numbers when they help. The floor is 55 m; the wing stalls past ~24 deg AoA; sustained turns above ~7 G bleed energy fast.
- Be concrete and self-critical, not agreeable for its own sake. It is fine to disagree with the coach if the evidence supports you.
- A turn marked [FALLBACK] was NOT your decision — the autopilot took over because your command was rejected; don't take credit or blame for it.
- Keep replies short unless asked to expand.`;
}

export function debriefEvidenceBlock(g: DebriefGrounding): string {
  const lines: string[] = [];
  lines.push(`Replay: ${g.replayId}`);
  lines.push(`You are: ${g.pilotLabel} (id ${g.pilotId})`);
  if (g.bodyLabel) lines.push(`Your body/twitch controller: ${g.bodyLabel}`);
  if (g.targetId) lines.push(`Target: ${g.targetId}`);
  lines.push(`Flight length: ${g.durationSeconds.toFixed(1)}s. This debrief is focused around t=${g.focusTime.toFixed(1)}s.`);
  lines.push(
    `Control phases: planner=${g.phaseCounts.planner}, body=${g.phaseCounts.body}, twitch=${g.phaseCounts.twitch}.`,
  );
  if (g.outcome) {
    lines.push(
      `Outcome: ${g.outcome.resolved ? "resolved" : "unresolved"} (${g.outcome.reason}); you ${g.outcome.survived ? "survived" : "did not survive"}. Shots ${g.shots}, hits ${g.hits}.`,
    );
  }
  if (g.peakG) lines.push(`Peak G: ${g.peakG.value.toFixed(1)} on turn ${g.peakG.turn}.`);
  if (g.minAlt) lines.push(`Lowest altitude: ${g.minAlt.value.toFixed(0)} m on turn ${g.minAlt.turn} (floor is 55 m).`);
  if (g.overshootTurn !== undefined) lines.push(`Overshoot detected on turn ${g.overshootTurn} (target passed behind your nose).`);
  lines.push("");
  lines.push("Per-turn trace (what you SAW, what you COMMANDED, what ACTUALLY happened):");
  lines.push(g.traceLines.length ? g.traceLines.join("\n") : "(no per-turn decisions recorded in this replay)");
  if (g.lastDecisionContext) {
    lines.push("");
    lines.push(g.lastDecisionContext);
  }
  if (g.lastBodyContext) {
    lines.push("");
    lines.push(g.lastBodyContext);
  }
  return lines.join("\n");
}

function clampTime(time: number, durationSeconds: number): number {
  if (!Number.isFinite(time)) return durationSeconds;
  return Math.max(0, Math.min(durationSeconds, time));
}

function stringConfig(config: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = config?.[key];
  return typeof value === "string" ? value : undefined;
}

function countPhases(replay: MatchReplay, agentId: string, mode: "planner" | "body" | "twitch"): number {
  return (replay.agentPhases ?? []).filter((phase) => phase.agentId === agentId && phase.mode === mode).length;
}
