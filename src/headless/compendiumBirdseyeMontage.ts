// Render a chronological bird's-eye montage from the replay table in reports/coach/replay-compendium-r1.md.
//
// Complete montage:
//   npm run montage:compendium-birdseye
//
// Fast diagnostic preview:
//   npm run montage:compendium-birdseye -- --max-seconds-per-replay 8 --fps 12 --samples 12
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MatchReplaySchema, type MatchReplay } from "../protocol/schema";
import { buildNativeRenderTimeline } from "../render/nativeTimeline";

interface CompendiumReplayEntry {
  index: number;
  localTime: string;
  replayPath: string;
  stage: string;
}

interface ManifestEntry extends CompendiumReplayEntry {
  durationSeconds: number;
  renderedSeconds: number;
  pilotId: string;
  aircraftIds: string[];
  airframeIds: string[];
  timeline: string;
  rawVideo?: string;
  labeledVideo?: string;
}

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

function optionalPositiveNumberFlag(name: string): number | undefined {
  const raw = flag(name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive finite number`);
  return value;
}

const compendiumPath = resolve(flag("--compendium") ?? "reports/coach/replay-compendium-r1.md");
const outDir = resolve(flag("--out-dir") ?? "clips/compendium-birdseye");
const out = resolve(flag("--out") ?? `${outDir}/compendium-birdseye.mp4`);
const manifestPath = resolve(flag("--manifest") ?? `${outDir}/manifest.json`);
const pilotIdFlag = flag("--pilot-id") ?? "blue-1";
const fps = Math.max(1, Math.round(numberFlag("--fps", Number(process.env.BIRDSEYE_MONTAGE_FPS ?? 16))));
const width = Math.max(1, Math.round(numberFlag("--width", Number(process.env.BIRDSEYE_MONTAGE_WIDTH ?? 1280))));
const height = Math.max(1, Math.round(numberFlag("--height", Number(process.env.BIRDSEYE_MONTAGE_HEIGHT ?? 720))));
const samples = Math.max(1, Math.round(numberFlag("--samples", Number(process.env.BIRDSEYE_MONTAGE_SAMPLES ?? 24))));
const maxSecondsPerReplay = optionalPositiveNumberFlag("--max-seconds-per-replay");
const blender = flag("--blender") ?? process.env.BLENDER ?? "blender";
const bundledFfmpeg = "/usr/local/opt/ffmpeg-full/bin/ffmpeg";
const ffmpeg = flag("--ffmpeg") ?? process.env.FFMPEG_BIN ?? (existsSync(bundledFfmpeg) ? bundledFfmpeg : "ffmpeg");
const timelineOnly = argv.includes("--timeline-only");
const renderOnly = argv.includes("--render-only");
const force = argv.includes("--force");
const allowFallbackAirframe = argv.includes("--allow-fallback-airframe");
const rendererScript = resolve(repoRoot, "tools/blender/render_native_flight.py");

async function main(): Promise<void> {
  const entries = parseCompendiumReplayEntries(await readFile(compendiumPath, "utf8"));
  if (entries.length === 0) throw new Error(`no replay table entries found in ${compendiumPath}`);

  await mkdir(outDir, { recursive: true });
  const manifestEntries: ManifestEntry[] = [];

  if (!timelineOnly) {
    assertCommandAvailable(blender, ["--version"], "Blender");
    assertCommandAvailable(ffmpeg, ["-version"], "ffmpeg");
  }

  for (const entry of entries) {
    const replayFile = resolve(entry.replayPath);
    const replay = MatchReplaySchema.parse(JSON.parse(await readFile(replayFile, "utf8")));
    const pilotId = resolvePilotId(replay, pilotIdFlag);
    assertRecordedAirframes(replay, entry.replayPath);
    const durationSeconds = replayDurationSeconds(replay);
    const renderedSeconds = Math.min(durationSeconds, maxSecondsPerReplay ?? durationSeconds);
    const slug = `${String(entry.index).padStart(2, "0")}-${safeSlug(entry.stage || basename(entry.replayPath))}`;
    const timelinePath = resolve(outDir, `${slug}.birdseye.timeline.json`);
    const rawVideo = resolve(outDir, `${slug}.raw.mp4`);
    const labeledVideo = resolve(outDir, `${slug}.mp4`);
    const framesDir = resolve(outDir, `${slug}.frames`);
    const labelPath = resolve(outDir, `${slug}.label.txt`);

    const timeline = buildNativeRenderTimeline(replay, {
      fps,
      seconds: renderedSeconds,
      width,
      height,
      pilotId,
      cameraMode: "birdseye",
      loop: false,
    });

    await writeFile(timelinePath, `${JSON.stringify(timeline, null, 2)}\n`);
    await writeFile(labelPath, montageLabel(entry, renderedSeconds, durationSeconds));
    console.error(
      `birdseye ${entry.index}/${entries.length}: ${entry.stage} ` +
        `(${renderedSeconds.toFixed(1)}s of ${durationSeconds.toFixed(1)}s) -> ${relative(repoRoot, timelinePath)}`,
    );

    if (!timelineOnly) {
      if (force || !(await fileExists(rawVideo))) {
        await run(blender, [
          "-b",
          "--python",
          rendererScript,
          "--",
          "--timeline",
          timelinePath,
          "--out",
          rawVideo,
          "--frames-dir",
          framesDir,
          "--samples",
          String(samples),
        ]);
      }

      if (force || !(await fileExists(labeledVideo))) {
        await run(ffmpeg, [
          "-y",
          "-i",
          rawVideo,
          "-vf",
          labelFilter(labelPath),
          "-c:v",
          "libx264",
          "-pix_fmt",
          "yuv420p",
          "-movflags",
          "+faststart",
          labeledVideo,
        ]);
      }
    }

    manifestEntries.push({
      ...entry,
      durationSeconds,
      renderedSeconds,
      pilotId,
      aircraftIds: replay.frames[0]?.aircraft.map((ship) => ship.id) ?? [],
      airframeIds: Object.keys(replay.airframes ?? {}),
      timeline: relative(repoRoot, timelinePath),
      ...(!timelineOnly
        ? {
            rawVideo: relative(repoRoot, rawVideo),
            labeledVideo: relative(repoRoot, labeledVideo),
          }
        : {}),
    });
  }

  if (!timelineOnly && !renderOnly) {
    const concatPath = resolve(outDir, "concat.txt");
    await writeFile(
      concatPath,
      manifestEntries.map((entry) => `file '${escapeConcatPath(resolve(repoRoot, entry.labeledVideo ?? ""))}'`).join("\n") + "\n",
    );
    await run(ffmpeg, ["-y", "-f", "concat", "-safe", "0", "-i", concatPath, "-c", "copy", out]);
  }

  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        compendium: relative(repoRoot, compendiumPath),
        cameraMode: "birdseye",
        pilotId: pilotIdFlag,
        fps,
        width,
        height,
        samples,
        maxSecondsPerReplay: maxSecondsPerReplay ?? null,
        output: timelineOnly || renderOnly ? null : relative(repoRoot, out),
        entries: manifestEntries,
      },
      null,
      2,
    )}\n`,
  );

  console.error(`manifest -> ${relative(repoRoot, manifestPath)}`);
  if (!timelineOnly && !renderOnly) console.error(`montage -> ${relative(repoRoot, out)}`);
}

