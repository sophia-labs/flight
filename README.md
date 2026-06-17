# Flight Duel

A physics-driven flight combat sim where LLM-scale agents can fly through auditable control layers. Version 0.8.0 adds an embodied fixed-wing Body loop: a Pilot emits desire, the Body emits strict motor grammar, the adapter maps muscles onto the existing airplane, and replay telemetry records the consequence.

## Run

```bash
npm install
npm run dev
```

Open `http://127.0.0.1:5173/`.

In the Studio app, open Scene mode to spawn scenarios against the selected aircraft. The scenario sheet
now exposes the control loop (`Body Pilot` or `Motor Tape`), planner model, Body/twitch model, turn
count, camera, and motor-program timing. `Motor Tape` is the game-integrated slow-planner/fast-twitch
path: the planner writes a smooth control tape, a held `weapons_free` guard wakes the twitch Body, and
replay playback slows during recorded twitch spans so the handoff is visible.

The Vite dev server also exposes agent-friendly scenario endpoints:

- `POST /api/scenario/run` with `{ airframe, scenario }` starts a scenario and returns a replay.
- `POST /api/scenario/inspect` with `{ replay, pilotId?, time? }` returns active phase, planner/twitch
  counts, last pilot decision context, and last Body prompt/output context for out-of-sim review.

## Checks

```bash
npm test
npm run build
npm run e2e
```

`npm test` runs deterministic sim tests. `npm run e2e` runs the browser smoke test against the Vite app.

## Headless Runs

```bash
npm run match
npm run film -- --scripted --cinema --out clips/scripted.mp4
FILM_MODE=pilot-intent npm run film -- --scripted --cinema --out clips/body-scripted.mp4
FILM_MODE=pilot-intent npm run film -- deepseek-v4-flash --cinema --out clips/body-live.mp4
FILM_MODE=motor-program FILM_SCENARIO=balloon-hard TWITCH_BODY_MODEL=deepseek-v4-flash PILOT_MAX_TOKENS=4096 npm run film -- deepseek-v4-pro --cinema --out clips/pro-planner-flash-twitch.mp4
FILM_SENSOR_ID=nose-cam npm run film -- --scripted --cinema --out clips/nose-sensor.mp4
FILM_MODE=pilot-intent npm run film -- --scripted --replay-out /tmp/body-replay.json
npm run clip:controls -- --replay /tmp/body-replay.json --out clips/body-cockpit.mp4 --seconds 12
npm run render:native -- --replay /tmp/body-replay.json --camera cinematic --out clips/native-body.mp4
npm run render:native -- --camera pilot-hero --seconds 4 --out clips/native-review-vtuber-topgun.mp4
npm run clip:ensemble -- --out clips/deepseek-v4-flash-ensemble-cockpit.mp4
npm run verify:replay -- clips/deepseek-v4-flash-ensemble-replay.json --require-ensemble
npm run critique:replay -- clips/deepseek-v4-flash-ensemble-replay.json
npm run transcript:replay -- clips/deepseek-v4-flash-ensemble-replay.json --out clips/flight-transcript.md
SWEEP_MODES=pilot-intent SWEEP_BODY_MODEL=scripted npm run sweep
```

`FILM_MODE=pilot-intent` mounts the Body loop. In non-scripted runs, `BODY_MODEL` defaults to the Pilot model; set `BODY_MODEL=scripted` only for the free deterministic Body. Direct DeepSeek slugs such as `deepseek-v4-flash` use `DEEPSEEK_API_KEY`; OpenRouter slugs such as `deepseek/deepseek-v4-flash` use `OPENROUTER_API_KEY`. Film defaults to the airframe's `cockpit-cam`; set `FILM_SENSOR_ID=nose-cam` to render the forward sensor instead.

`FILM_MODE=motor-program` mounts the revised slow-planner/fast-twitch loop. The positional model argument is the slow planner that sees the cockpit `camera-ascii@2` field and emits a 2.5s control tape with 50ms samples and held-action guards. `TWITCH_BODY_MODEL` is the fast Body that wakes when a held `weapons_free` gun-cone guard trips; in non-scripted runs it defaults to direct `deepseek-v4-flash`. `FILM_SCENARIO=balloon-hard` starts a longer off-axis balloon intercept for this path.

Body `MUSCLE` output is treated as a desired motor posture. The runtime applies tone-dependent slew limits before the command reaches aircraft controls, so live Body ticks can be granular without snapping the airframe.

For live Body runs, `BODY_TIMEOUT_MS`, `BODY_MAX_RETRIES`, `BODY_EMPTY_RETRIES`, and `BODY_MAX_TOKENS` tune provider reliability and output budget. `BODY_EMPTY_RETRIES` retries successful-but-empty Body responses with a corrective command-format prompt.

`clip:controls` records the live React viewer, so use it when the clip needs the same cockpit controls, pedals, and HUD overlay the app shows. Pass `--replay` to capture a specific generated match; omit it for the built-in deterministic demo.

`render:native` bypasses Chromium. It exports a deterministic timeline from replay data, asks Blender to build an engine-native scene, renders PNG frames, then encodes the MP4 with ffmpeg. See `docs/native-render-pipeline.md`.

`clip:ensemble` is the repeatable live path. By default it uses direct `deepseek-v4-flash` for both Pilot and Body, writes a sensor film plus replay under `clips/`, verifies that the pilot did not fall back and that the live Body ticks parsed, writes the matching transcript Markdown, then records the cockpit-mounted viewer clip. Use `--transcript-out` to choose the transcript path or `--no-transcript` to skip it.

`critique:replay` turns a replay into prompt/harness notes: fallback validity, Body parse and mismatch rates, range closure, energy, stall, control smoothness, and weapon employment.

The primary debugging workflow is transcript reading. The app's Flight Transcript panel follows replay time and shows Pilot want, Body sense/output, control motion, weapon geometry, EXPECT/ACTUAL, mismatch streaks, and a short human read for each Body tick. `transcript:replay` writes the same moment-by-moment read as Markdown for review beside generated clips.

## Shape

- `src/sim`: deterministic headless simulation, aircraft state, controls, simple aerodynamics, weapon resolution.
- `src/body`: fixed-wing Body manifest, qualitative proprioception, motor grammar parsing, invalid-output policy, and Body runtime.
- `src/protocol`: Zod schemas and public state/action contracts.
- `src/viewer`: React and Three.js replay viewer, telemetry, timeline, and virtual control displays.

The viewer renders replay frames and Body audit traces. It does not own the combat truth.
