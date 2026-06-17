import type {
  Action,
  AircraftSnapshot,
  MotorProgramAction,
  ReplayFrame,
  TurnDecision,
} from "../protocol/schema";
import { basisFromQuat, clamp, cross, dot, length, normalize, scale, sub, vec3 } from "../sim/math";
import type { AgentMessageDraft, AgentMessageProvider } from "./comms";
import { compassBearingDeg, compassPoint } from "./navigation";

export interface PhysicsCoachOptions {
  agentId?: string;
  targetId?: string;
  from?: string;
  startTurn?: number;
  includeNavigation?: boolean;
}

interface TurnPhysicsSummary {
  turn: number;
  headingStartDeg: number;
  headingEndDeg: number;
  targetBearingStartDeg?: number;
  targetBearingEndDeg?: number;
  headingErrorStartDeg?: number;
  headingErrorEndDeg?: number;
  headingErrorImprovementDeg?: number;
  rangeStartM?: number;
  rangeEndM?: number;
  peakG: number;
  minAltitudeM: number;
  bankStartDeg: number;
  bankEndDeg: number;
  pitchStartDeg: number;
  pitchEndDeg: number;
}

export function createPhysicsCoachProvider(options: PhysicsCoachOptions = {}): AgentMessageProvider {
  const agentId = options.agentId ?? "blue-1";
  const from = options.from ?? "flight-coach";
  const startTurn = options.startTurn ?? 2;
  const includeNavigation = options.includeNavigation ?? true;

  return (context) => {
    if (context.agentId !== agentId || context.turn < startTurn) return [];
    const previousTurn = context.turn - 1;
    const frames = context.history?.frames ?? [];
    const decisions = context.history?.decisions ?? [];
    const summary = summarizeTurnPhysics(frames, {
      turn: previousTurn,
      agentId,
      targetId: options.targetId,
    });
    if (!summary) return [];

    const decision = [...decisions]
      .reverse()
      .find((candidate) => candidate.agentId === agentId && candidate.turn === previousTurn);

    return [
      {
        id: `physics-coach-${agentId}-after-t${previousTurn}`,
        from,
        to: agentId,
        channel: "coach",
        priority: "priority",
        turn: context.turn,
        content: renderPhysicsCoachMessage(summary, decision),
        includeNavigation,
      } satisfies AgentMessageDraft,
    ];
  };
}

