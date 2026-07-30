# Changelog

## Unreleased
- Remote render box now uses the AWS Deep Learning GPU AMI on `g5.xlarge` by default, can select a baked `ami_id`, includes `tools/bake-render-ami.sh` plus an idempotent host setup guard to avoid per-render Blender/ffmpeg installs, sizes the root volume for GPU AMIs, packages the payload as a Terraform-managed S3 object before EC2 boot, preserves timeline-relative avatar paths, supports `RENDER_SAMPLES`, uses `user_data_base64`, keeps SSH opt-in and restricted to the caller IP, enables SSM Session Manager access, removes deprecated IAM inline policy usage, and makes `tools/render-remote.sh` a single apply/wait/download flow.

- **MissionControl**: full-screen cinematic progress overlay during scenario execution. Replaces the cramped right-panel progress bar with a dark monospace mission-control display featuring an animated radar scope (sweep line, aircraft dots, turn counter), slide-in decision log cards (agent + action + rationale), a scrolling body-tick terminal feed, a segmented timeline bar, and a green "SCENARIO COMPLETE" pulse transition.
- Added live streaming match progress. `runMatch()` accepts an optional `onProgress` callback emitting `turn_start`, `decision`, `body_tick`, `frame`, and `complete` events. The `/api/scenario/run` endpoint detects `Accept: text/event-stream` and streams SSE progress events; the JSON-only path is unchanged.
- Client-side scripted matches also stream progress through the same `onProgress` contract; `launchFlight()` unifies both paths, accumulating decisions and body ticks into reactive state for MissionControl.

- Added live Body LLM support to the headless film and sweep paths through `FILM_MODE=pilot-intent`, `BODY_MODEL`, `SWEEP_MODES`, and `SWEEP_BODY_MODEL`.
- Body ticks now optionally record model usage, cost, latency, and provider errors; provider failures become invalid-recovery ticks instead of crashing a match.
- Match stats and sweep summaries now include total run cost plus Body-specific cost and parse-rate accounting.
- Centralized mounted camera pose math so perception, cabin view, and film use the same airframe sensor mount; film now defaults to `cockpit-cam` with `FILM_SENSOR_ID` for explicit alternatives.
- Added viewer-backed cockpit clip ergonomics: `film.ts` can write `--replay-out`, and `clip:controls` can capture a specific replay through the React cabin/HUD/cockpit-control path.
- Added replay verification and `clip:ensemble`, a repeatable DeepSeek V4 Flash Pilot+Body path that refuses to call a capture ensemble-flown unless the pilot avoided fallback and live Body ticks parsed.
- Tightened the live Body prompt contract so V4 Flash reliably emits the strict five-line motor grammar instead of prose or word-valued controls.
- Smoothed the React cockpit playback path by interpolating the frame data that drives cockpit controls, pedals, surface telemetry, and HUD readouts.
- Added `critique:replay` for prompt/harness iteration over live ensemble runs: fallback validity, Body mismatches, control smoothness, range closure, energy, and weapons use.
- Added Body-control slew limiting so live muscle commands move the aircraft toward a desired posture instead of snapping full controls every Body tick.
- Added Body mismatch calibration cues and stronger Pilot phase/weapon-employment guidance for prompt iteration after replay critique.
- Added live Body empty-response retries (`BODY_EMPTY_RETRIES`) so successful-but-empty model calls get a corrective retry before invalid recovery.

## 0.8.0 - Embodied Body Control Loop

- Added replay schema v4 with `pilot-intent` actions and per-frame `bodyTicks`.
- Added a fixed-wing Body manifest, qualitative proprioception encoder, strict motor grammar parser, invalid-output policy, and deterministic local Body model.
- Added an optional `piBodyModel` adapter so the same Body grammar can be driven by a tiny OpenRouter model when credentials/latency budget allow.
- Routed the generated blue aircraft through a Body loop at physics cadence: Pilot intent -> Body muscle grammar -> mechanical control input -> surface-force physics -> actual result/mismatch.
- Added Body audit UI showing current muscle command, pain, FEEL, MEM, expectation, actual result, and mismatch.
- Preserved legacy raw-stick, setpoint, and flight-director modes for comparison.
