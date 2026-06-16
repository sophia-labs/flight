import { createCatalogAircraftBuilds, createDefaultStudioProject } from "./defaultProject";
import { DEFAULT_STUDIO_SCENARIO_CONFIG, StudioProjectSchema, type AircraftBuild, type StudioProject } from "./schema";

export const STUDIO_PROJECT_STORAGE_KEY = "flight.studio.project.v1";

export interface StudioStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function loadStudioProject(storage = browserStorage(), now = new Date()): StudioProject {
  const stored = loadStoredStudioProject(storage);
  return stored ? syncCatalogAircraft(stored, now) : createDefaultStudioProject(now);
}

export function loadStoredStudioProject(storage = browserStorage()): StudioProject | null {
  if (!storage) return null;
  const raw = storage.getItem(STUDIO_PROJECT_STORAGE_KEY);
  if (!raw) return null;

  try {
    return StudioProjectSchema.parse(JSON.parse(raw));
  } catch {
    storage.removeItem(STUDIO_PROJECT_STORAGE_KEY);
    return null;
  }
}

export function saveStudioProject(project: StudioProject, storage = browserStorage()): void {
  if (!storage) return;
  try {
    storage.setItem(STUDIO_PROJECT_STORAGE_KEY, JSON.stringify(StudioProjectSchema.parse(project)));
  } catch {
    // Large replay artifacts can exceed local browser quotas; the runtime state still remains valid.
  }
}

export function syncCatalogAircraft(project: StudioProject, now = new Date()): StudioProject {
  const catalog = createCatalogAircraftBuilds();
  const nonCatalog = project.library.aircraft.filter((aircraft) => aircraft.source !== "catalog");
  const aircraft = [...catalog, ...nonCatalog];
  const ids = new Set(aircraft.map((entry) => entry.id));
  const fallbackAircraftId = aircraft[0]?.id;

  if (!fallbackAircraftId) return project;

  const changed =
    project.library.aircraft.length !== aircraft.length ||
    project.library.aircraft.some((entry, index) => !sameAircraftBuild(entry, aircraft[index]));
  let sessionsChanged = false;

  const sessions = project.sessions.map((session) => {
    const scenario = session.scenario ?? { ...DEFAULT_STUDIO_SCENARIO_CONFIG };
    if (!session.scenario) sessionsChanged = true;

    if (ids.has(session.aircraftBuildId)) {
      return session.scenario ? session : { ...session, scenario };
    }

    sessionsChanged = true;
    return {
      ...session,
      scenario,
      aircraftBuildId: fallbackAircraftId,
      activeReplayId: undefined,
      crewAssignments: [],
      ui: {
        ...session.ui,
        mode: "hangar",
        selectedStationId: firstCrewStationId(aircraft[0]),
      },
    };
  });

  if (!changed && !sessionsChanged) {
    return project;
  }

  return StudioProjectSchema.parse({
    ...project,
    updatedAt: now.toISOString(),
    library: {
      ...project.library,
      aircraft,
    },
    sessions,
  });
}

function sameAircraftBuild(a: AircraftBuild | undefined, b: AircraftBuild | undefined): boolean {
  if (!a || !b) return a === b;
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.source === b.source &&
    a.sourceArchetypeId === b.sourceArchetypeId &&
    JSON.stringify(a.airframe) === JSON.stringify(b.airframe)
  );
}

function firstCrewStationId(aircraft: AircraftBuild | undefined): string | undefined {
  return aircraft?.airframe.parts.find((part) => part.kind === "crew-station")?.id;
}

function browserStorage(): StudioStorage | undefined {
  if (typeof window === "undefined") return undefined;
  return window.localStorage;
}
