// Prepare an offline art-render package from an authoritative replay.
//
// The source replay remains evidence. This script writes a separate adapted replay that keeps the flown
// trajectory, decisions, events, and projectiles, but renders the pilot aircraft through the Super Tomcat
// airframe with inferred Tomcat telemetry for native Blender.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { aircraftArchetypes } from "../sim/aircraftCatalog";
import { densityAtAltitude, dynamicPressure, machAtSpeed } from "../sim/aero";
import {
  MatchReplaySchema,
  type AircraftSnapshot,
  type MatchReplay,
  type Part,
  type SurfaceControlSnapshot,
  type WingPart,
} from "../protocol/schema";
import {
  buildNativeRenderTimeline,
  type NativeCameraMode,
  type NativeRenderSubtitle,
  type NativeRenderTimeline,
} from "../render/nativeTimeline";
import { deriveSurfaceControls } from "../viewer/surfaceTelemetry";

const argv = process.argv.slice(2);
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
  if (!Number.isFinite(value)) throw new Error(`${name} must be finite`);
  return value;
}

function cameraMode(value: string): NativeCameraMode {
  if (
    value === "pilot-cinema" ||
    value === "pilot-hero" ||
    value === "split-balloon" ||
    value === "split-dogfight" ||
    value === "cinematic" ||
    value === "cockpit" ||
    value === "director" ||
    value === "chase" ||
    value === "orbit"
  ) {
    return value;
  }
  throw new Error(`unsupported camera mode: ${value}`);
}

const replayPath = resolve(flag("--replay") ?? "reports/coach/missile.json");
const outDir = resolve(flag("--out-dir") ?? "clips/tomcat-artpiece");
const pilotId = flag("--pilot-id") ?? "blue-1";
const seconds = numberFlag("--seconds", 18);
const fps = numberFlag("--fps", 24);
const width = Math.max(1, Math.round(numberFlag("--width", 1280)));
const height = Math.max(1, Math.round(numberFlag("--height", 720)));
const avatarPath = resolve(flag("--avatar") ?? "public/models/VRM1_Constraint_Twist_Sample.vrm");
const modes = (flag("--modes") ?? "pilot-hero,split-balloon,cinematic,director").split(",").map((m) => cameraMode(m.trim()));
const sampleFps = numberFlag("--sample-fps", 12);
const sampleWidth = Math.max(1, Math.round(numberFlag("--sample-width", 960)));
const sampleHeight = Math.max(1, Math.round(numberFlag("--sample-height", 540)));

interface SampleCutSpec {
  name: string;
  mode: NativeCameraMode;
  start: number;
  duration: number;
  description: string;
}

const SAMPLE_CUTS: SampleCutSpec[] = [
  {
    name: "director-jet-open",
    mode: "director",
    start: 0,
    duration: 3,
    description: "Immediate exterior Tomcat opening shot; the aircraft is the first image.",
  },
  {
    name: "director-wing-glide",
    mode: "director",
    start: 5.8,
    duration: 3,
    description: "Air-to-air underside wing-glide probe that keeps terrain out of the dominant frame.",
  },
  {
    name: "director-rail-launch",
    mode: "director",
    start: 9.85,
    duration: 2.2,
    description: "External rail-launch beat that keeps the Tomcat visible as the missile enters the fight.",
  },
  {
    name: "director-missile-chase",
    mode: "director",
    start: 12.2,
    duration: 3.25,
    description: "Missile-mounted chase camera with sky-backed motion and late target commitment.",
  },
  {
    name: "opening-hero",
    mode: "pilot-hero",
    start: 0,
    duration: 4,
    description: "VRM pilot/canopy opening with planner subtitle.",
  },
  {
    name: "launch-split",
    mode: "split-balloon",
    start: 9.85,
    duration: 3.75,
    description: "Split cockpit/exterior launch beat with AIM-9M trail.",
  },
  {
    name: "missile-chase",
    mode: "split-balloon",
    start: 12.65,
    duration: 3.45,
    description: "Held split-screen missile chase, with the cockpit body held against the long exterior arc.",
  },
  {
    name: "kill-cinematic",
    mode: "cinematic",
    start: 15.15,
    duration: 2.85,
    description: "Cinematic terminal approach beat with planner subtitle.",
  },
];

