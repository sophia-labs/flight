# VTuber Flight Studio Design

This document sketches the next interface pass for the VTuber cockpit work. The goal is to make the current flight lab feel like a playable studio: pick a plane, place the pilot, launch a flight, scrub the replay, and capture a shot. The engine abstractions should remain precise, but the first screen should read as a hangar and replay toy rather than a schema editor.

## Product Shape

The player fantasy is a VTuber flight studio. The user is staging a pilot, aircraft, flight, and camera sequence inside a living hangar.

The primary loop:

1. Choose an aircraft.
2. Put the VTuber in a cockpit station.
3. Validate fit at a glance.
4. Launch a deterministic flight.
5. Watch and scrub the replay.
6. Switch cameras and capture a good shot.
7. Return to the hangar with the same aircraft, pilot, and camera setup still present.

The current app already has the raw pieces: catalog aircraft, a part editor, crew-station anchors, replay playback, cockpit camera modes, transcript/body panels, and headless capture. The design problem is that these pieces are arranged as a lab. The next pass should reframe them as game modes with direct verbs.

## First Playable Screen Model

### Global Shell

The first viewport should be a full-screen 3D scene with a compact mode rail. The mode rail is not a marketing nav; it is the tool belt for the studio.

Modes:

- `Hangar`: browse aircraft, inspect the model, adjust major build choices.
- `Crew`: assign and fit the VTuber to available crew stations.
- `Flight`: run the simulation with a minimal HUD.
- `Replay`: scrub time, switch cameras, inspect events, capture shots.
- `Debug`: expose anchors, skeleton, contact IK, part frames, raw telemetry, and validation numbers.

The important default is that `Hangar`, `Crew`, `Flight`, and `Replay` feel like player-facing modes. `Debug` is powerful but not the face of the product.

### Hangar Mode

The plane is the interface. The user should browse aircraft by visible silhouettes and roles, not by first editing a part list.

Expected controls:

- Aircraft carousel or compact roster with name, role, and silhouette thumbnail.
- Large unframed 3D aircraft view with orbit, pan, zoom, reset-view, and focus-selected controls.
- Key stats surfaced as build traits: speed, climb, turn, endurance, firepower, handling.
- "Edit build" as a secondary drawer for the existing part-kit editor.
- "Crew" and "Launch" as primary verbs.

Current code fit:

- `src/viewer/HangarScreen.tsx` already owns catalog selection, aircraft preview, part editing, stats, warnings, and `Fly this`.
- The next abstraction should split player-facing hangar state from the raw part editor so the screen can lead with aircraft and only reveal part fields when asked.

### Crew Mode

Crew mode is where the cockpit problem becomes playable. A crew station should appear as a hotspot/ghost pilot target in the 3D aircraft. Clicking a station selects it. Clicking "Seat pilot" snaps the active avatar into that station.

Expected controls:

- Station hotspots attached to authored `crew-station` sockets.
- Ghost pilot preview while hovering a station.
- Fit status: head clearance, eye line, canopy containment, right-hand reach, left-hand reach, left-foot reach, right-foot reach.
- Small placement handles for seat hip, eye, stick, throttle, pedals, and panel.
- Pose presets: neutral, leaned-in, relaxed, combat strain.
- Avatar material/capture preset: studio-safe, high-fidelity VRM, diagnostic.

This should not start as a numeric form. The default should be "does she fit?" with visible overlays. Numbers live in the advanced drawer.

Current code fit:

- `crew-station` already records hip, back, eye, controls, canopy link, and pose.
- `PilotStationDebug` already draws the envelope and anchors.
- `pilotRig.ts` already computes station, controls, fit diagnostics, and runtime cockpit anchors.
- The next pass should promote fit diagnostics into persistent validation output and UI badges.

### Flight Mode

Flight mode should feel like launching the staged setup. The minimum loop is deterministic and immediate: press launch, get a replay, start watching.

Expected controls:

