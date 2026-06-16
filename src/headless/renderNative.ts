// Native offline render pipeline.
//
//   npm run export:native-timeline -- --replay match.json --timeline-out clips/native.timeline.json
//   npm run render:native -- --replay match.json --out clips/native-flight.mp4
//   npm run render:native -- --turns 8 --seconds 10 --camera cinematic --out clips/native-demo.mp4
//
// The browser is deliberately not in this path. TypeScript exports a deterministic render timeline;
// Blender consumes that timeline as an engine-native scene and writes frames/MP4.
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MatchReplaySchema, type MatchReplay } from "../protocol/schema";
import { buildNativeRenderTimeline, type NativeCameraMode } from "../render/nativeTimeline";
import { generateDemoMatch } from "../runtime/scenario";

const argv = process.argv.slice(2);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function flag(name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function numberFlag(name: string, fallback: number): number {
  const raw = flag(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a finite number`);
  return value;
}

function cameraMode(value: string): NativeCameraMode {
  if (value === "topgun" || value === "vtuber" || value === "pilot") return "pilot-hero";
  if (
    value === "cinematic" ||
    value === "chase" ||
    value === "cockpit" ||
    value === "orbit" ||
    value === "pilot-hero"
  ) {
    return value;
  }
  throw new Error("--camera must be cinematic, chase, cockpit, orbit, or pilot-hero");
}

const replayPath = flag("--replay");
const turns = Math.max(1, Math.round(numberFlag("--turns", 8)));
const fps = numberFlag("--fps", Number(process.env.NATIVE_RENDER_FPS ?? 24));
const seconds = numberFlag("--seconds", 12);
const width = Math.max(1, Math.round(numberFlag("--width", Number(process.env.NATIVE_RENDER_WIDTH ?? 1280))));
const height = Math.max(1, Math.round(numberFlag("--height", Number(process.env.NATIVE_RENDER_HEIGHT ?? 720))));
const pilotId = flag("--pilot-id") ?? "blue-1";
const mode = cameraMode(flag("--camera") ?? "cinematic");
const defaultAvatarPath = resolve("public/models/VRM1_Constraint_Twist_Sample.vrm");
const avatarPath =
  flag("--avatar") ?? (mode === "pilot-hero" && existsSync(defaultAvatarPath) ? defaultAvatarPath : undefined);
const timelineOnly = argv.includes("--timeline-only");
const keepFrames = argv.includes("--keep-frames");
const samples = Math.max(1, Math.round(numberFlag("--samples", Number(process.env.NATIVE_RENDER_SAMPLES ?? 48))));
const out = resolve(flag("--out") ?? "clips/native-flight.mp4");
const timelineOut = resolve(flag("--timeline-out") ?? `${out}.timeline.json`);
const framesDir = resolve(flag("--frames-dir") ?? `${out}.frames`);
const blender = flag("--blender") ?? process.env.BLENDER ?? "blender";
const rendererScript = resolve(repoRoot, "tools/blender/render_native_flight.py");

async function main(): Promise<void> {
  const replay = replayPath ? await readReplay(resolve(replayPath)) : await generateDemoMatch(turns);
  const timeline = buildNativeRenderTimeline(replay, {
    fps,
    seconds,
    width,
    height,
    pilotId,
    cameraMode: mode,
    avatarPath,
  });

  await mkdir(dirname(timelineOut), { recursive: true });
  await writeFile(timelineOut, `${JSON.stringify(timeline, null, 2)}\n`);
  console.error(
    `native timeline: ${timeline.frames.length} frames @ ${timeline.fps}fps, ` +
      `${timeline.width}x${timeline.height}, camera=${timeline.cameraMode} -> ${timelineOut}`,
  );

  if (timelineOnly) return;
  assertBlenderAvailable(blender);
  await mkdir(dirname(out), { recursive: true });

  const child = spawn(
    blender,
    [
      "-b",
      "--python",
      rendererScript,
      "--",
      "--timeline",
      timelineOut,
      "--out",
      out,
      "--frames-dir",
      framesDir,
      "--samples",
      String(samples),
      ...(keepFrames ? ["--keep-frames"] : []),
    ],
    { stdio: "inherit" },
  );
  const [code] = (await once(child, "close")) as [number];
  if (code !== 0) throw new Error(`Blender exited ${code}`);
}

async function readReplay(path: string): Promise<MatchReplay> {
  return MatchReplaySchema.parse(JSON.parse(await readFile(path, "utf8")));
}

function assertBlenderAvailable(command: string): void {
  const probe = spawnSync(command, ["--version"], { stdio: "ignore" });
  if (probe.error) {
    throw new Error(
      `Blender was not found at "${command}". Install Blender or pass --blender /path/to/blender. ` +
        `The timeline was written already, so rendering can be retried without regenerating it.`,
    );
  }
  if (typeof probe.status === "number" && probe.status !== 0) {
    throw new Error(`Blender probe exited ${probe.status}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