async function main(): Promise<void> {
  const source = MatchReplaySchema.parse(JSON.parse(readFileSync(replayPath, "utf8")));
  const adapted = adaptReplayAsTomcat(source, pilotId);
  await mkdir(outDir, { recursive: true });

  const adaptedReplayPath = resolve(outDir, "missile-as-tomcat.replay.json");
  await writeJson(adaptedReplayPath, adapted);

  const timelinePaths: Record<string, string> = {};
  const timelines: Partial<Record<NativeCameraMode, NativeRenderTimeline>> = {};
  for (const mode of modes) {
    const timeline = buildNativeRenderTimeline(adapted, {
      fps,
      seconds,
      width,
      height,
      pilotId,
      cameraMode: mode,
      avatarPath,
      loop: false,
    });
    const timelinePath = resolve(outDir, `missile-as-tomcat.${mode}.timeline.json`);
    await writeJson(timelinePath, timeline);
    timelinePaths[mode] = timelinePath;
    timelines[mode] = timeline;
    if (mode === "pilot-hero") {
      await writeFile(resolve(outDir, "thoughts.srt"), subtitlesToSrt(timeline.subtitles ?? []));
      await writeFile(resolve(outDir, "thoughts.txt"), narrationText(timeline.subtitles ?? []));
    }
  }

  const sampleArtifacts = await writeSamplePackage(timelines);
  const directorArtifact = await writeDirectorPackage(timelines);
  await writeFile(resolve(outDir, "score.mid"), buildMidiScore());
  await writeFile(
    resolve(outDir, "manifest.json"),
    `${JSON.stringify(manifest(source, adapted, timelinePaths, sampleArtifacts, directorArtifact), null, 2)}\n`,
  );
  await writeFile(resolve(outDir, "README.md"), readme(source, adapted, timelinePaths, sampleArtifacts, directorArtifact));
  console.error(`tomcat art package -> ${outDir}`);
}

function adaptReplayAsTomcat(source: MatchReplay, pilot: string): MatchReplay {
  const tomcat = aircraftArchetypes.find((candidate) => candidate.id === "variable-sweep-tomcat");
  if (!tomcat) throw new Error("missing variable-sweep-tomcat archetype");
  const tomcatAirframe = JSON.parse(JSON.stringify(tomcat.airframe));
  const adapted: MatchReplay = JSON.parse(JSON.stringify(source));
  adapted.id = `${source.id}|rendered-as-super-tomcat`;
  adapted.airframes = {
    ...(adapted.airframes ?? {}),
    [pilot]: tomcatAirframe,
  };

  for (const frame of adapted.frames) {
    frame.aircraft = frame.aircraft.map((ship) => (ship.id === pilot ? adaptAircraft(ship, tomcatAirframe.parts) : ship));
    frame.events = frame.events.map((event) => ({
      ...event,
      ...(event.message ? { message: event.message.replace(/\bBlue Kite\b/g, "Super Tomcat") } : {}),
    }));
  }
  return MatchReplaySchema.parse(adapted);
}

function adaptAircraft(ship: AircraftSnapshot, tomcatParts: Part[]): AircraftSnapshot {
  const mach = ship.mach ?? machAtSpeed(ship.airspeed, ship.altitude);
  const sweep = tomcatParts.find(isSweptWing)?.sweep;
  const sweepDeg = ship.sweepDeg ?? (sweep ? sweepForMach(sweep, mach) : undefined);
  const throttle = ship.controls.throttle;
  const afterburner = ship.afterburner === true || throttle >= 0.82;
  const engineSpool = ship.engineSpool ?? Math.max(0.56, Math.min(1, throttle * 0.92 + (afterburner ? 0.08 : 0)));
  const q = ship.dynamicPressurePa ?? dynamicPressure(densityAtAltitude(ship.altitude), ship.airspeed);
  return {
    ...ship,
    callsign: ship.callsign === "Blue Kite" ? "Super Tomcat" : ship.callsign,
    color: "#60717a",
    mach,
    dynamicPressurePa: q,
    ...(sweepDeg !== undefined ? { sweepDeg } : {}),
    afterburner,
    engineSpool,
    surfaceControls: tomcatSurfaceControls(tomcatParts, ship),
  };
}

function isSweptWing(part: Part): part is WingPart {
  return part.kind === "wing" && part.sweep !== undefined;
}

function sweepForMach(
  sweep: { minSweepDeg: number; maxSweepDeg: number; machForward: number; machSwept: number },
  mach: number,
): number {
  const span = Math.max(0.05, sweep.machSwept - sweep.machForward);
  const t = Math.max(0, Math.min(1, (mach - sweep.machForward) / span));
  return sweep.minSweepDeg + (sweep.maxSweepDeg - sweep.minSweepDeg) * t;
}

