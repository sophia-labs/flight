import { readFile, writeFile } from "node:fs/promises";
import { MatchReplaySchema } from "../protocol/schema";
import { formatFlightTranscript } from "../transcript/flightTranscript";
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
  const value = argv.find(
    (arg, index) =>
      !arg.startsWith("--") &&
      argv[index - 1] !== "--pilot-id" &&
      argv[index - 1] !== "--max-ticks" &&
      argv[index - 1] !== "--out",
  );
  if (!value) {
    throw new Error("usage: transcriptReplay.ts <replay.json> [--pilot-id blue-1] [--max-ticks 20] [--out transcript.md]");
  }
  return value;
}

function maxTicks(): number | undefined {
  const value = flagValue("--max-ticks");
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) throw new Error("--max-ticks must be a positive integer");
  return parsed;
}

async function main(): Promise<void> {
  const replay = MatchReplaySchema.parse(JSON.parse(await readFile(replayPath(), "utf8")));
  const pilotId = flagValue("--pilot-id") ?? DEFAULT_VERIFICATION_PILOT_ID;
  const transcript = formatFlightTranscript(replay, { pilotId, maxTicks: maxTicks() });
  const out = flagValue("--out");
  if (out) {
    await writeFile(out, transcript);
    console.error(`transcript -> ${out}`);
  } else {
    process.stdout.write(transcript);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
