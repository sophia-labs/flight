import { z } from "zod";

// A number that must be real (not NaN/±Infinity). Bare z.number() ACCEPTS both, which would let a
// degenerate projection silently poison a recorded replay; perception numbers go through this.
export const finiteNumber = z.number().refine(Number.isFinite, { message: "must be a finite number" });

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

export const SetpointActionSchema = z.object({
  kind: z.literal("setpoint"),
  targetBankDeg: z.number(), // desired bank angle, degrees (+ = roll right)
  targetPitchDeg: z.number(), // desired pitch attitude vs horizon, degrees (+ = nose up)
  throttle: z.number(),
  trigger: z.boolean(),
});

// Discriminated union: a per-kind ActionAdapter turns each intent into a ControlInput per frame.
export const ActionSchema = z.discriminatedUnion("kind", [RawStickActionSchema, SetpointActionSchema]);

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

// Opponent-agnostic piloting-quality metrics, per aircraft id (computed from frames + decisions).
export const CompetenceSchema = z.object({
  survived: z.boolean(),
  damageDealt: z.number(),
  damageTaken: z.number(),
  shots: z.number(),
  hits: z.number(),
  fracStalled: z.number(), // fraction of frames the aircraft was stalled
  fracOnDeck: z.number(), // fraction of frames below the low-altitude threshold
  minAltitude: z.number(),
  meanAirspeed: z.number(),
  energyRetainedRatio: z.number(), // end specific-energy / start specific-energy
  controlSmoothness: z.number(), // 1 - mean |Δ stick| between turns (1 = perfectly smooth)
});

export const MatchOutcomeSchema = z.object({
  resolved: z.boolean(),
  reason: z.enum(["destroyed", "timeout", "draw"]),
  winnerTeam: z.enum(["blue", "red"]).nullable(),
  turnsRun: z.number().int().nonnegative(),
  scores: z.record(z.string(), ScoreSchema), // keyed by team
  finalHealth: z.record(z.string(), z.number()), // keyed by aircraft id
  competence: z.record(z.string(), CompetenceSchema).optional(), // keyed by aircraft id
});

export const UsageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  costUsd: z.number(),
});

// --- v0.4.0 perception: a sensor Percept, recorded per turn for the viewer/audit ---
// A Percept is the model-readable artifact a mounted sensor's encoder produces from its SenseFrame
// — the perception-side mirror of a ControlInput. In v0.4.0 it is RECORDED (for the v0.5.0
// instrument and as a capability proof) but NOT fed to the controller: pilots fly on the same
// Observation as before.

// One contact as a camera sees it: image-plane position + size/aspect cues, no rendering. ndc are
// the projected screen coords in [-1,1] (x right, y up) and are meaningful only when inView.
export const PerceptContactSchema = z.object({
  id: z.string(),
  team: z.enum(["blue", "red"]),
  ndcX: finiteNumber,
  ndcY: finiteNumber,
  rangeM: finiteNumber,
  aspectDeg: finiteNumber, // 0 = pointing at us (nose-on), 180 = we see its tail
  angularSizeDeg: finiteNumber, // subtended diameter — the rendering-free range cue
  inView: z.boolean(), // passes the device cone + range gate
  health: finiteNumber,
});

export const PerceptSchema = z.object({
  deviceId: z.string(),
  modality: z.enum(["camera", "radar", "ir"]),
  encoderId: z.string(), // recorded so a result is attributable to the interface under test
  text: z.string().optional(), // what a model would read (the ASCII viewport)
  contacts: z.array(PerceptContactSchema).optional(),
  attitude: z.object({ bankDeg: finiteNumber, pitchDeg: finiteNumber }).optional(), // for the horizon overlay
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
  usage: UsageSchema.optional(),
  percepts: z.array(PerceptSchema).optional(), // v0.4.0: recorded sensor output (camera, …)
});

// --- aircraft builder: an Airframe is a list of Parts that COMPILE into the flat AircraftModel ---
// compileAirframe (src/sim/airframe.ts) folds these parts into the 7 scalars the physics reads plus
// the mounted SensorDevices. The Airframe is recorded on the replay (additive/optional) so the viewer
// can render the plane you built and a build round-trips. This is the first time a Part serializes,
// so the shapes live here in Zod (single source); src/sim/airframe.ts imports the inferred types.
// Numeric fields use finiteNumber: an airframe rides in a JSON replay, and NaN/±Infinity can't.

export const PartPoseSchema = z.object({
  offset: Vec3Schema, // metres, body frame (forward = -Z)
  rotation: QuaternionSchema, // mount/boresight rotation vs the body basis
});

