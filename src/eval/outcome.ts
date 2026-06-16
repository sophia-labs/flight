import {
  MatchOutcomeSchema,
  type Competence,
  type MatchOutcome,
  type ReplayFrame,
  type Score,
  type TurnDecision,
} from "../protocol/schema";
import { clamp } from "../sim/math";
import type { AircraftState, Team } from "../sim/types";

const GRAVITY = 9.81;
const DECK_ALTITUDE = 120; // "on the deck" ≈ within ~65 m of the 55 m floor

export interface Evaluator {
  // Receives the full frame + decision history so a richer evaluator can measure piloting
  // quality, not just the final result. The minimal evaluator ignores frames/decisions.
  evaluate(
    finalAircraft: AircraftState[],
    frames: ReplayFrame[],
    decisions: TurnDecision[],
    turnsRun: number,
  ): MatchOutcome;
}

function damageDealtBy(team: Team, aircraft: AircraftState[]): number {
  return aircraft
    .filter((a) => a.team !== team)
    .reduce((sum, enemy) => sum + (100 - enemy.health), 0);
}

// Shared result logic: "first to 0 health wins; otherwise most damage dealt at timeout."
function baseOutcome(finalAircraft: AircraftState[], turnsRun: number) {
  const teams = [...new Set(finalAircraft.map((a) => a.team))];
  const scores: Record<string, Score> = {};
  const finalHealth: Record<string, number> = {};
  for (const a of finalAircraft) finalHealth[a.id] = a.health;
  for (const team of teams) {
    scores[team] = {
      damageDealt: damageDealtBy(team, finalAircraft),
      damageTaken: finalAircraft
        .filter((a) => a.team === team)
        .reduce((sum, a) => sum + (100 - a.health), 0),
      survived: finalAircraft.some((a) => a.team === team && a.health > 0),
    };
  }

  if (finalAircraft.some((a) => a.health <= 0)) {
    const survivors = [...new Set(finalAircraft.filter((a) => a.health > 0).map((a) => a.team))];
    return {
      resolved: true,
      reason: "destroyed" as const,
      winnerTeam: survivors.length === 1 ? survivors[0] : null,
      turnsRun,
      scores,
      finalHealth,
    };
  }

  const ranked = teams
    .map((team) => ({ team, dealt: scores[team].damageDealt }))
    .sort((a, b) => b.dealt - a.dealt);
  const tie = ranked.length < 2 || ranked[0].dealt === ranked[1].dealt;
  const reason: "draw" | "timeout" = tie ? "draw" : "timeout";
  return { resolved: true, reason, winnerTeam: tie ? null : ranked[0].team, turnsRun, scores, finalHealth };
}

export const minimalEvaluator: Evaluator = {
  evaluate(finalAircraft, _frames, _decisions, turnsRun) {
    return MatchOutcomeSchema.parse(baseOutcome(finalAircraft, turnsRun));
  },
};

function competenceFor(
  aircraftId: string,
  team: Team,
  finalAircraft: AircraftState[],
  frames: ReplayFrame[],
  decisions: TurnDecision[],
): Competence {
  const snaps = frames
    .map((f) => f.aircraft.find((a) => a.id === aircraftId))
    .filter((s): s is NonNullable<typeof s> => Boolean(s));
  const events = frames.flatMap((f) => f.events);
  const health = finalAircraft.find((a) => a.id === aircraftId)?.health ?? 0;
  const n = Math.max(snaps.length, 1);

  const specificEnergy = (s: { airspeed: number; altitude: number }) =>
    0.5 * s.airspeed * s.airspeed + GRAVITY * s.altitude;
  const startE = snaps.length ? specificEnergy(snaps[0]) : 1;
  const endE = snaps.length ? specificEnergy(snaps[snaps.length - 1]) : 0;

  const mine = decisions.filter((d) => d.agentId === aircraftId).sort((a, b) => a.turn - b.turn);
  let deltaSum = 0;
  let deltaCount = 0;
  for (let i = 1; i < mine.length; i += 1) {
    const prev = mine[i - 1].controlInput;
    const cur = mine[i].controlInput;
    deltaSum += (Math.abs(cur.pitch - prev.pitch) + Math.abs(cur.roll - prev.roll)) / 2;
    deltaCount += 1;
  }

  return {
    survived: health > 0,
    damageDealt: finalAircraft
      .filter((a) => a.team !== team)
      .reduce((sum, e) => sum + (100 - e.health), 0),
    damageTaken: 100 - health,
    shots: events.filter((e) => e.type === "shot" && e.actorId === aircraftId).length,
    hits: events.filter((e) => e.type === "hit" && e.actorId === aircraftId).length,
    fracStalled: snaps.filter((s) => s.stalled).length / n,
    fracOnDeck: snaps.filter((s) => s.altitude < DECK_ALTITUDE).length / n,
    minAltitude: snaps.length ? Math.min(...snaps.map((s) => s.altitude)) : 0,
    meanAirspeed: snaps.length ? snaps.reduce((sum, s) => sum + s.airspeed, 0) / n : 0,
    energyRetainedRatio: startE > 0 ? endE / startE : 0,
    controlSmoothness: deltaCount ? clamp(1 - deltaSum / deltaCount, 0, 1) : 1,
  };
}

// Opponent-agnostic piloting-quality evaluator: the result plus a per-aircraft competence vector.
export const competenceEvaluator: Evaluator = {
  evaluate(finalAircraft, frames, decisions, turnsRun) {
    const competence: Record<string, Competence> = {};
    for (const a of finalAircraft) {
      competence[a.id] = competenceFor(a.id, a.team, finalAircraft, frames, decisions);
    }
    return MatchOutcomeSchema.parse({ ...baseOutcome(finalAircraft, turnsRun), competence });
  },
};