- Launch/restart flight.
- Minimal HUD by default: speed, altitude, g, throttle, damage/events.
- Camera toggle: orbit, cabin, pilot cinema.
- Return-to-hangar while preserving the staged setup.

Current code fit:

- `generateAirframeMatch(airframe)` already creates a replay from a built aircraft.
- `App.tsx` currently treats a hangar-launched replay as a one-off in memory. That needs to become a saved session/replay relationship.

### Replay Mode

Replay mode is where the app most clearly becomes a game/editor instead of a sim lab.

Expected controls:

- Timeline scrubber with play/pause/step.
- Camera presets and shot sequence selector.
- Event markers on the timeline: fire, hit, stall, damage, body callouts.
- Capture buttons: still, clip, copy camera URL/config.
- Optional transcript/body/debug panels as drawers, not always-on primary UI.

Current code fit:

- `Timeline`, `usePlayback`, `FlightScene`, `TranscriptPanel`, `BodyPanel`, and `MatchStats` already provide most of the content.
- The next pass should separate the player replay transport from analysis panels. The analysis stack should be available, but not dominate the default experience.

## Interaction Principles

- The scene is the primary control surface. Use hotspots, handles, outlines, ghosts, and camera focus before exposing tables.
- A player should be able to complete the first loop without understanding `Part`, `Airframe`, `MatchReplay`, or `crew-station`.
- Every persistent object should have a visible affordance: aircraft card, pilot card, station hotspot, replay row, camera preset chip.
- Validation should say what is wrong in physical terms: "right hand cannot reach stick" beats "rightArm excess 0.18".
- Debug views observe the model; they should not be required to operate the product.

## Functional Boundaries

The codebase should move toward these boundaries:

- `src/protocol`: stable persisted schemas and replay interchange contracts.
- `src/sim`: deterministic physics, airframe compilation, aircraft catalog, and gameplay simulation.
- `src/studio`: persistent studio state, save/load/migration, user project/session concepts.
- `src/viewer`: rendering, camera rigs, avatar presentation, scene interaction, and panels.
- `src/runtime`: orchestration for generated matches and scripted scenarios.
- `src/headless`: export, probe, verification, and batch tools.

The missing piece is `src/studio`. Today, `App.tsx` owns ephemeral UI/session state and `HangarScreen.tsx` owns editable airframe state. That is fine for a prototype, but it is the wrong place for durable player intent.

## Persistent Data Architecture

Persistence should model studio artifacts, not React component state. A project file should describe what the user is staging and which generated artifacts belong to it.

### Storage Tiers

Use three tiers:

- Catalog content: versioned, shipped with the app, immutable during a user session.
- Project data: user-authored, mutable, saved locally first.
- Generated artifacts: replays, captures, diagnostics, and exports that can be regenerated or archived.

For the browser prototype, project data can start in `localStorage` or IndexedDB. The schema should not care. The important part is that save/load goes through a typed boundary, not through ad hoc component state.

### Core Documents

`StudioProject` is the root persistent document.

```ts
interface StudioProject {
  schemaVersion: 1;
  id: string;
  title: string;
  updatedAt: string;
  activeSessionId: string;
  library: StudioLibrary;
  sessions: StudioSession[];
}
```

`StudioLibrary` stores reusable assets and variants.

```ts
interface StudioLibrary {
  aircraft: AircraftBuild[];
  pilots: PilotProfile[];
  replays: ReplayAsset[];
  cameraPresets: CameraPreset[];
}
```

`StudioSession` stores the current staged scene and its generated outputs.

```ts
interface StudioSession {
  id: string;
  title: string;
  aircraftBuildId: string;
  pilotProfileId: string;
  crewAssignments: CrewAssignment[];
  activeReplayId?: string;
  replayIds: string[];
  captureIds: string[];
  ui: StudioUiState;
}
```

### Aircraft Builds

An `AircraftBuild` wraps the current `Airframe` with user-facing metadata and provenance.

```ts
interface AircraftBuild {
  id: string;
  name: string;
  source: "catalog" | "user" | "import";
  sourceArchetypeId?: string;
  airframe: Airframe;
  thumbnail?: string;
  validation?: AircraftValidation;
}
```

