# Changelog

## 0.8.0 - Embodied Body Control Loop

- Added replay schema v4 with `pilot-intent` actions and per-frame `bodyTicks`.
- Added a fixed-wing Body manifest, qualitative proprioception encoder, strict motor grammar parser, invalid-output policy, and deterministic local Body model.
- Added an optional `piBodyModel` adapter so the same Body grammar can be driven by a tiny OpenRouter model when credentials/latency budget allow.
- Routed the generated blue aircraft through a Body loop at physics cadence: Pilot intent -> Body muscle grammar -> mechanical control input -> surface-force physics -> actual result/mismatch.
- Added Body audit UI showing current muscle command, pain, FEEL, MEM, expectation, actual result, and mismatch.
- Preserved legacy raw-stick, setpoint, and flight-director modes for comparison.
