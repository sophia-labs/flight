import { aircraftArchetypes } from "../sim/aircraftCatalog";
import { PILOT_AVATAR_SCALE, PILOT_AVATAR_YAW_RAD, PILOT_MODEL_URL } from "./pilotDefaults";
import { StudioProjectSchema, type AircraftBuild, type CrewAssignment, type StudioProject } from "./schema";
import { DEFAULT_VRM_WEARABLE_IDS } from "./vrmWearables";

export function createDefaultStudioProject(now = new Date()): StudioProject {
  const updatedAt = now.toISOString();
  const aircraft = aircraftArchetypes.map<AircraftBuild>((archetype) => ({
    id: `catalog-${archetype.id}`,
    name: archetype.shortName,
    source: "catalog",
    sourceArchetypeId: archetype.id,
    airframe: clone(archetype.airframe),
  }));
  const activeAircraft = aircraft[0];
  const pilotProfileId = "pilot-vrm-sample";
  const stationId = firstCrewStationId(activeAircraft);
  const crewAssignments: CrewAssignment[] = stationId
    ? [
        {
          id: "assignment-primary-pilot",
          aircraftBuildId: activeAircraft.id,
          pilotProfileId,
          stationId,
          enabled: true,
          posePreset: "neutral",
        },
      ]
    : [];

  return StudioProjectSchema.parse({
    schemaVersion: 1,
    id: "local-studio-project",
    title: "VTuber Flight Studio",
    updatedAt,
    activeSessionId: "session-main",
    library: {
      aircraft,
      pilots: [
        {
          id: pilotProfileId,
          name: "Sample VTuber Pilot",
          modelUrl: PILOT_MODEL_URL,
          modelKind: "vrm",
          materialPreset: "studio-safe",
          scale: PILOT_AVATAR_SCALE,
          yawRad: PILOT_AVATAR_YAW_RAD,
          vrmWearables: [...DEFAULT_VRM_WEARABLE_IDS],
          appearance: {
            accentTint: "#f2c94c",
            eyeTint: "#67a7ff",
            hairTint: "#d68a48",
            outfitTint: "#c9d4ef",
            skinWarmth: 0.15,
          },
          expressionPreset: "focused",
          loadout: {
            callsign: "Echo",
            comms: "broadcast-rig",
            flightSuit: "ace",
            gloves: "flight",
            role: "duelist",
          },
        },
      ],
      replays: [],
      cameraPresets: [
        { id: "camera-orbit", name: "Orbit", mode: "orbit", target: "aircraft", params: {} },
        { id: "camera-cabin", name: "Cabin", mode: "cabin", target: "pilot", params: {} },
        { id: "camera-pilot-cinema", name: "Pilot Cinema", mode: "pilot-cinema", target: "pilot", params: {} },
      ],
    },
    sessions: [
      {
        id: "session-main",
        title: "Studio Session",
        aircraftBuildId: activeAircraft.id,
        pilotProfileId,
        crewAssignments,
        replayIds: [],
        captureIds: [],
        ui: {
          mode: "hangar",
          selectedStationId: stationId,
          cameraPresetId: "camera-orbit",
          drawers: {
            buildEditor: false,
            transcript: true,
            body: true,
            debug: false,
          },
        },
      },
    ],
  });
}

function firstCrewStationId(aircraft: AircraftBuild): string | undefined {
  return aircraft.airframe.parts.find((part) => part.kind === "crew-station")?.id;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