function tomcatSurfaceControls(
  parts: Part[],
  ship: AircraftSnapshot,
): SurfaceControlSnapshot[] {
  const measuredByAxis = new Map<string, SurfaceControlSnapshot[]>();
  for (const surface of ship.surfaceControls ?? []) {
    const list = measuredByAxis.get(surface.axis) ?? [];
    list.push(surface);
    measuredByAxis.set(surface.axis, list);
  }
  return deriveSurfaceControls(parts, ship.controls).map((surface) => {
    const measured = measuredByAxis.get(surface.axis)?.[0];
    return {
      ...surface,
      ...(measured?.localAoADeg !== undefined ? { localAoADeg: measured.localAoADeg } : {}),
      ...(measured?.totalAoADeg !== undefined ? { totalAoADeg: measured.totalAoADeg } : {}),
      ...(measured?.stallSeverity !== undefined ? { stallSeverity: measured.stallSeverity } : {}),
      ...(measured?.loadN !== undefined ? { loadN: measured.loadN } : {}),
    };
  });
}

interface SampleArtifact {
  name: string;
  mode: NativeCameraMode;
  description: string;
  durationSeconds: number;
  timeline: string;
  srt: string;
  ass: string;
  rawVideo: string;
  captionedVideo: string;
  preview: string;
}

interface DirectorArtifact {
  timeline: string;
  srt: string;
  ass: string;
  rawVideo: string;
  captionedVideo: string;
  finalVideo: string;
  preview: string;
  voiceoverText: string;
  voiceoverAudio: string;
  scoreBed: string;
  durationSeconds: number;
  width: number;
  height: number;
  fps: number;
}

async function writeSamplePackage(
  timelines: Partial<Record<NativeCameraMode, NativeRenderTimeline>>,
): Promise<SampleArtifact[]> {
  const samplesDir = resolve(outDir, "samples");
  await mkdir(samplesDir, { recursive: true });
  const artifacts: SampleArtifact[] = [];
  for (const cut of SAMPLE_CUTS) {
    const timeline = timelines[cut.mode];
    if (!timeline) continue;
    const cutTimeline = cutNativeTimeline(timeline, cut);
    const timelinePath = resolve(samplesDir, `${cut.name}.timeline.json`);
    const srtPath = resolve(samplesDir, `${cut.name}.srt`);
    const assPath = resolve(samplesDir, `${cut.name}.ass`);
    await writeJson(timelinePath, cutTimeline);
    await writeFile(srtPath, subtitlesToSrt(cutTimeline.subtitles ?? []));
    await writeFile(assPath, subtitlesToAss(cutTimeline.subtitles ?? [], cut.name.includes("split")));
    artifacts.push({
      name: cut.name,
      mode: cut.mode,
      description: cut.description,
      durationSeconds: cutTimeline.durationSeconds,
      timeline: relativeArtifact(timelinePath),
      srt: relativeArtifact(srtPath),
      ass: relativeArtifact(assPath),
      rawVideo: `samples/${cut.name}.raw.mp4`,
      captionedVideo: `samples/${cut.name}.captioned.mp4`,
      preview: `samples/${cut.name}-captioned-preview.png`,
    });
  }
  await writeFile(
    resolve(samplesDir, "reel-inputs.txt"),
    artifacts.map((artifact) => `file '${artifact.name}.captioned.mp4'`).join("\n") + "\n",
  );
  await writeFile(
    resolve(samplesDir, "reel-voiceover.txt"),
    [
      "Source says generic jet. Render says Tomcat.",
      "Sweep the wings from Mach. Light the cans.",
      "The missile crosses pale air, and the balloon waits.",
      "The chase is the proof the airframe never gave.",
    ].join("\n"),
  );
  return artifacts;
}

