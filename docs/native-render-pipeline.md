# Native Render Pipeline

This pipeline renders Flight replays without Chromium. The browser viewer remains useful for app QA, but final clips can now go through an engine-native offline path:

```text
MatchReplay JSON -> native render timeline JSON -> Blender scene frames -> ffmpeg MP4
```

## Commands

Export only the deterministic render timeline:

```bash
npm run export:native-timeline -- --replay match.json --timeline-out clips/native.timeline.json
```

Render a replay with Blender:

```bash
npm run render:native -- --replay match.json --camera cinematic --seconds 12 --out clips/native-flight.mp4
```

Generate a deterministic scripted replay and render it in one command:

```bash
npm run render:native -- --turns 8 --seconds 10 --camera cinematic --out clips/native-demo.mp4
```

Useful flags:

- `--camera cinematic|chase|cockpit|orbit|pilot-hero`
- `--avatar public/models/VRM1_Constraint_Twist_Sample.vrm`
- `--fps 24`
- `--width 1280 --height 720`
- `--pilot-id blue-1`
- `--timeline-out clips/run.timeline.json`
- `--frames-dir clips/run.frames`
- `--keep-frames`
- `--blender /path/to/blender`

You can also set `BLENDER=/path/to/blender`.

## Files

- `src/render/nativeTimeline.ts`
  - Pure TypeScript timeline exporter.
  - Samples replay frames at render FPS.
  - Exports aircraft transforms, airframes, controls, surface telemetry, events, and camera poses.

- `src/headless/renderNative.ts`
  - CLI wrapper.
  - Reads an existing replay or generates a deterministic scripted demo.
  - Writes the timeline JSON.
  - Invokes Blender unless `--timeline-only` is set.

- `tools/blender/render_native_flight.py`
  - Blender scene builder.
  - Builds native proxy geometry from recorded airframe parts.
  - Animates aircraft transforms, cockpit controls, moving control surfaces, tracers, and cameras.
  - Renders PNG frames and shells out to ffmpeg for the MP4.

## Why This Exists

The old clip path records the React viewer through Chromium screenshots or canvas capture. That is useful for visual smoke tests, but it couples final video output to browser GPU behavior.

The native render path keeps the truth in replay/timeline data and moves final image generation to Blender. It is deterministic, inspectable, and does not depend on `canvas.captureStream`, `MediaRecorder`, or Chromium WebGL readback.

## Current Scope

This first pass renders proxy aircraft and cockpit controls from existing airframe data. It can also mount the sample VRM avatar into the pilot cockpit for `pilot-hero` shots:

```bash
npm run render:native -- --camera pilot-hero --seconds 4 --out clips/native-review-vtuber-topgun.mp4
```

The intended next step is to replace the proxy cockpit/pose with a high-fidelity cockpit and a real seated avatar rig while keeping the same render contract.