// Serialization mirror of SensorDevice (src/sim/parts.ts). Kept structurally identical; a test parses
// noseCamera() through it to guard drift. maxRangeM is finite here (a JSON replay can't carry Infinity
// — model an "unlimited" sensor as a large finite range).
export const SensorDeviceSchema = z.object({
  id: z.string(),
  kind: z.literal("sensor"),
  modality: z.enum(["camera", "radar", "ir"]),
  pose: PartPoseSchema,
  for: z.object({ halfAngleRad: finiteNumber, maxRangeM: finiteNumber }),
  optics: z.object({ hFovRad: finiteNumber, aspect: finiteNumber }).optional(),
});

export const FuselagePartSchema = z.object({
  id: z.string(),
  kind: z.literal("fuselage"),
  pose: PartPoseSchema,
  dims: z.object({ length: finiteNumber, width: finiteNumber, height: finiteNumber }), // metres
  massKg: finiteNumber,
});

export const WingPartSchema = z.object({
  id: z.string(),
  kind: z.literal("wing"),
  pose: PartPoseSchema,
  planform: z.object({ span: finiteNumber, chord: finiteNumber }), // area = span * chord (rectangular)
  massKg: finiteNumber,
  // A moving control surface on this wing + the axis it drives; area (m²) becomes control authority
  // (→ a max rate). Omit for a plain lifting surface. A "yaw" surface is vertical: it drives yaw but
  // contributes no lift area.
  control: z.object({ axis: z.enum(["roll", "pitch", "yaw"]), area: finiteNumber }).optional(),
});

export const EnginePartSchema = z.object({
  id: z.string(),
  kind: z.literal("engine"),
  pose: PartPoseSchema,
  thrustN: finiteNumber,
  massKg: finiteNumber,
  dims: z.object({ radius: finiteNumber, length: finiteNumber }), // mesh-only nacelle size
});

export const TankPartSchema = z.object({
  id: z.string(),
  kind: z.literal("tank"),
  pose: PartPoseSchema,
  fuelKg: finiteNumber, // full fuel load (mass carried when full; burns down to 0)
  dryMassKg: finiteNumber, // empty tank structure mass
  dims: z.object({ radius: finiteNumber, length: finiteNumber }), // mesh + box-inertia extents
});

export const PartSchema = z.discriminatedUnion("kind", [
  FuselagePartSchema,
  WingPartSchema,
  EnginePartSchema,
  TankPartSchema,
  SensorDeviceSchema,
]);

export const AirframeSchema = z.object({
  id: z.string(),
  parts: z.array(PartSchema),
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
  airframes: z.record(z.string(), AirframeSchema).optional(), // keyed by aircraft id; the plane each flew
});

// One entry per recorded match in the browser manifest (public/matches/index.json).
export const MatchSummarySchema = z.object({
  id: z.string(),
  file: z.string(), // path relative to /matches/
  model: z.string(),
  mode: z.string(),
  repeat: z.number().int().nonnegative(),
  winnerTeam: z.enum(["blue", "red"]).nullable(),
  costUsd: z.number(),
  fallbackRate: z.number(),
  competence: CompetenceSchema.optional(), // the pilot seat's competence
});
export type MatchSummary = z.infer<typeof MatchSummarySchema>;

export type Vec3 = z.infer<typeof Vec3Schema>;
export type Quaternion = z.infer<typeof QuaternionSchema>;
export type ControlInput = z.infer<typeof ControlInputSchema>;
export type AircraftSnapshot = z.infer<typeof AircraftSnapshotSchema>;
export type ReplayEvent = z.infer<typeof ReplayEventSchema>;
export type ReplayFrame = z.infer<typeof ReplayFrameSchema>;
export type MatchReplay = z.infer<typeof MatchReplaySchema>;
export type StickCommand = z.infer<typeof StickCommandSchema>;
export type RawStickAction = z.infer<typeof RawStickActionSchema>;
export type SetpointAction = z.infer<typeof SetpointActionSchema>;
export type Action = z.infer<typeof ActionSchema>;
export type SelfPercept = z.infer<typeof SelfPerceptSchema>;
export type ContactPercept = z.infer<typeof ContactPerceptSchema>;
export type Observation = z.infer<typeof ObservationSchema>;
export type AgentMeta = z.infer<typeof AgentMetaSchema>;
export type Score = z.infer<typeof ScoreSchema>;
export type MatchOutcome = z.infer<typeof MatchOutcomeSchema>;
export type TurnDecision = z.infer<typeof TurnDecisionSchema>;
export type Usage = z.infer<typeof UsageSchema>;
export type PerceptContact = z.infer<typeof PerceptContactSchema>;
export type Percept = z.infer<typeof PerceptSchema>;
export type Competence = z.infer<typeof CompetenceSchema>;
export type PartPose = z.infer<typeof PartPoseSchema>;
export type FuselagePart = z.infer<typeof FuselagePartSchema>;
export type WingPart = z.infer<typeof WingPartSchema>;
export type EnginePart = z.infer<typeof EnginePartSchema>;
export type TankPart = z.infer<typeof TankPartSchema>;
export type Part = z.infer<typeof PartSchema>;
export type Airframe = z.infer<typeof AirframeSchema>;

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