function parseCompendiumReplayEntries(markdown: string): CompendiumReplayEntry[] {
  const entries: CompendiumReplayEntry[] = [];
  const rowPattern = /^\|\s*(\d+)\s*\|\s*([^|]+?)\s*\|\s*`([^`]+\.json)`\s*\|\s*([^|]+?)\s*\|/gm;
  let match: RegExpExecArray | null;
  while ((match = rowPattern.exec(markdown))) {
    entries.push({
      index: Number(match[1]),
      localTime: match[2].trim(),
      replayPath: match[3].trim(),
      stage: match[4].trim(),
    });
  }
  return entries.sort((a, b) => a.index - b.index);
}

function replayDurationSeconds(replay: MatchReplay): number {
  return Math.max(replay.frameDt, (replay.frames.length - 1) * replay.frameDt);
}

function resolvePilotId(replay: MatchReplay, requested: string): string {
  const aircraft = replay.frames[0]?.aircraft ?? [];
  if (aircraft.some((ship) => ship.id === requested)) return requested;
  return aircraft.find((ship) => ship.team === "blue" && !ship.static)?.id ?? aircraft.find((ship) => !ship.static)?.id ?? aircraft[0]?.id ?? requested;
}

function assertRecordedAirframes(replay: MatchReplay, replayPath: string): void {
  if (allowFallbackAirframe) return;
  const airframes = replay.airframes ?? {};
  const missing = (replay.frames[0]?.aircraft ?? [])
    .filter((ship) => !ship.static)
    .map((ship) => ship.id)
    .filter((id) => !airframes[id]);
  if (missing.length > 0) {
    throw new Error(
      `${replayPath} is missing recorded airframe geometry for ${missing.join(", ")}. ` +
        "Pass --allow-fallback-airframe to render with default geometry.",
    );
  }
}

function montageLabel(entry: CompendiumReplayEntry, renderedSeconds: number, durationSeconds: number): string {
  const duration =
    renderedSeconds + 1e-6 < durationSeconds
      ? `${renderedSeconds.toFixed(1)}s excerpt / ${durationSeconds.toFixed(1)}s replay`
      : `${durationSeconds.toFixed(1)}s replay`;
  return `#${entry.index} ${entry.localTime}  |  ${entry.stage}\n${entry.replayPath}  |  ${duration}\n`;
}

function labelFilter(labelPath: string): string {
  return [
    "drawbox=x=0:y=0:w=iw:h=78:color=black@0.50:t=fill",
    `drawtext=fontcolor=white:fontsize=22:x=24:y=15:line_spacing=7:textfile='${escapeFilterPath(labelPath)}'`,
  ].join(",");
}

function safeSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function escapeFilterPath(path: string): string {
  return path.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function escapeConcatPath(path: string): string {
  return path.replace(/'/g, "'\\''");
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function assertCommandAvailable(command: string, args: string[], label: string): void {
  const probe = spawnSync(command, args, { stdio: "ignore" });
  if (probe.error) throw new Error(`${label} was not found at "${command}"`);
  if (typeof probe.status === "number" && probe.status !== 0) throw new Error(`${label} probe exited ${probe.status}`);
}

async function run(command: string, args: string[]): Promise<void> {
  const child = spawn(command, args, { stdio: "inherit" });
  const [code] = (await once(child, "close")) as [number];
  if (code !== 0) throw new Error(`${command} exited ${code}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
