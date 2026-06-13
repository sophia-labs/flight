import { z } from "zod";

export const Vec3Schema = z.object({
  x: z.number(),
  y: z.number(),
  z: z.number(),
});

export const QuaternionSchema = z.object({
  x: z.number(),
  y: z.number(),
  z: z.number(),
  w: z.number(),
});

export const ControlInputSchema = z.object({
  pitch: z.number().min(-1).max(1),
  roll: z.number().min(-1).max(1),
  yaw: z.number().min(-1).max(1),
  throttle: z.number().min(0).max(1),
  trigger: z.boolean(),
});

export const AircraftSnapshotSchema = z.object({
  id: z.string(),
  callsign: z.string(),
  team: z.enum(["blue", "red"]),
  color: z.string(),
  position: Vec3Schema,
  velocity: Vec3Schema,
  orientation: QuaternionSchema,
  controls: ControlInputSchema,
  airspeed: z.number(),
  altitude: z.number(),
  aoaDeg: z.number(),
  gLoad: z.number(),
  health: z.number(),
  weaponCooldown: z.number(),
  stalled: z.boolean(),
});

export const ReplayEventSchema = z.object({
  type: z.enum(["shot", "hit", "miss", "terrain"]),
  message: z.string(),
  actorId: z.string().optional(),
  targetId: z.string().optional(),
  origin: Vec3Schema.optional(),
  impact: Vec3Schema.optional(),
});

export const ReplayFrameSchema = z.object({
  index: z.number().int().nonnegative(),
  time: z.number(),
  turn: z.number().int().nonnegative(),
  aircraft: z.array(AircraftSnapshotSchema),
  events: z.array(ReplayEventSchema),
});

// --- v0.2.0 agent contract: actions, observations, decisions, outcome ---

// StickCommand is the LLM's structured-output shape (no discriminator; `reason` first so the
// model commits to intent before numbers). The controller wraps it into a RawStickAction.
export const StickCommandSchema = z.object({
  reason: z.string(),
  pitch: z.number(),
  roll: z.number(),
  yaw: z.number(),
  throttle: z.number(),
  trigger: z.boolean(),
});

export const RawStickActionSchema = z.object({
  kind: z.literal("raw-stick"),
  pitch: z.number(),
  roll: z.number(),
  yaw: z.number(),
  throttle: z.number(),
  trigger: z.boolean(),
});

// A union from day one, so a maneuver-vocabulary variant is purely additive in 0.3.0.
export const ActionSchema = RawStickActionSchema;

export const SelfPerceptSchema = z.object({
  airspeed: z.number(),
  altitude: z.number(),
  aoaDeg: z.number(),
  gLoad: z.number(),
  health: z.number(),
  weaponCooldown: z.number(),
  stalled: z.boolean(),
});

// Ego-relative percept of one contact. The direction cosines are the dot products the
// scripted controllers used to take against the raw basis — pre-projected here so an agent
// never needs the omniscient world state.
export const ContactPerceptSchema = z.object({
  id: z.string(),
  team: z.enum(["blue", "red"]),
  range: z.number(),
  bearingForward: z.number(), // cos of angle to contact vs own nose; 1 = dead ahead
  bearingRight: z.number(), // + = contact is to the right
  bearingUp: z.number(), // + = contact is above
  closureRate: z.number(), // range rate along the line of sight: + = opening, - = closing
  health: z.number(),
});

export const ObservationSchema = z.object({
  schemaVersion: z.literal(1),
  selfId: z.string(),
  turn: z.number().int().nonnegative(),
  time: z.number(),
  self: SelfPerceptSchema,
  contacts: z.array(ContactPerceptSchema),
  text: z.string().optional(), // natural-language framing — reserved for 0.3.0
});

export const AgentMetaSchema = z.object({
  id: z.string(),
  kind: z.enum(["scripted", "llm"]),
  label: z.string(),
  config: z.record(z.string(), z.unknown()).optional(),
});

export const ScoreSchema = z.object({
  damageDealt: z.number(),
  damageTaken: z.number(),
  survived: z.boolean(),
});

export const MatchOutcomeSchema = z.object({
  resolved: z.boolean(),
  reason: z.enum(["destroyed", "timeout", "draw"]),
  winnerTeam: z.enum(["blue", "red"]).nullable(),
  turnsRun: z.number().int().nonnegative(),
  scores: z.record(z.string(), ScoreSchema), // keyed by team
  finalHealth: z.record(z.string(), z.number()), // keyed by aircraft id
});

export const TurnDecisionSchema = z.object({
  turn: z.number().int().nonnegative(),
  agentId: z.string(),
  observation: ObservationSchema,
  action: ActionSchema,
  controlInput: ControlInputSchema,
  source: z.enum(["controller", "fallback"]),
  rationale: z.string().optional(),
  latencyMs: z.number().optional(),
});

export const MatchReplaySchema = z.object({
  id: z.string(),
  turnDuration: z.number(),
  frameDt: z.number(),
  frames: z.array(ReplayFrameSchema).min(1),
  // All optional ⇒ v0.1.0 replays still validate and the viewer (reads only `frames`) is unchanged.
  schemaVersion: z.literal(2).optional(),
  agents: z.array(AgentMetaSchema).optional(),
  decisions: z.array(TurnDecisionSchema).optional(),
  outcome: MatchOutcomeSchema.optional(),
});

export type Vec3 = z.infer<typeof Vec3Schema>;
export type Quaternion = z.infer<typeof QuaternionSchema>;
export type ControlInput = z.infer<typeof ControlInputSchema>;
export type AircraftSnapshot = z.infer<typeof AircraftSnapshotSchema>;
export type ReplayEvent = z.infer<typeof ReplayEventSchema>;
export type ReplayFrame = z.infer<typeof ReplayFrameSchema>;
export type MatchReplay = z.infer<typeof MatchReplaySchema>;
export type StickCommand = z.infer<typeof StickCommandSchema>;
export type RawStickAction = z.infer<typeof RawStickActionSchema>;
export type Action = z.infer<typeof ActionSchema>;
export type SelfPercept = z.infer<typeof SelfPerceptSchema>;
export type ContactPercept = z.infer<typeof ContactPerceptSchema>;
export type Observation = z.infer<typeof ObservationSchema>;
export type AgentMeta = z.infer<typeof AgentMetaSchema>;
export type Score = z.infer<typeof ScoreSchema>;
export type MatchOutcome = z.infer<typeof MatchOutcomeSchema>;
export type TurnDecision = z.infer<typeof TurnDecisionSchema>;

export function clampControlInput(input: ControlInput): ControlInput {
  const clampSigned = (value: number) => Math.max(-1, Math.min(1, value));
  const clampUnit = (value: number) => Math.max(0, Math.min(1, value));

  return ControlInputSchema.parse({
    pitch: clampSigned(input.pitch),
    roll: clampSigned(input.roll),
    yaw: clampSigned(input.yaw),
    throttle: clampUnit(input.throttle),
    trigger: input.trigger,
  });
}