async function writeDirectorPackage(
  timelines: Partial<Record<NativeCameraMode, NativeRenderTimeline>>,
): Promise<DirectorArtifact | undefined> {
  const timeline = timelines.director;
  if (!timeline) return undefined;
  const directorDir = resolve(outDir, "director");
  await mkdir(directorDir, { recursive: true });
  const srtPath = resolve(directorDir, "tomcat-director.srt");
  const assPath = resolve(directorDir, "tomcat-director.ass");
  const voiceoverPath = resolve(directorDir, "tomcat-director-voiceover.txt");
  await writeFile(srtPath, subtitlesToSrt(timeline.subtitles ?? []));
  await writeFile(assPath, subtitlesToAss(timeline.subtitles ?? [], false, timeline.width, timeline.height, 78));
  await writeFile(
    voiceoverPath,
    [
      "A generic jet remembers itself as a Tomcat.",
      "The wings answer the Mach number. The engines answer the hand.",
      "At launch, the cockpit becomes a pressure vessel for a single decision.",
      "The missile carries the cut across the sky.",
      "The balloon is the last pink witness.",
    ].join("\n"),
  );
  return {
    timeline: "missile-as-tomcat.director.timeline.json",
    srt: relativeArtifact(srtPath),
    ass: relativeArtifact(assPath),
    rawVideo: "director/tomcat-director.raw.mp4",
    captionedVideo: "director/tomcat-director.captioned.mp4",
    finalVideo: "director/tomcat-director.final.mp4",
    preview: "director/tomcat-director-preview.png",
    voiceoverText: relativeArtifact(voiceoverPath),
    voiceoverAudio: "director/tomcat-director-voiceover.aiff",
    scoreBed: "director/tomcat-director-score.wav",
    durationSeconds: timeline.durationSeconds,
    width: timeline.width,
    height: timeline.height,
    fps: timeline.fps,
  };
}

function cutNativeTimeline(timeline: NativeRenderTimeline, cut: SampleCutSpec): NativeRenderTimeline {
  const end = cut.start + cut.duration;
  const sourceStep = Math.max(1, Math.round(timeline.fps / sampleFps));
  const frames = timeline.frames
    .filter((frame) => frame.time >= cut.start - 1e-6 && frame.time < end - 1e-6 && frame.index % sourceStep === 0)
    .map((frame, index) => ({
      ...frame,
      index,
      time: frame.time - cut.start,
      replayPosition: frame.replayPosition - cut.start,
    }));
  const subtitles = (timeline.subtitles ?? [])
    .map((subtitle) => ({
      ...subtitle,
      start: Math.max(0, subtitle.start - cut.start),
      end: Math.min(cut.duration, subtitle.end - cut.start),
    }))
    .filter((subtitle) => subtitle.end > 0 && subtitle.start < cut.duration && subtitle.end - subtitle.start > 0.15);
  return {
    ...timeline,
    fps: sampleFps,
    width: sampleWidth,
    height: sampleHeight,
    durationSeconds: frames.length / sampleFps,
    subtitles,
    frames,
  };
}

function subtitlesToAss(
  subtitles: NativeRenderSubtitle[],
  split: boolean,
  width = sampleWidth,
  height = sampleHeight,
  wrapWidth = split ? 48 : 54,
): string {
  const fontSize = split ? Math.max(18, Math.round(height * 0.041)) : Math.max(24, Math.round(height * 0.039));
  const marginV = split ? Math.max(24, Math.round(height * 0.045)) : Math.max(30, Math.round(height * 0.058));
  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Thought, Helvetica, ${fontSize}, &H00FFFBF8, &H00FFFFFF, &HAA080403, &H80000000, 0, 0, 0, 0, 100, 100, 0, 0, 1, 2, 0.8, 2, 42, 42, ${marginV}, 1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...subtitles.map(
      (subtitle) =>
        `Dialogue: 0,${assTime(subtitle.start)},${assTime(subtitle.end)},Thought,,0,0,0,,${escapeAss(
          wrapSubtitle(`${subtitle.label}: ${subtitle.text}`, wrapWidth),
        )}`,
    ),
    "",
  ].join("\n");
}

