# Changelog

## Unreleased

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
