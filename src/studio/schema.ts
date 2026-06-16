import { z } from "zod";
import {
  AirframeSchema,
  MatchReplaySchema,
  PartPoseSchema,
  Vec3Schema,
  type Airframe,
  type MatchReplay,
} from "../protocol/schema";

export const StudioModeSchema = z.enum(["hangar", "crew", "flight", "replay", "debug"]);
export const StudioCameraModeSchema = z.enum(["orbit", "cabin", "pilot-cinema"]);

export const FitStatusSchema = z.enum(["ok", "warning", "blocked"]);

export const FitCheckSchema = z.object({
  status: FitStatusSchema,
  label: z.string(),
  meters: z.number().optional(),
});

export const CrewFitValidationSchema = z.object({
  schemaVersion: z.literal(1),
  stationId: z.string(),
  pilotProfileId: z.string(),
  status: FitStatusSchema,
  checks: z.object({
    headClearance: FitCheckSchema,
    eyeLine: FitCheckSchema,
    canopyContainment: FitCheckSchema,
    rightHandReach: FitCheckSchema,
    leftHandReach: FitCheckSchema,
    rightFootReach: FitCheckSchema,
    leftFootReach: FitCheckSchema,
  }),
});

export const AircraftValidationSchema = z.object({
  schemaVersion: z.literal(1),
  status: FitStatusSchema,
  warnings: z.array(z.string()),
});

export const AircraftBuildSchema = z.object({
  id: z.string(),
  name: z.string(),
  source: z.enum(["catalog", "user", "import"]),
  sourceArchetypeId: z.string().optional(),
  airframe: AirframeSchema,
  thumbnail: z.string().optional(),
  validation: AircraftValidationSchema.optional(),
});

export const PilotProfileSchema = z.object({
  id: z.string(),
  name: z.string(),
  modelUrl: z.string(),
  modelKind: z.literal("vrm"),
  materialPreset: z.enum(["studio-safe", "vrm", "diagnostic"]),
  scale: z.number(),
  yawRad: z.number(),
  restPoseId: z.string().optional(),
  appearance: z
    .object({
      accentTint: z.string().optional(),
      eyeTint: z.string().optional(),
      hairTint: z.string().optional(),
      outfitTint: z.string().optional(),
      skinWarmth: z.number().min(-1).max(1).optional(),
    })
    .optional(),
  expressionPreset: z.enum(["neutral", "focused", "excited", "strained"]).optional(),
  loadout: z
    .object({
      callsign: z.string(),
      comms: z.enum(["open-cockpit", "throat-mic", "broadcast-rig"]),
      flightSuit: z.enum(["cadet", "ace", "test-pilot"]),
      gloves: z.enum(["none", "fingerless", "flight"]),
      role: z.enum(["rookie", "duelist", "instructor"]),
    })
    .optional(),
});

export const CrewStationOverridesSchema = z.object({
  seat: z
    .object({
      hip: Vec3Schema.optional(),
      back: Vec3Schema.optional(),
      eye: Vec3Schema.optional(),
    })
    .optional(),
  controls: z
    .object({
      stick: Vec3Schema.optional(),
      throttle: Vec3Schema.optional(),
      leftPedal: Vec3Schema.optional(),
      rightPedal: Vec3Schema.optional(),
      panel: Vec3Schema.optional(),
    })
    .optional(),
  pose: PartPoseSchema.partial().optional(),
});

export const CrewAssignmentSchema = z.object({
  id: z.string(),
  aircraftBuildId: z.string(),
  pilotProfileId: z.string(),
  stationId: z.string(),
  enabled: z.boolean(),
  posePreset: z.enum(["neutral", "relaxed", "combat", "leaned-in"]),
  overrides: CrewStationOverridesSchema.optional(),
  validation: CrewFitValidationSchema.optional(),
});

export const ReplaySummarySchema = z.object({
  durationSeconds: z.number(),
  frameCount: z.number().int().nonnegative(),
  eventCount: z.number().int().nonnegative(),
});

export const ReplayAssetSchema = z.object({
  id: z.string(),
  title: z.string(),
  createdAt: z.string(),
  aircraftBuildId: z.string(),
  sessionId: z.string(),
  matchReplay: MatchReplaySchema,
  seed: z.string().optional(),
  summary: ReplaySummarySchema.optional(),
});

export const CameraPresetSchema = z.object({
  id: z.string(),
  name: z.string(),
  mode: StudioCameraModeSchema,
  target: z.enum(["aircraft", "pilot", "station", "world"]).optional(),
  params: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])),
});

export const StudioUiStateSchema = z.object({
  mode: StudioModeSchema,
  selectedPartId: z.string().optional(),
  selectedStationId: z.string().optional(),
  cameraPresetId: z.string().optional(),
  replayPosition: z.number().optional(),
  drawers: z.object({
    buildEditor: z.boolean(),
    transcript: z.boolean(),
    body: z.boolean(),
    debug: z.boolean(),
  }),
});

export const StudioSessionSchema = z.object({
  id: z.string(),
  title: z.string(),
  aircraftBuildId: z.string(),
  pilotProfileId: z.string(),
  crewAssignments: z.array(CrewAssignmentSchema),
  activeReplayId: z.string().optional(),
  replayIds: z.array(z.string()),
  captureIds: z.array(z.string()),
  ui: StudioUiStateSchema,
});

export const StudioLibrarySchema = z.object({
  aircraft: z.array(AircraftBuildSchema),
  pilots: z.array(PilotProfileSchema),
  replays: z.array(ReplayAssetSchema),
  cameraPresets: z.array(CameraPresetSchema),
});

export const StudioProjectSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string(),
  title: z.string(),
  updatedAt: z.string(),
  activeSessionId: z.string(),
  library: StudioLibrarySchema,
  sessions: z.array(StudioSessionSchema),
});

export type StudioMode = z.infer<typeof StudioModeSchema>;
export type StudioCameraMode = z.infer<typeof StudioCameraModeSchema>;
export type FitStatus = z.infer<typeof FitStatusSchema>;
export type FitCheck = z.infer<typeof FitCheckSchema>;
export type CrewFitValidation = z.infer<typeof CrewFitValidationSchema>;
export type AircraftValidation = z.infer<typeof AircraftValidationSchema>;
export type AircraftBuild = z.infer<typeof AircraftBuildSchema> & { airframe: Airframe };
export type PilotProfile = z.infer<typeof PilotProfileSchema>;
export type CrewStationOverrides = z.infer<typeof CrewStationOverridesSchema>;
export type CrewAssignment = z.infer<typeof CrewAssignmentSchema>;
export type ReplaySummary = z.infer<typeof ReplaySummarySchema>;
export type ReplayAsset = z.infer<typeof ReplayAssetSchema> & { matchReplay: MatchReplay };
export type CameraPreset = z.infer<typeof CameraPresetSchema>;
export type StudioUiState = z.infer<typeof StudioUiStateSchema>;
export type StudioSession = z.infer<typeof StudioSessionSchema>;
export type StudioLibrary = z.infer<typeof StudioLibrarySchema>;
export type StudioProject = z.infer<typeof StudioProjectSchema>;
