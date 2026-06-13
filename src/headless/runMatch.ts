// Headless full-match runner (credential-free). Runs the all-scripted demo in-process and
// writes the replay JSON to stdout (a brief summary goes to stderr so the redirect stays clean):
//   npm run match            -> match.json
//   tsx src/headless/runMatch.ts 12 > match.json
import { generateDemoMatch } from "../runtime/scenario";

async function main(): Promise<void> {
  const numericArg = process.argv.slice(2).find((arg) => /^\d+$/.test(arg));
  const turnCount = numericArg ? Number(numericArg) : 28;

  const replay = await generateDemoMatch(turnCount);
  process.stdout.write(JSON.stringify(replay));

  const shots = replay.frames.reduce(
    (n, f) => n + f.events.filter((e) => e.type === "shot").length,
    0,
  );
  const hits = replay.frames.reduce(
    (n, f) => n + f.events.filter((e) => e.type === "hit").length,
    0,
  );
  const outcome = replay.outcome;
  console.error(
    `scripted match: ${replay.frames.length} frames, ${shots} shots, ${hits} hits, ` +
      `outcome=${outcome ? `${outcome.reason} winner=${outcome.winnerTeam ?? "draw"}` : "none"}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
