import {
  MatchOutcomeSchema,
  type MatchOutcome,
  type Score,
  type TurnDecision,
} from "../protocol/schema";
import type { AircraftState, Team } from "../sim/types";

export interface Evaluator {
  // Receives the full turn history so a richer 0.3.0 evaluator (time-on-target, energy
  // retained, kill credit) is a swapped implementation, not a signature change. The minimal
  // evaluator ignores it.
  evaluate(
    finalAircraft: AircraftState[],
    decisions: TurnDecision[],
    turnsRun: number,
  ): MatchOutcome;
}

function damageDealtBy(team: Team, aircraft: AircraftState[]): number {
  return aircraft
    .filter((a) => a.team !== team)
    .reduce((sum, enemy) => sum + (100 - enemy.health), 0);
}

// "First to 0 health wins; otherwise most damage dealt at timeout." The simplest outcome that
// exercises the evaluation seam end-to-end.
export const minimalEvaluator: Evaluator = {
  evaluate(finalAircraft, _decisions, turnsRun) {
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
      return MatchOutcomeSchema.parse({
        resolved: true,
        reason: "destroyed",
        winnerTeam: survivors.length === 1 ? survivors[0] : null,
        turnsRun,
        scores,
        finalHealth,
      });
    }

    const ranked = teams
      .map((team) => ({ team, dealt: scores[team].damageDealt }))
      .sort((a, b) => b.dealt - a.dealt);
    const tie = ranked.length < 2 || ranked[0].dealt === ranked[1].dealt;
    return MatchOutcomeSchema.parse({
      resolved: true,
      reason: tie ? "draw" : "timeout",
      winnerTeam: tie ? null : ranked[0].team,
      turnsRun,
      scores,
      finalHealth,
    });
  },
};
