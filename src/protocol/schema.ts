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

export const MatchReplaySchema = z.object({
  id: z.string(),
  turnDuration: z.number(),
  frameDt: z.number(),
  frames: z.array(ReplayFrameSchema).min(1),
});

export type Vec3 = z.infer<typeof Vec3Schema>;
export type Quaternion = z.infer<typeof QuaternionSchema>;
export type ControlInput = z.infer<typeof ControlInputSchema>;
export type AircraftSnapshot = z.infer<typeof AircraftSnapshotSchema>;
export type ReplayEvent = z.infer<typeof ReplayEventSchema>;
export type ReplayFrame = z.infer<typeof ReplayFrameSchema>;
export type MatchReplay = z.infer<typeof MatchReplaySchema>;

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
