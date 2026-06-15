import { readFile } from "node:fs/promises";
import { MatchReplaySchema } from "../protocol/schema";
import {
  DEFAULT_VERIFICATION_PILOT_ID,
  formatReplayVerification,
  summarizeReplayVerification,
} from "./replayVerification";

const argv = process.argv.slice(2);

function flagValue(flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function positionalPath(): string {
  const value = argv.find((arg, index) => !arg.startsWith("--") && argv[index - 1] !== "--pilot-id");
  if (!value) throw new Error("usage: verifyReplay.ts <replay.json> [--pilot-id blue-1] [--require-ensemble]");
  return value;
}

async function main(): Promise<void> {
  const path = positionalPath();
  const pilotId = flagValue("--pilot-id") ?? DEFAULT_VERIFICATION_PILOT_ID;
  const requireEnsemble = argv.includes("--require-ensemble");
  const replay = MatchReplaySchema.parse(JSON.parse(await readFile(path, "utf8")));
  const summary = summarizeReplayVerification(replay, pilotId);
  console.error(formatReplayVerification(summary));
  if (requireEnsemble && !summary.llmEnsembleReady) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
