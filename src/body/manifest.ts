import { z } from "zod";

export const MuscleChannelSchema = z.object({
  range: z.tuple([z.number(), z.number()]),
  neutral: z.number(),
  meaning: z.string(),
  actuatorMapping: z.string(),
  caveat: z.string(),
});

export const BodyManifestSchema = z.object({
  manifestVersion: z.string(),
  bodyId: z.string(),
  bodyType: z.enum(["fixed_wing", "quadcopter", "rocket", "missile", "custom"]),
  bodyTickDt: z.number().positive(),
  muscles: z.record(z.string(), MuscleChannelSchema),
  bodyLaws: z.array(z.string()),
  painChannels: z.array(z.string()),
  sensationChannels: z.array(z.string()),
  bands: z.record(z.string(), z.record(z.string(), z.string())),
});

export type MuscleChannel = z.infer<typeof MuscleChannelSchema>;
export type BodyManifest = z.infer<typeof BodyManifestSchema>;

export const fixedWingBodyManifest: BodyManifest = BodyManifestSchema.parse({
  manifestVersion: "0.8.0",
  bodyId: "fixed_wing.trainer.v1",
  bodyType: "fixed_wing",
  bodyTickDt: 0.16,
  muscles: {
    ROLL: {
      range: [-5, 5],
      neutral: 0,
      meaning: "negative rolls left, positive rolls right",
      actuatorMapping: "aileron_differential",
      caveat: "weak when stalled or too slow",
    },
    PITCH: {
      range: [-5, 5],
      neutral: 0,
      meaning: "negative pushes nose down, positive pulls nose up",
      actuatorMapping: "elevator",
      caveat: "pulling while slow increases stall danger",
    },
    YAW: {
      range: [-5, 5],
      neutral: 0,
      meaning: "negative yaws left, positive yaws right",
      actuatorMapping: "rudder",
      caveat: "coordinates turns; does not flat-turn well",
    },
    PUSH: {
      range: [0, 5],
      neutral: 2,
      meaning: "throttle",
      actuatorMapping: "engine_throttle",
      caveat: "slow response",
    },
  },
  bodyLaws: [
    "I turn by banking, then pulling.",
    "I need forward airspeed to keep control.",
    "Pulling hard while slow makes the wings stop obeying.",
    "Pushing the nose down trades altitude for speed and authority.",
    "Rudder helps the turn feel clean but cannot replace lift.",
    "Throttle helps energy but not instantly.",
  ],
  painChannels: [
    "wing_buffet",
    "pitch_mush",
    "wing_drop",
    "over_g",
    "overspeed_shake",
    "ground_rush",
  ],
  sensationChannels: [
    "attitude",
    "motion",
    "energy",
    "stall_margin",
    "authority",
    "terrain",
    "target",
    "pain",
    "affordances",
  ],
  bands: {
    energy: {
      dead: "airspeed < 65 m/s",
      low: "65-115 m/s",
      good: "115-245 m/s",
      high: "245-330 m/s",
      overspeed: "> 330 m/s",
    },
    stall_margin: {
      stalled: "stalled or AoA > critical AoA",
      buffet: "surface stall severity is visible",
      thin: "AoA > 85% critical AoA",
      narrowing: "AoA > 65% critical AoA",
      safe: "otherwise",
    },
    ground_rush: {
      safe: "altitude > 260 m",
      near: "120-260 m",
      rush: "< 120 m or descending near terrain",
    },
  },
});

