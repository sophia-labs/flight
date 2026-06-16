import { describe, expect, it } from "vitest";
import type { MatchReplay } from "../src/protocol/schema";
import { createDefaultStudioProject } from "../src/studio/defaultProject";
import {
  addReplayAsset,
  createReplayAsset,
  getActiveAircraft,
  getActiveReplay,
  getActiveSession,
  selectAircraftBuild,
  selectStudioMode,
  updatePilotProfile,
} from "../src/studio/project";
import { StudioProjectSchema } from "../src/studio/schema";
import {
  loadStoredStudioProject,
  saveStudioProject,
  STUDIO_PROJECT_STORAGE_KEY,
  type StudioStorage,
} from "../src/studio/store";

describe("studio project persistence", () => {
  it("creates a valid default project with catalog aircraft and a seated pilot assignment", () => {
    const project = createDefaultStudioProject(new Date("2026-06-16T00:00:00.000Z"));
    const session = getActiveSession(project);
    const aircraft = getActiveAircraft(project, session);

    expect(StudioProjectSchema.parse(project)).toEqual(project);
    expect(project.library.aircraft.length).toBeGreaterThan(1);
    expect(project.library.pilots[0]?.modelKind).toBe("vrm");
    expect(project.library.pilots[0]?.appearance).toMatchObject({
      hairTint: "#d68a48",
      eyeTint: "#67a7ff",
      outfitTint: "#c9d4ef",
    });
    expect(project.library.pilots[0]?.vrmWearables).toEqual(["flight-headset", "g-suit-harness"]);
    expect(project.library.pilots[0]?.loadout).toMatchObject({
      callsign: "Echo",
      comms: "broadcast-rig",
      flightSuit: "ace",
      gloves: "flight",
      role: "duelist",
    });
    expect(session.ui.mode).toBe("hangar");
    expect(session.crewAssignments[0]).toMatchObject({
      aircraftBuildId: aircraft.id,
      enabled: true,
      pilotProfileId: "pilot-vrm-sample",
      stationId: "pilot-station",
    });
  });

  it("updates the active pilot loadout and appearance as persistent project data", () => {
    const project = createDefaultStudioProject(new Date("2026-06-16T00:00:00.000Z"));
    const pilot = project.library.pilots[0]!;
    const next = updatePilotProfile(
      project,
      pilot.id,
      (current) => ({
        ...current,
        appearance: {
          ...current.appearance,
          eyeTint: "#59d894",
          hairTint: "#83d4ff",
        },
        loadout: {
          ...current.loadout!,
          flightSuit: "test-pilot",
          role: "instructor",
        },
        vrmWearables: ["khronos-flight-helmet", "flight-headset", "data-gloves"],
      }),
      new Date("2026-06-16T00:03:00.000Z"),
    );

    expect(next.library.pilots[0]?.appearance).toMatchObject({
      eyeTint: "#59d894",
      hairTint: "#83d4ff",
    });
    expect(next.library.pilots[0]?.loadout).toMatchObject({
      flightSuit: "test-pilot",
      role: "instructor",
    });
    expect(next.library.pilots[0]?.vrmWearables).toEqual(["khronos-flight-helmet", "flight-headset", "data-gloves"]);
    expect(StudioProjectSchema.parse(next)).toEqual(next);
  });

  it("changes aircraft through the session while keeping the crew assignment attached to the new station", () => {
    const project = createDefaultStudioProject(new Date("2026-06-16T00:00:00.000Z"));
    const target = project.library.aircraft[1]!;
    const next = selectAircraftBuild(project, target.id, new Date("2026-06-16T00:05:00.000Z"));
    const session = getActiveSession(next);

    expect(session.aircraftBuildId).toBe(target.id);
    expect(session.activeReplayId).toBeUndefined();
    expect(session.ui.mode).toBe("hangar");
    expect(session.crewAssignments[0]).toMatchObject({
      aircraftBuildId: target.id,
      stationId: "pilot-station",
    });
  });

  it("adds immutable replay assets and moves the session to replay mode", () => {
    const project = createDefaultStudioProject(new Date("2026-06-16T00:00:00.000Z"));
    const session = getActiveSession(project);
    const aircraft = getActiveAircraft(project, session);
    const asset = createReplayAsset({
      aircraftBuildId: aircraft.id,
      matchReplay: replay(),
      now: new Date("2026-06-16T00:10:00.000Z"),
      sessionId: session.id,
      title: "Test sortie",
    });
    const next = addReplayAsset(project, asset, new Date("2026-06-16T00:10:00.000Z"));

    expect(getActiveReplay(next)?.id).toBe(asset.id);
    expect(getActiveSession(next).ui.mode).toBe("replay");
    expect(getActiveSession(next).replayIds).toEqual([asset.id]);
    expect(asset.summary).toEqual({ durationSeconds: 0.16, eventCount: 1, frameCount: 2 });
  });

  it("round-trips through the local storage boundary and clears invalid stored payloads", () => {
    const storage = memoryStorage();
    const project = selectStudioMode(
      createDefaultStudioProject(new Date("2026-06-16T00:00:00.000Z")),
      "crew",
      new Date("2026-06-16T00:01:00.000Z"),
    );

    saveStudioProject(project, storage);
    expect(loadStoredStudioProject(storage)?.sessions[0]?.ui.mode).toBe("crew");

    storage.setItem(STUDIO_PROJECT_STORAGE_KEY, "{bad json");
    expect(loadStoredStudioProject(storage)).toBeNull();
    expect(storage.getItem(STUDIO_PROJECT_STORAGE_KEY)).toBeNull();
  });
});

function replay(): MatchReplay {
  return {
    id: "test-replay",
    turnDuration: 1,
    frameDt: 0.16,
    frames: [
      { index: 0, time: 0, turn: 0, aircraft: [], events: [] },
      {
        index: 1,
        time: 0.16,
        turn: 0,
        aircraft: [],
        events: [{ type: "shot", message: "test", actorId: "blue-1" }],
      },
    ],
  };
}

function memoryStorage(): StudioStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}