The current `Airframe` remains the simulation contract. The studio layer should not fork it into a separate aircraft model. It should add metadata around it.

### Pilot Profiles

`PilotProfile` describes the avatar as a reusable asset.

```ts
interface PilotProfile {
  id: string;
  name: string;
  modelUrl: string;
  modelKind: "vrm";
  materialPreset: "studio-safe" | "vrm" | "diagnostic";
  scale: number;
  yawRad: number;
  restPoseId?: string;
}
```

Current constants in `pilotRig.ts` can seed the default profile:

- `PILOT_MODEL_URL`
- `PILOT_AVATAR_SCALE`
- `PILOT_AVATAR_YAW_RAD`

### Crew Assignments

`CrewAssignment` binds a pilot profile to a station on a specific aircraft build.

```ts
interface CrewAssignment {
  id: string;
  aircraftBuildId: string;
  pilotProfileId: string;
  stationId: string;
  enabled: boolean;
  posePreset: "neutral" | "relaxed" | "combat" | "leaned-in";
  overrides?: CrewStationOverrides;
  validation?: CrewFitValidation;
}
```

The assignment should reference `crew-station` by id. It should not duplicate the whole station unless the user creates overrides.

```ts
interface CrewStationOverrides {
  seat?: Partial<CrewStationPart["seat"]>;
  controls?: Partial<CrewStationPart["controls"]>;
  pose?: Partial<CrewStationPart["pose"]>;
}
```

This gives us a clean edit story:

- Catalog station is the default.
- User fit edits become an assignment override.
- "Bake into aircraft" can later write overrides back into the `Airframe.parts` station.

### Replays

`MatchReplay` should remain the immutable replay payload. The studio layer stores metadata around it.

```ts
interface ReplayAsset {
  id: string;
  title: string;
  createdAt: string;
  aircraftBuildId: string;
  sessionId: string;
  matchReplay: MatchReplay;
  seed?: string;
  summary?: ReplaySummary;
}
```

Replays are generated artifacts. Once produced, they should not change. If the aircraft or crew setup changes, launching again creates a new replay asset.

### Camera Presets

Camera state should become persistent because the fun loop includes finding shots.

```ts
type CameraMode = "orbit" | "cabin" | "pilot-cinema";

interface CameraPreset {
  id: string;
  name: string;
  mode: CameraMode;
  target?: "aircraft" | "pilot" | "station" | "world";
  params: Record<string, number | string | boolean>;
}
```

The current `pilot-cinema` shot logic can remain procedural. The persistent preset chooses mode and parameters; the runtime computes exact camera transforms.

### UI State

Only user intent should persist. Avoid saving frame-by-frame transient state.

```ts
interface StudioUiState {
  mode: "hangar" | "crew" | "flight" | "replay" | "debug";
  selectedPartId?: string;
  selectedStationId?: string;
  cameraPresetId?: string;
  replayPosition?: number;
  drawers: {
    buildEditor: boolean;
    transcript: boolean;
    body: boolean;
    debug: boolean;
  };
}
```

Do not persist:

- React component refs.
- Loaded Three.js or VRM objects.
- `THREE.Vector3` instances.
- Playback clock internals.
- IK solver scratch state.
- Derived fit diagnostics unless stored as a cached validation result with schema version/provenance.

### Validation Outputs

Validation should be computed from persisted inputs and cached for UI speed.

```ts
interface CrewFitValidation {
  schemaVersion: 1;
  stationId: string;
  pilotProfileId: string;
  status: "ok" | "warning" | "blocked";
  checks: {
    headClearance: FitCheck;
    eyeLine: FitCheck;
    canopyContainment: FitCheck;
    rightHandReach: FitCheck;
    leftHandReach: FitCheck;
    rightFootReach: FitCheck;
    leftFootReach: FitCheck;
  };
}

interface FitCheck {
  status: "ok" | "warning" | "blocked";
  label: string;
  meters?: number;
}
```

