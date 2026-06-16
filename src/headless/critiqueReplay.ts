import { readFile } from "node:fs/promises";
import { MatchReplaySchema } from "../protocol/schema";
import { critiqueReplay, formatCritique } from "./ensembleCritique";
import { DEFAULT_VERIFICATION_PILOT_ID } from "./replayVerification";

const argv = process.argv.slice(2);

function flagValue(flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function replayPath(): string {
  const value = argv.find((arg, index) => !arg.startsWith("--") && argv[index - 1] !== "--pilot-id");
  if (!value) throw new Error("usage: critiqueReplay.ts <replay.json> [--pilot-id blue-1]");
  return value;
}

async function main(): Promise<void> {
  const replay = MatchReplaySchema.parse(JSON.parse(await readFile(replayPath(), "utf8")));
  const pilotId = flagValue("--pilot-id") ?? DEFAULT_VERIFICATION_PILOT_ID;
  console.error(formatCritique(critiqueReplay(replay, pilotId)));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
