import { z } from "zod";
import { MatchReplaySchema } from "../protocol/schema";
import { maybeJournalScenarioReplay, type GardenJournalResult } from "../garden/sortieJournal";

export const ScenarioGardenJournalRequestSchema = z.object({
  replay: MatchReplaySchema,
  pilotId: z.string().min(1).max(80).default("blue-1"),
  targetId: z.string().min(1).max(80).optional(),
});

export async function journalScenarioGardenApiRequest(input: unknown): Promise<GardenJournalResult> {
  const request = ScenarioGardenJournalRequestSchema.parse(input);
  return maybeJournalScenarioReplay(request.replay, {
    pilotId: request.pilotId,
    targetId: request.targetId,
  });
}
