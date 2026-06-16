import type {
  BodyExpectation,
  BodyMuscleCommand,
  BodyParsedOutput,
  BodySolution,
  BodyTone,
} from "../protocol/schema";
import type { BodyManifest } from "./manifest";

const FIELD_RE = /([A-Z]+)\s*=\s*([^\s]+)/gi;

function lineWith(lines: string[], prefix: string): string | undefined {
  const wanted = prefix.toLowerCase();
  return lines.find((line) => line.trim().toLowerCase().startsWith(wanted));
}

function fields(line: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of line.matchAll(FIELD_RE)) {
    out[match[1].toUpperCase()] = match[2];
  }
  return out;
}

function parseIntField(
  raw: string | undefined,
  name: string,
  min: number,
  max: number,
  errors: string[],
): { value?: number; clipped: boolean } {
  if (raw === undefined) {
    errors.push(`missing ${name}`);
    return { clipped: false };
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    errors.push(`invalid ${name}`);
    return { clipped: false };
  }
  let value = n;
  let clipped = false;
  if (!Number.isInteger(value)) {
    value = Math.round(value);
    clipped = true;
    errors.push(`rounded ${name}`);
  }
  if (value < min || value > max) {
    value = Math.max(min, Math.min(max, value));
    clipped = true;
    errors.push(`clipped ${name}`);
  }
  return { value, clipped };
}

function muscleRange(manifest: BodyManifest, name: "ROLL" | "PITCH" | "YAW" | "PUSH"): [number, number] {
  const channel = manifest.muscles[name];
  return channel ? [channel.range[0], channel.range[1]] : name === "PUSH" ? [0, 5] : [-5, 5];
}

function parseMuscle(line: string | undefined, manifest: BodyManifest, errors: string[]) {
  if (!line) {
    errors.push("missing MUSCLE");
    return { clipped: false };
  }
  const f = fields(line);
  const roll = parseIntField(f.ROLL, "ROLL", ...muscleRange(manifest, "ROLL"), errors);
  const pitch = parseIntField(f.PITCH, "PITCH", ...muscleRange(manifest, "PITCH"), errors);
  const yaw = parseIntField(f.YAW, "YAW", ...muscleRange(manifest, "YAW"), errors);
  const push = parseIntField(f.PUSH, "PUSH", ...muscleRange(manifest, "PUSH"), errors);
  const missing = [roll, pitch, yaw, push].some((field) => field.value === undefined);
  if (missing) return { clipped: roll.clipped || pitch.clipped || yaw.clipped || push.clipped };
  return {
    muscle: {
      roll: roll.value!,
      pitch: pitch.value!,
      yaw: yaw.value!,
      push: push.value!,
    } satisfies BodyMuscleCommand,
    clipped: roll.clipped || pitch.clipped || yaw.clipped || push.clipped,
  };
}

function parseTone(line: string | undefined, errors: string[]): BodyTone | undefined {
  if (!line) {
    errors.push("missing TONE");
    return undefined;
  }
  const [, rawMode, rawIntensity] = /^TONE\s+(\S+)\s+(\S+)/i.exec(line.trim()) ?? [];
  const modes = ["hold", "pulse", "brace", "relax", "reverse"] as const;
  const mode = modes.find((candidate) => candidate === rawMode?.toLowerCase());
  if (!mode) {
    errors.push("invalid TONE mode");
    return undefined;
  }
  const intensity = parseIntField(rawIntensity, "TONE intensity", 0, 3, errors);
  if (intensity.value === undefined) return undefined;
  return { mode, intensity: intensity.value };
}

function parseExpect(line: string | undefined, errors: string[]): BodyExpectation | undefined {
  if (!line) {
    errors.push("missing EXPECT");
    return undefined;
  }
  const f = fields(line);
  const missing = ["ROLL", "PITCH", "SPEED", "MARGIN"].filter((name) => !f[name]);
  if (missing.length > 0) {
    errors.push(`missing EXPECT ${missing.join(",")}`);
    return undefined;
  }
  return {
    roll: f.ROLL,
    pitch: f.PITCH,
    speed: f.SPEED,
    margin: f.MARGIN,
  };
}

// SOLUTION <cold|warming|hot|now> — the Body's felt firing readiness, read from its glyph-field (the
// target glyph against the boresight reticle). Optional: a Body that omits it (or emits garbage) simply
// reports no solution and never calls a shot. Not an error to omit — it is an aiming verb, not a law.
function parseSolution(line: string | undefined): BodySolution | undefined {
  if (!line) return undefined;
  const [, raw] = /^SOLUTION\s+(\S+)/i.exec(line.trim()) ?? [];
  const levels = ["cold", "warming", "hot", "now"] as const;
  return levels.find((candidate) => candidate === raw?.toLowerCase());
}

function parseRest(line: string | undefined, keyword: string, errors: string[], maxWords: number): string | undefined {
  if (!line) {
    errors.push(`missing ${keyword}`);
    return undefined;
  }
  const rest = line.trim().slice(keyword.length).trim();
  if (rest.length === 0) return undefined;
  const words = rest.split(/\s+/).filter(Boolean);
  if (words.length > maxWords) {
    errors.push(`${keyword} too long`);
    return words.slice(0, maxWords).join(" ");
  }
  return rest;
}

export function parseBodyOutput(raw: string, manifest: BodyManifest): BodyParsedOutput {
  const errors: string[] = [];
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const muscleLine = lineWith(lines, "MUSCLE");
  const toneLine = lineWith(lines, "TONE");
  const expectLine = lineWith(lines, "EXPECT");
  const feelLine = lineWith(lines, "FEEL");
  const memLine = lineWith(lines, "MEM");
  const solutionLine = lineWith(lines, "SOLUTION");

  const parsedMuscle = parseMuscle(muscleLine, manifest, errors);
  const tone = parseTone(toneLine, errors);
  const expect = parseExpect(expectLine, errors);
  const feel = parseRest(feelLine, "FEEL", errors, 12);
  const memory = parseRest(memLine, "MEM", errors, 7);
  const solution = parseSolution(solutionLine); // optional aiming verb — never an error to omit
  // SOLUTION is a recognized line (when present) so it is not flagged as chatter.
  const recognized = new Set(
    [muscleLine, toneLine, expectLine, feelLine, memLine, solutionLine].filter(Boolean),
  );
  const chatter = lines.filter((line) => !recognized.has(line)).join("\n");
  if (chatter) errors.push("body_chatter");

  if (!parsedMuscle.muscle) {
    return {
      status: "failed",
      errors,
      clipped: parsedMuscle.clipped,
      ...(solution ? { solution } : {}),
      ...(chatter ? { bodyChatter: chatter } : {}),
    };
  }

  const missingRequired = !tone || !expect;
  const missingEmbodiment = !feel || memory === undefined;
  const status = parsedMuscle.clipped ? "clipped" : missingRequired || missingEmbodiment ? "degraded" : "ok";

  return {
    status,
    muscle: parsedMuscle.muscle,
    ...(tone ? { tone } : {}),
    ...(expect ? { expect } : {}),
    ...(feel ? { feel } : {}),
    ...(memory !== undefined ? { memory } : {}),
    ...(solution ? { solution } : {}),
    errors,
    clipped: parsedMuscle.clipped,
    ...(chatter ? { bodyChatter: chatter } : {}),
  };
}

