# VTuber Cockpit Integration

This pass integrates the sample VRM pilot into the flight sim cockpit without a helmet. The goal is rigging quality, measurable cockpit fit, and a cleaner game-design boundary for "where a person sits and what they touch" inside an aircraft.

## Current Repo

- Branch: `feat/v0.5.0-builder`
- Path: `/Users/vera/dev/flight`
- Source VRM: `public/models/VRM1_Constraint_Twist_Sample.vrm`

The old VTuber worktree has been removed. New VTuber/cockpit work should happen directly in this repo.

## Functional Shape

The key abstraction added in this pass is a massless `crew-station` part:

- `src/protocol/schema.ts`
  - Adds `CrewStationPartSchema`.
  - Stores authored pilot anchors: hip, back, eye, stick, throttle, pedals, and panel.
  - Links the station to a canopy by `canopyId` when available.

- `src/sim/aircraftCatalog.ts`
  - Adds a `pilot-station` beside each catalog cockpit/canopy.
  - Keeps the cockpit camera eye and the avatar eye tied to the same authored point.

- `src/viewer/HangarScreen.tsx`
  - Adds `crew-station` to the part kit.
  - Exposes direct sliders for seat and control anchors.
  - Shows station debug probes when the station is selected.

- `src/viewer/PilotStationDebug.tsx`
  - Draws the canopy envelope, seat/head probes, control probes, and relationship lines.
  - Gives the builder a visible "human socket" overlay instead of hiding placement in runtime heuristics.

The crew station is intentionally not a rendered aircraft component and carries no mass slider. It is gameplay/editor metadata that the viewer, pilot rig, and cockpit control mesh consume.

## Runtime Pieces

- `src/viewer/pilotRig.ts`
  - Resolves the authored `crew-station` first, then falls back to canopy/sensor/default inference.
  - Builds shared cockpit anchor geometry for the seat, stick, throttle, pedals, and panel.
  - Avatar rest measurements and fit diagnostics.
  - Pilot force estimates for posture layers.

- `src/viewer/PilotAvatar.tsx`
  - Loads the VRM with `@pixiv/three-vrm`.
  - Places the hip at the crew-station seat anchor.
  - Applies seated pose, expression/look-at layers, G-force posture, and contact IK.
  - Publishes `window.__flightPilotRig` for headless/e2e inspection.
  - Converts the sample VRM to capture-safe stock Three.js materials while preserving useful source maps/colors.

- `src/viewer/contactIk.ts`
  - CCD contact IK used to pull hands/feet toward cockpit controls.

- `src/viewer/pilotPose.ts`
  - Layered pose authoring for seated posture, idle motion, control strain, expressions, and look-at.

- `src/viewer/pilotCinema.ts`
  - Scripted cockpit camera sequence with shots for face, stick, throttle, pedals, profile, and panel.

- `src/viewer/FlightScene.tsx`
  - Adds the `pilot-cinema` camera mode.
  - Renders the VTuber in pilot/orbit views and drives the scripted camera from the same station rig.
  - Can show the debug overlay with `?pilotDebug=1`.

- `src/headless/probePilotCapture.ts`
  - Diagnostic runner for `canvas.captureStream()` behavior across avatar render variants.

- `src/headless/cockpitClip.ts`
  - Supports `--camera pilot-cinema`.
  - Defaults to the reliable canvas readback capture path.
  - Keeps `--capture stream` available for MediaRecorder diagnostics.

## Material And Capture Findings

Chrome headless can record ordinary WebGL and the flight sim cabin view through `canvas.captureStream()`.

The original VRM render path caused `MediaRecorder` to emit only zero-byte chunks:

- VRM mounted with original MToon `ShaderMaterial`: fails.
- Avatar hidden: works.
- VRM meshes using stock `MeshBasicMaterial`: works.
- VRM meshes using stock `MeshStandardMaterial`: works when image texture maps are stripped.
- Disabling IK, expressions, look-at, VRM update, shadows, or morph targets did not fix the original MToon path.

The current default strips the capture-breaking VRM shader/texture path and converts avatar meshes to stock `MeshStandardMaterial` with simple colors. The original materials can still be forced for diagnostics with:

```bash
npm run dev -- --port 5173
# Open /?camera=pilot-cinema&pilotMaterial=vrm
```

The stream encoder now emits bytes for the capture-safe avatar, but headless Chromium still samples WebGL sparsely in this environment. For faithful MP4 duration/frame count, use the default readback path:

```bash
CLIP_FPS=8 npm run clip:controls -- --camera pilot-cinema --out clips/pilot-cinema-girl.mp4 --seconds 16 --no-hud
```

## Browser Workflow

The replay/browser path supports the VTuber loop:

- Use `http://127.0.0.1:5173/?camera=pilot-cinema&hud=0` for the scripted pilot camera.
- Add `pilotDebug=1` to view crew-station/cockpit probes in the flight scene.
- Use the Hangar, select `CREW-STATION pilot-station`, and click `Fly this` to exercise the full builder-to-viewer path.

## Verification

Useful commands:

```bash
npm test
npm run build
npm run e2e
npm run probe:pilot-capture
```

This pass was verified with:

```bash
npm test
npm run build
npm run e2e -- --project desktop-chromium
```

Known build note: Vite reports a large client chunk because the VRM runtime is bundled into the main app. Lazy-loading the pilot avatar is a good later cleanup.

## Next Work

- Move cockpit placement and human fit from "good enough numbers" toward editable station presets and validation warnings.
- Consider a proper offscreen/frame-export renderer for deterministic clip generation.
- Lazy-load the VRM runtime so orbit/cabin users do not pay the initial bundle cost.
- Add a dedicated UI switch or build flag for high-fidelity VRM materials versus capture-safe materials if both paths remain useful.