This lets the UI say "blocked: head outside canopy" while debug can still expose exact vectors.

## Runtime State Architecture

The browser runtime should assemble a `StudioRuntime` from the project:

```ts
interface StudioRuntime {
  project: StudioProject;
  activeSession: StudioSession;
  activeAircraft: AircraftBuild;
  activePilot: PilotProfile;
  activeAssignments: CrewAssignment[];
  activeReplay?: ReplayAsset;
}
```

The runtime owns commands:

- `selectMode(mode)`
- `selectAircraft(buildId)`
- `assignPilot(stationId, pilotProfileId)`
- `updateCrewOverride(assignmentId, patch)`
- `launchFlight()`
- `selectReplay(replayId)`
- `setReplayPosition(position)`
- `saveCameraPreset(preset)`

React components should call commands and render selectors. They should not mutate persistent structures directly.

## Migration Path

Keep this incremental:

1. Add `src/studio/schema.ts` with Zod schemas for `StudioProject`, `AircraftBuild`, `PilotProfile`, `CrewAssignment`, `ReplayAsset`, `CameraPreset`, and `StudioUiState`.
2. Add `src/studio/defaultProject.ts` to wrap the current first catalog aircraft and default VRM pilot into a project.
3. Add `src/studio/store.ts` with load/save/migrate commands. Start with localStorage or IndexedDB behind an interface.
4. Refactor `App.tsx` to hold `StudioRuntime` instead of scattered `screen`, `replay`, `cameraMode`, and toggles.
5. Refactor `HangarScreen.tsx` into `HangarMode`, `CrewMode`, and an advanced `PartEditor` drawer.
6. Convert `PilotStationDebug` output into player-facing fit badges plus a debug overlay.
7. Save hangar-launched replays as `ReplayAsset` objects and expose them in Replay mode.

This path preserves current functionality while moving durable player intent out of component-local state.

## Design Decisions

- `Airframe` remains the simulation source of truth.
- `crew-station` remains the authored human socket inside the airframe.
- `CrewAssignment` is the user/session binding between a pilot and a station.
- Replays are immutable generated assets attached to a session.
- Camera presets are persistent studio assets because shot-finding is part of the game loop.
- Debug data is derived unless intentionally captured as a diagnostic artifact.

## Open Questions

- Should the first persistent store be localStorage for speed or IndexedDB for larger replay/project payloads?
- Should replays live inside `StudioProject` at first, or should large `MatchReplay` payloads move to a separate artifact store with ids in the project?
- Do we want one active VTuber pilot globally, or a pilot library from the beginning?
- Should station fit overrides be stored only in `CrewAssignment`, or should the UI encourage baking them back into the airframe?
- What is the first capture artifact: still PNG, MP4 clip, or just a saved camera preset plus replay position?

## First Implementation Slice

The first slice should be small and visible:

1. Create typed studio project persistence.
2. Boot the app into a default project with one aircraft, one pilot, and one session.
3. Add a mode rail with `Hangar`, `Crew`, `Flight`, `Replay`, `Debug`.
4. Make Crew mode show station hotspots and fit badges from `computeCockpitFitDiagnostics`.
5. Save a hangar-launched replay into the project and make Replay mode select it.

That gives us the product spine. After that, visual polish and deeper editor affordances have a stable place to attach.

## First Slice Landed

The first implementation slice now exists in the app:

- `src/studio/schema.ts` defines the typed project/session/library/replay contracts.
- `src/studio/defaultProject.ts`, `src/studio/project.ts`, and `src/studio/store.ts` create, mutate, and persist the local studio project.
- `src/viewer/StudioScreen.tsx` is the new first screen with mode rail, 3D hangar stage, aircraft roster, pilot card, fit checks, launch, replay controls, and debug mode.
- `src/App.tsx` now boots into `VTuber Flight Studio` instead of the old replay lab.
- The old `HangarScreen` remains available through `Edit build` as the advanced builder.