export function summarizeTurnPhysics(
  frames: readonly ReplayFrame[],
  input: { turn: number; agentId: string; targetId?: string },
): TurnPhysicsSummary | undefined {
  const turnFrames = frames.filter((frame) => frame.turn === input.turn);
  const first = turnFrames[0];
  const last = turnFrames.at(-1);
  if (!first || !last) return undefined;

  const startSelf = first.aircraft.find((ship) => ship.id === input.agentId);
  const endSelf = last.aircraft.find((ship) => ship.id === input.agentId);
  if (!startSelf || !endSelf) return undefined;

  const startTarget = targetFor(first, startSelf, input.targetId);
  const endTarget = targetFor(last, endSelf, input.targetId);
  const headingStartDeg = compassBearingDeg(basisFromQuat(startSelf.orientation).forward);
  const headingEndDeg = compassBearingDeg(basisFromQuat(endSelf.orientation).forward);
  const targetBearingStartDeg = startTarget
    ? compassBearingDeg(sub(startTarget.position, startSelf.position))
    : undefined;
  const targetBearingEndDeg = endTarget
    ? compassBearingDeg(sub(endTarget.position, endSelf.position))
    : undefined;
  const headingErrorStartDeg =
    targetBearingStartDeg !== undefined ? signedHeadingError(targetBearingStartDeg, headingStartDeg) : undefined;
  const headingErrorEndDeg =
    targetBearingEndDeg !== undefined ? signedHeadingError(targetBearingEndDeg, headingEndDeg) : undefined;
  const rangeStartM = startTarget ? length(sub(startTarget.position, startSelf.position)) : undefined;
  const rangeEndM = endTarget ? length(sub(endTarget.position, endSelf.position)) : undefined;

  let peakG = startSelf.gLoad;
  let minAltitudeM = startSelf.altitude;
  for (const frame of turnFrames) {
    const self = frame.aircraft.find((ship) => ship.id === input.agentId);
    if (!self) continue;
    peakG = Math.max(peakG, self.gLoad);
    minAltitudeM = Math.min(minAltitudeM, self.altitude);
  }

  const startAttitude = attitude(startSelf);
  const endAttitude = attitude(endSelf);

  return {
    turn: input.turn,
    headingStartDeg,
    headingEndDeg,
    ...(targetBearingStartDeg !== undefined ? { targetBearingStartDeg } : {}),
    ...(targetBearingEndDeg !== undefined ? { targetBearingEndDeg } : {}),
    ...(headingErrorStartDeg !== undefined ? { headingErrorStartDeg } : {}),
    ...(headingErrorEndDeg !== undefined ? { headingErrorEndDeg } : {}),
    ...(headingErrorStartDeg !== undefined && headingErrorEndDeg !== undefined
      ? { headingErrorImprovementDeg: Math.abs(headingErrorStartDeg) - Math.abs(headingErrorEndDeg) }
      : {}),
    ...(rangeStartM !== undefined ? { rangeStartM } : {}),
    ...(rangeEndM !== undefined ? { rangeEndM } : {}),
    peakG,
    minAltitudeM,
    bankStartDeg: startAttitude.bankDeg,
    bankEndDeg: endAttitude.bankDeg,
    pitchStartDeg: startAttitude.pitchDeg,
    pitchEndDeg: endAttitude.pitchDeg,
  };
}

function renderPhysicsCoachMessage(summary: TurnPhysicsSummary, decision: TurnDecision | undefined): string {
  const parts: string[] = [];
  parts.push(
    `Physics coach after turn ${summary.turn}: heading ${formatBearing(summary.headingStartDeg)} -> ${formatBearing(
      summary.headingEndDeg,
    )}`,
  );
  if (summary.targetBearingStartDeg !== undefined && summary.targetBearingEndDeg !== undefined) {
    parts.push(`steer ${formatBearing(summary.targetBearingStartDeg)} -> ${formatBearing(summary.targetBearingEndDeg)}`);
  }
  if (summary.headingErrorStartDeg !== undefined && summary.headingErrorEndDeg !== undefined) {
    const improved = summary.headingErrorImprovementDeg ?? 0;
    parts.push(
      `signed heading error ${formatSigned(summary.headingErrorStartDeg)} -> ${formatSigned(
        summary.headingErrorEndDeg,
      )} deg (${improved >= 0 ? "improved" : "worsened"} ${Math.abs(improved).toFixed(1)} deg)`,
    );
  }
  if (summary.rangeStartM !== undefined && summary.rangeEndM !== undefined) {
    parts.push(`range ${(summary.rangeStartM / 1000).toFixed(1)} -> ${(summary.rangeEndM / 1000).toFixed(1)} km`);
  }
  parts.push(
    `peakG ${summary.peakG.toFixed(1)}, minAlt ${summary.minAltitudeM.toFixed(0)} m, bank ${summary.bankStartDeg.toFixed(
      0,
    )} -> ${summary.bankEndDeg.toFixed(0)} deg, pitch ${summary.pitchStartDeg.toFixed(0)} -> ${summary.pitchEndDeg.toFixed(
      0,
    )} deg`,
  );
  if (decision) parts.push(`last tape: ${actionSummary(decision.action)}`);
  parts.push(`diagnosis: ${diagnosis(summary)}`);
  parts.push(`next tape: ${nextTapeAdvice(summary)}`);
  return parts.join(". ");
}

