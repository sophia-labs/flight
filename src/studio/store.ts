import { createDefaultStudioProject } from "./defaultProject";
import { StudioProjectSchema, type StudioProject } from "./schema";

export const STUDIO_PROJECT_STORAGE_KEY = "flight.studio.project.v1";

export interface StudioStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function loadStudioProject(storage = browserStorage(), now = new Date()): StudioProject {
  const stored = loadStoredStudioProject(storage);
  return stored ?? createDefaultStudioProject(now);
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

function browserStorage(): StudioStorage | undefined {
  if (typeof window === "undefined") return undefined;
  return window.localStorage;
}
