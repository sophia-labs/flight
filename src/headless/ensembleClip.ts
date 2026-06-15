import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { MatchReplaySchema, type MatchReplay } from "../protocol/schema";
import { formatFlightTranscript } from "../transcript/flightTranscript";
import { ensembleArtifactPaths } from "./ensembleArtifacts";
import {
  DEFAULT_VERIFICATION_PILOT_ID,
  formatReplayVerification,
  summarizeReplayVerification,
} from "./replayVerification";

const DEFAULT_MODEL = "deepseek/deepseek-v4-flash";

const argv = process.argv.slice(2);
const consumed = new Set<number>();

function flagValue(flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  consumed.add(index);
  consumed.add(index + 1);
  return value;
}

function firstPositional(): string | undefined {
  return argv.find((arg, index) => {
    return !arg.startsWith("--") && !consumed.has(index) && !argv[index - 1]?.startsWith("--");
  });
}

function tsxBin(): string {
  return resolve("node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
}

async function run(command: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<void> {
  console.error(`\n$ ${[command, ...args].join(" ")}`);
  const child = spawn(command, args, {
    env: { ...process.env, ...env },
    stdio: "inherit",
  });
  const [code] = (await once(child, "close")) as [number];
  if (code !== 0) throw new Error(`${command} exited ${code}`);
}

function rel(path: string): string {
  const local = relative(process.cwd(), path);
  return local && !local.startsWith("..") ? local : path;
}

async function main(): Promise<void> {
  const model = flagValue("--model") ?? firstPositional() ?? DEFAULT_MODEL;
  const bodyModel = flagValue("--body-model") ?? model;
  const artifacts = ensembleArtifactPaths({
    model,
    bodyModel,
    out: flagValue("--out"),
    sensorOut: flagValue("--sensor-out"),
    replayOut: flagValue("--replay-out"),
    transcriptOut: flagValue("--transcript-out"),
  });
  const out = artifacts.cockpitOut;
  const sensorOut = artifacts.sensorOut;
  const replayOut = artifacts.replayOut;
  const transcriptOut = artifacts.transcriptOut;
  const writeTranscript = !argv.includes("--no-transcript");
  const turns = flagValue("--turns") ?? process.env.FILM_TURNS ?? "1";
  const filmFps = flagValue("--film-fps") ?? flagValue("--fps") ?? process.env.FILM_FPS ?? "30";
  const clipFps = flagValue("--clip-fps") ?? flagValue("--fps") ?? process.env.CLIP_FPS ?? "30";
  const seconds = flagValue("--seconds") ?? "4";
  const camera = flagValue("--camera") ?? "cabin";
  const pilotId = flagValue("--pilot-id") ?? DEFAULT_VERIFICATION_PILOT_ID;
  const bodyTimeoutMs = flagValue("--body-timeout-ms") ?? process.env.BODY_TIMEOUT_MS ?? "20000";
  const bodyMaxTokens = flagValue("--body-max-tokens") ?? process.env.BODY_MAX_TOKENS ?? "128";
  const bodyMaxRetries = flagValue("--body-max-retries") ?? process.env.BODY_MAX_RETRIES ?? "2";
  const bodyEmptyRetries = flagValue("--body-empty-retries") ?? process.env.BODY_EMPTY_RETRIES ?? "1";
  const attempts = Number(flagValue("--attempts") ?? "2");

  if (camera !== "cabin" && camera !== "orbit") throw new Error("--camera must be cabin or orbit");
  if (!Number.isInteger(attempts) || attempts < 1) throw new Error("--attempts must be a positive integer");

  console.error(
    `ensemble clip: pilot=${model} body=${bodyModel} turns=${turns} filmFps=${filmFps} clipFps=${clipFps}`,
  );

  let verified = false;
  let lastVerification = "";
  let verifiedReplay: MatchReplay | undefined;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (attempts > 1) console.error(`\nfilm attempt ${attempt}/${attempts}`);
    await run(
      tsxBin(),
      ["--env-file=.env", "src/headless/film.ts", model, "--out", sensorOut, "--replay-out", replayOut],
      {
        FILM_MODE: "pilot-intent",
        FILM_TURNS: turns,
        FILM_FPS: filmFps,
        BODY_MODEL: bodyModel,
        BODY_TIMEOUT_MS: bodyTimeoutMs,
        BODY_MAX_TOKENS: bodyMaxTokens,
        BODY_MAX_RETRIES: bodyMaxRetries,
        BODY_EMPTY_RETRIES: bodyEmptyRetries,
      },
    );

    const replay = MatchReplaySchema.parse(JSON.parse(await readFile(replayOut, "utf8")));
    const summary = summarizeReplayVerification(replay, pilotId);
    lastVerification = formatReplayVerification(summary);
    console.error(`\n${lastVerification}`);
    if (summary.llmEnsembleReady) {
      verified = true;
      verifiedReplay = replay;
      break;
    }
    if (attempt < attempts) console.error("verification failed; retrying film before cockpit render");
  }
  if (!verified) {
    throw new Error(`replay is not a verified live LLM ensemble\n${lastVerification}`);
  }

  if (writeTranscript) {
    if (!verifiedReplay) throw new Error("verified replay was not retained for transcript generation");
    await mkdir(dirname(transcriptOut), { recursive: true });
    await writeFile(transcriptOut, formatFlightTranscript(verifiedReplay, { pilotId }));
    console.error(`transcript -> ${rel(transcriptOut)}`);
  }

  await run(
    tsxBin(),
    [
      "src/headless/cockpitClip.ts",
      "--replay",
      replayOut,
      "--out",
      out,
      "--seconds",
      seconds,
      "--camera",
      camera,
      ...(argv.includes("--no-hud") ? ["--no-hud"] : []),
      ...(argv.includes("--captions") ? ["--captions"] : []),
    ],
    { CLIP_FPS: clipFps },
  );

  console.error(`\nverified ensemble cockpit clip -> ${rel(out)}`);
  console.error(`sensor film -> ${rel(sensorOut)}`);
  console.error(`replay -> ${rel(replayOut)}`);
  if (writeTranscript) console.error(`transcript -> ${rel(transcriptOut)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