function diagnosis(summary: TurnPhysicsSummary): string {
  const improvement = summary.headingErrorImprovementDeg;
  const severeBank = Math.abs(summary.bankEndDeg) > 105;
  const weakTurn = improvement !== undefined && improvement < 2;
  if (severeBank) {
    return "you are overbanked or partly inverted; that attitude is dominating the tape more than the intercept heading";
  }
  if (weakTurn && summary.peakG < 1.5) {
    return "you described a turn, but the aircraft mostly unloaded; bank without sustained pull did not bend the velocity vector";
  }
  if (weakTurn) {
    return "heading did not converge on the steer bearing; do not repeat the same tape";
  }
  if (summary.headingErrorEndDeg !== undefined && Math.abs(summary.headingErrorEndDeg) < 12) {
    return "heading is close to the steer bearing; begin reducing bank and stabilize";
  }
  return "the heading error is moving the right way; keep the turn controlled and avoid overbanking";
}

function nextTapeAdvice(summary: TurnPhysicsSummary): string {
  const error = summary.headingErrorEndDeg;
  if (error === undefined) return "use the measured attitude/G response to correct the next stick tape";
  if (Math.abs(error) < 12) {
    return "roll toward level, keep modest positive pitch, and hold energy while waiting for radar contact";
  }
  if (Math.abs(summary.bankEndDeg) > 105) {
    const recoveryRoll = summary.bankEndDeg > 0 ? "negative roll" : "positive roll";
    return `recover bank first: use ${recoveryRoll} until bank is back inside 55-75 deg; keep pitch near 0..+0.2 while overbanked, then pull +0.5..+0.8 for 2-4 G once bank is controlled`;
  }
  const turnWord = error > 0 ? "clockwise/right" : "counter-clockwise/left";
  const rollSign = error > 0 ? "positive" : "negative";
  const pull = summary.peakG < 1.5 ? "pitch +0.6..+0.8" : "sustain positive pitch";
  return `continue ${turnWord}: use ${rollSign} roll to hold a controlled 55-75 deg bank, then ${pull} for 2-4 G; if heading does not move ${turnWord}, the tape is not pulling enough or bank sign is wrong`;
}

function actionSummary(action: Action): string {
  if (action.kind !== "motor-program") return action.kind;
  const tape = action as MotorProgramAction;
  const samples = tape.samples;
  const avg = (key: "pitch" | "roll" | "yaw" | "throttle") =>
    samples.reduce((sum, sample) => sum + sample[key], 0) / Math.max(1, samples.length);
  const guards = tape.heldActions
    .filter((held) => held.kind === "weapons_free")
    .map((held) => held.condition ?? "weapons_free")
    .join(",");
  return `avg pitch ${avg("pitch").toFixed(2)}, roll ${avg("roll").toFixed(2)}, yaw ${avg("yaw").toFixed(
    2,
  )}, throttle ${avg("throttle").toFixed(2)}, weapons ${guards || "none"}`;
}

function attitude(ship: AircraftSnapshot): { bankDeg: number; pitchDeg: number } {
  const basis = basisFromQuat(ship.orientation);
  const worldUp = vec3(0, 1, 0);
  const refUp = normalize(sub(worldUp, scale(basis.forward, dot(worldUp, basis.forward))), basis.up);
  const bankRad = Math.atan2(dot(cross(refUp, basis.up), basis.forward), dot(refUp, basis.up));
  const pitchRad = Math.asin(clamp(basis.forward.y, -1, 1));
  return {
    bankDeg: (bankRad * 180) / Math.PI,
    pitchDeg: (pitchRad * 180) / Math.PI,
  };
}

function targetFor(
  frame: ReplayFrame,
  self: AircraftSnapshot,
  targetId: string | undefined,
): AircraftSnapshot | undefined {
  if (targetId) return frame.aircraft.find((ship) => ship.id === targetId);
  return frame.aircraft.find((ship) => ship.id !== self.id && ship.team !== self.team && ship.health > 0);
}

function signedHeadingError(targetDeg: number, headingDeg: number): number {
  return ((targetDeg - headingDeg + 540) % 360) - 180;
}

function formatBearing(degrees: number): string {
  return `${Math.round(degrees).toString().padStart(3, "0")} ${compassPoint(degrees)}`;
}

function formatSigned(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}`;
}
