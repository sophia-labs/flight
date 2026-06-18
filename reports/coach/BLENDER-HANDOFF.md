# Blender render handoff — AIM-9 missile engagement

A ready-to-render replay of an LLM pilot (DeepSeek V4 Pro) flying a heat-seeker intercept: it starts
~8.5 km out with the balloon 35° off the nose, **banks and turns to orient**, closes to IR-lock range,
fires a **FOX-2**, and the missile tracks ~5.7 s to the kill. Clean, energy-disciplined flying with the
pilot's actual thoughts as captions.

## Files (already generated)
- `reports/coach/missile.json` — the **replay** (authoritative). Frames @ 50 ms, full missile telemetry,
  events, per-turn planner rationale, renderable airframe geometry.
- `reports/coach/missile.timeline.json` — a **pre-built native render timeline** (camera=pilot-hero,
  18 s, 24 fps) with avatar + pilotDynamics + THOUGHT subtitles already baked in.
- `reports/coach/missile.md` / `.digest.json` — the flight diagnostic (human + machine).

## Engagement beats (timestamps, for shot planning)
| t (s) | beat |
|------|------|
| 0.0–10.0 | turn-in: balloon 35°→1° off nose, bank left, 3.7 G, closing 8.5→6.4 km |
| 10.8 | **FOX-2 launch** — event `shot "Blue Kite launches AIM-9M"` |
| 10.8–16.5 | missile tracks (109 frames of projectile telemetry) |
| 16.5 | **balloon killed** — event `hit "missile from blue-1 hits Red Balloon for 72"` |
| 16.5–17.5 | post-kill beat |

## Render it
```bash
# full pipeline (builds timeline + invokes Blender). --seconds 18 covers the whole engagement
# (the default caps at 12 s and would cut off the kill).
npm run render:native -- --replay reports/coach/missile.json --camera pilot-hero --seconds 18 --out clips/missile.mp4
```
Camera modes: `pilot-hero` (VTuber canopy + puppet, avatar auto-loaded), `cinematic` (multi-shot cuts),
`split-balloon` (split-screen pilot + orbit), `chase`, `orbit`, `cockpit`.

## Data channels for subtitles + the VTuber puppet
- **`timeline.subtitles`** — the pilot's THOUGHTS (`label:"THOUGHT"`, the per-turn rationale, e.g.
  *"Roll left to put the balloon on the nose for an AIM-9 lock."*). Consumed by `SubtitleOverlay` in
  `tools/blender/render_native_flight.py`. (FEEL-labelled subs are the Body's proprioception — not
  present in this no-Body run.)
- **`timeline.avatar`** — the VRM puppet (`public/models/VRM1_Constraint_Twist_Sample.vrm`); driven by
  `AvatarRig`.
- **`timeline.frames[].pilotPose`** — per-frame full pilot pose, same shape the React viewer uses.
  `bones` (per-VRM-bone Euler rotations in radians, offset from rest pose), `expressions` (VRM blend
  shape weights 0–1: `angry`, `ih`, `relaxed`, `aa`), and `lookAt` (screen-space offset). The Blender
  importer applies these as quaternion-offset-from-rest on each bone and maps expression names to
  VRM blend shapes.
- **`replay.frames[].projectiles`** — missile `position`, `velocity`, `lockState`, `seekerAngleDeg`,
  `targetHeat`, `lockSignal` — for animating the missile body + smoke trail.

## Other replays in this dir (for variety / B-roll)
- `doctrine-hard.json` — pure *flying* drama: hard off-axis maneuvering, climbing reversals (no weapon).
- `doctrine.json` / `baseline.json` — gun-coaching runs (baseline ends in a near-deck dive — dramatic
  but a "failure" beat).

Note: this replay has no `agentPhases` (it's the no-twitch path), so there are no planner/twitch overlay
spans — not needed for this render.
