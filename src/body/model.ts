import type { BodyProprioception, PilotIntentAction, Usage } from "../protocol/schema";
import type { BodyManifest } from "./manifest";

export interface BodyModelInput {
  manifest: BodyManifest;
  pilotIntent: PilotIntentAction;
  proprioception: BodyProprioception;
  memory?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export type BodyModelResult =
  | string
  | {
      output: string;
      usage?: Usage;
      raw?: unknown;
    };

export type BodyModel = (input: BodyModelInput) => Promise<BodyModelResult>;

// FIELD-FEED: the scripted Body no longer reads a `target` token — it reads the camera-ascii@2
// glyph-field's legend. Each in-view contact is a line ` <id>  <h> o'clock <elev>  rng <m>  <aspect>-<L|R>  hp <n>`.
// We pick the nearest contact (the legend lists by range order from the encoder is not guaranteed, so
// scan all) and derive the steer side from its bearing. Pure string parsing — deterministic.
const CONTACT_LINE = /\b(\d{1,2}) o'clock\b.*?\brng (\d+)\b.*?-([LR])\b/;

interface FieldContact {
  clock: number;
  rangeM: number;
  side: "L" | "R";
}

function parseFieldContacts(field: string): FieldContact[] {
  const out: FieldContact[] = [];
  for (const line of field.split("\n")) {
    const m = CONTACT_LINE.exec(line);
    if (m) out.push({ clock: Number(m[1]), rangeM: Number(m[2]), side: m[3] as "L" | "R" });
  }
  return out;
}

function nearestContact(field: string): FieldContact | undefined {
  return parseFieldContacts(field).sort((a, b) => a.rangeM - b.rangeM)[0];
}

// Steer side toward the nearest contact: left (-1) / right (+1) / centred (0). A contact on the nose
// (12 o'clock, or 11/1 with the L/R side already telling us the lean) reads centred when dead-ahead.
function targetSide(contact: FieldContact | undefined): number {
  if (!contact) return 0;
  if (contact.clock === 12) return 0;
  return contact.side === "L" ? -1 : 1;
}

// "Ahead" = the contact is within the forward arc (10–2 o'clock). Replaces the old `ahead` substring.
function contactAhead(contact: FieldContact | undefined): boolean {
  if (!contact) return false;
  return contact.clock === 12 || contact.clock === 11 || contact.clock === 1;
}

// FIELD-FEED: vision is FOV-limited, so the contact often leaves frame. We remember which way it last
// sat (a `search_left`/`search_right` token in MEM) and keep a gentle turn that way to re-acquire,
// rather than drifting dead-straight forever as a target-token-less Body otherwise would.
function searchSideFromMemory(memory: string | undefined): number {
  if (!memory) return 0;
  if (memory.includes("search_left")) return -1;
  if (memory.includes("search_right")) return 1;
  return 0;
}

function searchToken(side: number): string {
  return side < 0 ? "search_left" : side > 0 ? "search_right" : "";
}

function bankedToward(attitude: string, side: number) {
  if (side < 0) return attitude.includes("left_bank");
  if (side > 0) return attitude.includes("right_bank");
  return true;
}

function expectedRoll(roll: number) {
  if (roll <= -4) return "left++";
  if (roll < 0) return "left+";
  if (roll >= 4) return "right++";
  if (roll > 0) return "right+";
  return "stable";
}

function expectedPitch(pitch: number) {
  if (pitch <= -3) return "down";
  if (pitch >= 3) return "up";
  if (pitch > 0) return "up";
  if (pitch < 0) return "down";
  return "stable";
}

export const scriptedFixedWingBodyModel: BodyModel = async ({ pilotIntent, proprioception, memory }) => {
  const target = nearestContact(proprioception.field);
  const seenSide = targetSide(target);
  // When a contact is in view, steer toward it AND remember the direction; when it has left the FOV,
  // keep a search turn in the last-seen direction so we circle back to re-acquire it.
  const searchSide = seenSide === 0 ? searchSideFromMemory(memory) : seenSide;
  const side = seenSide;
  const dangerousMargin =
    proprioception.stallMargin === "stalled" ||
    proprioception.stallMargin === "buffet" ||
    proprioception.stallMargin === "thin";
  const lowEnergy = proprioception.energy === "dead" || proprioception.energy === "low";
  const groundPanic = proprioception.pain.groundRush >= 4;
  const canPull = proprioception.affordances.includes("can_pull_gently");
  const alreadyBankedToward = bankedToward(proprioception.attitude, side);
  const risk = pilotIntent.riskTolerance;
  const turnGain = dangerousMargin ? 2 : risk > 0.7 ? 5 : 4;

  let roll = side === 0 ? 0 : side * turnGain;
  let pitch = 0;
  let yaw = side === 0 ? 0 : side * (dangerousMargin ? 1 : 2);
  let push = lowEnergy || dangerousMargin ? 5 : 4;
  let tone: "hold" | "pulse" | "brace" | "relax" | "reverse" = "hold";
  let toneLevel = 1;
  let feel = "holding shape while I feel the air";
  // Carry the search direction forward so a lost contact keeps the turn alive across blind ticks.
  let nextMemory = searchSide !== 0 ? searchToken(searchSide) : memory ?? "";

  if (dangerousMargin || lowEnergy) {
    pitch = groundPanic ? 1 : -3;
    roll = side === 0 ? 0 : side * 2;
    yaw = side === 0 ? 0 : side;
    push = 5;
    tone = "brace";
    toneLevel = dangerousMargin ? 3 : 2;
    feel = groundPanic ? "low and mushy, pulling only enough" : "unloading before the wing stops listening";
    nextMemory = "unload wait_pull";
  } else if (groundPanic) {
    pitch = 4;
    roll = side === 0 ? 0 : side * 2;
    yaw = 0;
    push = 5;
    tone = "brace";
    toneLevel = 3;
    feel = "ground is loud, lifting with care";
    nextMemory = "ground lift_care";
  } else if (side !== 0 && alreadyBankedToward && canPull) {
    pitch = pilotIntent.urgency > 0.7 ? 3 : 2;
    push = 4;
    tone = "pulse";
    toneLevel = 2;
    feel = "bank is set, taking a careful bite";
    nextMemory = `${side < 0 ? "left_turn bite" : "right_turn bite"} ${searchToken(side)}`;
  } else if (side !== 0) {
    pitch = -1;
    push = 5;
    tone = "brace";
    toneLevel = 1;
    feel = side < 0 ? "rolling left before I pull" : "rolling right before I pull";
    nextMemory = `${side < 0 ? "left_turn stage" : "right_turn stage"} ${searchToken(side)}`;
  } else if (contactAhead(target) && canPull) {
    pitch = 1;
    push = 4;
    feel = "target ahead, keeping the nose fed";
    nextMemory = "lineup hold";
  } else if (searchSide !== 0) {
    // Lost the contact out of frame: hold a gentle banked search in the last-seen direction.
    roll = searchSide * (canPull ? 3 : 2);
    yaw = searchSide;
    push = 4;
    tone = "hold";
    toneLevel = 1;
    feel = searchSide < 0 ? "lost it left, circling back" : "lost it right, circling back";
    nextMemory = searchToken(searchSide);
  }

  const speedExpect = pitch < 0 && push >= 4 ? "recover" : push <= 2 ? "bleed" : "stable";
  const marginExpect = dangerousMargin || pitch < 0 ? "better" : "stable";

  return [
    `MUSCLE ROLL=${roll} PITCH=${pitch} YAW=${yaw} PUSH=${push}`,
    `TONE ${tone} ${toneLevel}`,
    `EXPECT ROLL=${expectedRoll(roll)} PITCH=${expectedPitch(pitch)} SPEED=${speedExpect} MARGIN=${marginExpect}`,
    `FEEL ${feel}`,
    `MEM ${nextMemory}`.trim(),
  ].join("\n");
};