function wrapSubtitle(text: string, width: number): string {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const next = `${line} ${word}`.trim();
    if (next.length > width && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines.join("\\N");
}

function escapeAss(text: string): string {
  return text.replace(/[{}]/g, "").replace(/\n/g, "\\N");
}

function assTime(seconds: number): string {
  const centiseconds = Math.max(0, Math.round(seconds * 100));
  const h = Math.floor(centiseconds / 360_000);
  const m = Math.floor((centiseconds % 360_000) / 6_000);
  const s = Math.floor((centiseconds % 6_000) / 100);
  const cs = centiseconds % 100;
  return `${h}:${pad(m)}:${pad(s)}.${String(cs).padStart(2, "0")}`;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function relativeArtifact(path: string): string {
  return path.startsWith(`${outDir}/`) ? path.slice(outDir.length + 1) : path;
}

function subtitlesToSrt(subtitles: NativeRenderSubtitle[]): string {
  return subtitles
    .map((subtitle, index) =>
      [
        String(index + 1),
        `${srtTime(subtitle.start)} --> ${srtTime(subtitle.end)}`,
        `${subtitle.label}: ${subtitle.text}`,
        "",
      ].join("\n"),
    )
    .join("\n");
}

function srtTime(seconds: number): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const mm = ms % 1000;
  return `${pad(h)}:${pad(m)}:${pad(s)},${String(mm).padStart(3, "0")}`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function narrationText(subtitles: NativeRenderSubtitle[]): string {
  return subtitles.map((subtitle) => `${subtitle.label}. ${subtitle.text}`).join("\n");
}

function manifest(
  source: MatchReplay,
  adapted: MatchReplay,
  timelinePaths: Record<string, string>,
  sampleArtifacts: SampleArtifact[],
  directorArtifact: DirectorArtifact | undefined,
) {
  return {
    sourceReplay: replayPath,
    sourceReplayId: source.id,
    adaptedReplay: "missile-as-tomcat.replay.json",
    adaptedReplayId: adapted.id,
    pilotId,
    outDir,
    modes,
    timelinePaths,
    seconds,
    fps,
    width,
    height,
    note: "Same flown trajectory/events/projectiles as source replay; blue-1 is rendered through variable-sweep-tomcat.",
    tools: {
      blender: "/usr/local/bin/blender",
      ffmpegFull: "/usr/local/opt/ffmpeg-full/bin/ffmpeg",
      tts: "macOS say -v Samantha",
    },
    sampleArtifacts: {
      cuts: sampleArtifacts,
      sampleReel: "samples/tomcat-artpiece-sample-reel.mp4",
      reelPreview: "samples/tomcat-artpiece-sample-reel-preview.png",
      scoreMidi: "score.mid",
      scoreBed: "samples/reel-score-bed.wav",
      ttsNarration: "samples/reel-voiceover.aiff",
    },
    ...(directorArtifact ? { directorArtifact } : {}),
    verification: {
      sampleReel: {
        durationSeconds: Number(sampleArtifacts.reduce((total, artifact) => total + artifact.durationSeconds, 0).toFixed(6)),
        width: sampleWidth,
        height: sampleHeight,
        fps: `${sampleFps}/1`,
        videoCodec: "h264",
        audioCodec: "aac",
      },
      ffmpegFullFilters: ["ass", "subtitles", "drawtext"],
      ...(directorArtifact
        ? {
            directorRender: {
              durationSeconds: directorArtifact.durationSeconds,
              width: directorArtifact.width,
              height: directorArtifact.height,
              fps: `${directorArtifact.fps}/1`,
              videoCodec: "h264",
              audioCodec: "aac",
            },
          }
        : {}),
    },
  };
}

function readme(
  source: MatchReplay,
  adapted: MatchReplay,
  timelinePaths: Record<string, string>,
  sampleArtifacts: SampleArtifact[],
  directorArtifact: DirectorArtifact | undefined,
): string {
  const shot = adapted.frames.flatMap((frame) => frame.events.map((event) => ({ time: frame.time, ...event })));
  return [
    "# Tomcat Artpiece Render Package",
    "",
    "This folder is an adaptation package, not the source evidence.",
    "",
    `Source replay: \`${replayPath}\``,
    `Source id: \`${source.id}\``,
    `Adapted id: \`${adapted.id}\``,
    "",
    "## Render Contract",
    "",
    "- Blue pilot trajectory, decisions, events, and projectile telemetry are preserved.",
    "- Blue pilot airframe is replaced with `variable-sweep-tomcat` for rendering.",
    "- Mach, dynamic pressure, sweep, afterburner, and engine spool are inferred when missing.",
    "- Subtitles come from planner rationale in the replay.",
    "- Caption burn-in uses `/usr/local/opt/ffmpeg-full/bin/ffmpeg` because the regular Homebrew ffmpeg is intentionally built without libass/drawtext.",
    "",
    "## Timelines",
    "",
    ...Object.entries(timelinePaths).map(([mode, path]) => `- ${mode}: \`${path}\``),
    "",
    "## Sample Cuts",
    "",
    ...sampleArtifacts.map((artifact) => `- \`${artifact.captionedVideo}\`: ${artifact.description}`),
    "- `samples/tomcat-artpiece-sample-reel.mp4`: H.264/AAC reel combining the captioned cuts, local TTS narration, and generated score bed.",
    "- `score.mid`: composed MIDI source motif for the package.",
    "- `samples/reel-score-bed.wav`: generated audible drone/pulse score bed.",
    "- `samples/reel-voiceover.aiff`: local TTS narration generated from `samples/reel-voiceover.txt`.",
    ...(directorArtifact
      ? [
          "",
          "## Director Render",
          "",
          `- \`${directorArtifact.finalVideo}\`: full end-to-end director render with moving camera, burn-in subtitles, local TTS, and generated score bed.`,
          `- \`${directorArtifact.rawVideo}\`: raw Blender render before caption/audio finishing.`,
          `- \`${directorArtifact.ass}\`: full-resolution ASS subtitle file.`,
          `- \`${directorArtifact.voiceoverText}\`: local TTS script.`,
        ]
      : []),
    "",
    "## Rebuild Commands",
    "",
    "```bash",
    "npx tsx src/headless/tomcatArtpiece.ts --replay reports/coach/missile.json --out-dir clips/tomcat-artpiece --seconds 18 --fps 24 --width 1920 --height 1080 --modes pilot-hero,split-balloon,cinematic,director",
    "/usr/local/bin/blender -b --python tools/blender/render_native_flight.py -- --timeline clips/tomcat-artpiece/samples/opening-hero.timeline.json --out clips/tomcat-artpiece/samples/opening-hero.raw.mp4 --frames-dir clips/tomcat-artpiece/samples/opening-hero.frames --samples 32",
    "/usr/local/opt/ffmpeg-full/bin/ffmpeg -y -i clips/tomcat-artpiece/samples/opening-hero.raw.mp4 -vf ass=filename=clips/tomcat-artpiece/samples/opening-hero.ass -c:v libx264 -pix_fmt yuv420p -movflags +faststart clips/tomcat-artpiece/samples/opening-hero.captioned.mp4",
    "/usr/local/bin/blender -b --python tools/blender/render_native_flight.py -- --timeline clips/tomcat-artpiece/missile-as-tomcat.director.timeline.json --out clips/tomcat-artpiece/director/tomcat-director.raw.mp4 --frames-dir clips/tomcat-artpiece/director/tomcat-director.frames --samples 64",
    "/usr/local/opt/ffmpeg-full/bin/ffmpeg -y -i clips/tomcat-artpiece/director/tomcat-director.raw.mp4 -vf ass=filename=clips/tomcat-artpiece/director/tomcat-director.ass -c:v libx264 -pix_fmt yuv420p -movflags +faststart clips/tomcat-artpiece/director/tomcat-director.captioned.mp4",
    "```",
    "",
    "## Beats",
    "",
    ...shot.map((event) => `- ${event.time.toFixed(2)}s ${event.type}: ${event.message}`),
    "",
  ].join("\n");
}

function buildMidiScore(): Buffer {
  const tpq = 480;
  const events: number[] = [];
  const push = (...bytes: number[]) => events.push(...bytes);
  const delta = (ticks: number) => push(...vlq(ticks));
  delta(0);
  push(0xff, 0x51, 0x03, 0x0b, 0x71, 0xb0); // 80 BPM
  delta(0);
  push(0xc0, 88); // pad
  delta(0);
  push(0xc1, 48); // strings
  delta(0);
  push(0xc2, 81); // lead

  const chords = [
    [45, 52, 57, 64],
    [43, 50, 55, 62],
    [40, 47, 52, 59],
    [38, 45, 50, 57],
  ];
  let first = true;
  for (let bar = 0; bar < 8; bar += 1) {
    const chord = chords[bar % chords.length];
    for (const note of chord) {
      delta(first ? 0 : 0);
      first = false;
      push(0x90, note, 44);
    }
    delta(tpq * 3);
    push(0x92, 69 + (bar % 3), 68);
    delta(tpq);
    push(0x82, 69 + (bar % 3), 0);
    for (const note of chord) {
      delta(0);
      push(0x80, note, 0);
    }
  }
  delta(0);
  push(0xff, 0x2f, 0x00);

  const header = Buffer.from([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, tpq >> 8, tpq & 0xff]);
  const body = Buffer.from(events);
  const trackHeader = Buffer.alloc(8);
  trackHeader.write("MTrk", 0, "ascii");
  trackHeader.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, trackHeader, body]);
}

function vlq(value: number): number[] {
  let buffer = value & 0x7f;
  const bytes = [];
  while ((value >>= 7)) {
    buffer <<= 8;
    buffer |= (value & 0x7f) | 0x80;
  }
  while (true) {
    bytes.push(buffer & 0xff);
    if (buffer & 0x80) buffer >>= 8;
    else break;
  }
  return bytes;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
