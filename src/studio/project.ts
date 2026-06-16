import type { MatchReplay } from "../protocol/schema";
import type {
  AircraftBuild,
  PilotProfile,
  ReplayAsset,
  StudioMode,
  StudioProject,
  StudioSession,
} from "./schema";

export function getActiveSession(project: StudioProject): StudioSession {
  return (
    project.sessions.find((session) => session.id === project.activeSessionId) ??
    project.sessions[0]
  );
}

export function getActiveAircraft(project: StudioProject, session = getActiveSession(project)): AircraftBuild {
  return (
    project.library.aircraft.find((aircraft) => aircraft.id === session.aircraftBuildId) ??
    project.library.aircraft[0]
  );
}

export function getActivePilot(project: StudioProject, session = getActiveSession(project)) {
  return (
    project.library.pilots.find((pilot) => pilot.id === session.pilotProfileId) ??
    project.library.pilots[0]
  );
}

export function getActiveReplay(project: StudioProject, session = getActiveSession(project)): ReplayAsset | undefined {
  return session.activeReplayId
    ? project.library.replays.find((replay) => replay.id === session.activeReplayId)
    : undefined;
}

export function selectStudioMode(project: StudioProject, mode: StudioMode, now = new Date()): StudioProject {
  return updateActiveSession(
    project,
    (session) => ({
      ...session,
      ui: { ...session.ui, mode },
    }),
    now,
  );
}

export function selectAircraftBuild(project: StudioProject, aircraftBuildId: string, now = new Date()): StudioProject {
  const aircraft = project.library.aircraft.find((candidate) => candidate.id === aircraftBuildId);
  if (!aircraft) return project;

  const session = getActiveSession(project);
  const stationId = firstCrewStationId(aircraft);

  return updateActiveSession(
    project,
    () => ({
      ...session,
      aircraftBuildId,
      activeReplayId: undefined,
      crewAssignments: stationId
        ? [
            {
              id: "assignment-primary-pilot",
              aircraftBuildId,
              pilotProfileId: session.pilotProfileId,
              stationId,
              enabled: true,
              posePreset: "neutral",
            },
          ]
        : [],
      ui: {
        ...session.ui,
        mode: "hangar",
        selectedStationId: stationId,
      },
    }),
    now,
  );
}

export function updatePilotProfile(
  project: StudioProject,
  pilotProfileId: string,
  update: (pilot: PilotProfile) => PilotProfile,
  now = new Date(),
): StudioProject {
  let changed = false;
  const pilots = project.library.pilots.map((pilot) => {
    if (pilot.id !== pilotProfileId) return pilot;
    changed = true;
    return update(pilot);
  });
  if (!changed) return project;

  return {
    ...project,
    updatedAt: now.toISOString(),
    library: {
      ...project.library,
      pilots,
    },
  };
}

export function createReplayAsset({
  aircraftBuildId,
  matchReplay,
  sessionId,
  title,
  now = new Date(),
}: {
  aircraftBuildId: string;
  matchReplay: MatchReplay;
  sessionId: string;
  title: string;
  now?: Date;
}): ReplayAsset {
  const createdAt = now.toISOString();
  return {
    id: `replay-${now.getTime()}`,
    title,
    createdAt,
    aircraftBuildId,
    sessionId,
    matchReplay,
    summary: {
      durationSeconds: matchReplay.frames.at(-1)?.time ?? 0,
      eventCount: matchReplay.frames.reduce((count, frame) => count + frame.events.length, 0),
      frameCount: matchReplay.frames.length,
    },
  };
}

export function addReplayAsset(project: StudioProject, replay: ReplayAsset, now = new Date()): StudioProject {
  return updateActiveSession(
    {
      ...project,
      library: {
        ...project.library,
        replays: [...project.library.replays.filter((candidate) => candidate.id !== replay.id), replay],
      },
    },
    (session) => ({
      ...session,
      activeReplayId: replay.id,
      replayIds: [...session.replayIds.filter((id) => id !== replay.id), replay.id],
      ui: {
        ...session.ui,
        mode: "replay",
        replayPosition: 0,
      },
    }),
    now,
  );
}

function updateActiveSession(
  project: StudioProject,
  update: (session: StudioSession) => StudioSession,
  now: Date,
): StudioProject {
  const activeSession = getActiveSession(project);
  const nextSession = update(activeSession);
  return {
    ...project,
    updatedAt: now.toISOString(),
    activeSessionId: nextSession.id,
    sessions: project.sessions.map((session) => (session.id === activeSession.id ? nextSession : session)),
  };
}

function firstCrewStationId(aircraft: AircraftBuild): string | undefined {
  return aircraft.airframe.parts.find((part) => part.kind === "crew-station")?.id;
}
