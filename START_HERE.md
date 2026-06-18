# START HERE: Coach / Psychologist Handoff

This repo is a flight combat game and agent lab. The next phase is not just "make the model win."
The work is to coach an embodied pilot system: understand what the Pilot thought it wanted, what the
Body felt and did, where the handoff broke down, and how to improve the prompts and interfaces without
turning the aircraft into scripted behavior.

Use this document as the first orientation point before changing code.

## Current Direction

Flight is moving toward a modern game loop where scenarios are spawned from the Studio UI, watched as
replays, and inspected by agents. The important recent direction is the distributed Pilot / Body system:

- `Body Pilot`: a Pilot emits a high-level `pilot-intent`; the Body flies every tick using muscle grammar.
- `Motor Tape`: a slower planner emits a smooth 2.5 second control tape, usually sampled every 50 ms.
- `Twitch Body`: when a held guard such as `weapons_free` trips, a faster Body wakes, sees the cockpit
  ASCII field, refines the nose position, and calls `SOLUTION now` if it has the shot.

The game now exposes these controls in Studio Scene mode. A user should be able to pick a scenario,
choose the control loop, tune planner and Body/twitch models, run the scenario, watch the replay, and
see when the agent enters twitch mode and playback slows down.

## First Commands

From repo root:

```bash
npm install
npm run dev
```

Open `http://127.0.0.1:5173/`.

Useful checks:

```bash
npm test
npm run build
npm run e2e
```

Live model runs need credentials in `.env` or the shell:

```bash
DEEPSEEK_API_KEY=...
OPENROUTER_API_KEY=...
```

Direct DeepSeek slugs are first-party and use `DEEPSEEK_API_KEY`, for example:

- `deepseek-v4-pro` for the slow planner
- `deepseek-v4-flash` for the twitch Body

OpenRouter slugs look like `deepseek/deepseek-v4-flash` and use `OPENROUTER_API_KEY`.

## What To Try First In The UI

1. Open Studio at `http://127.0.0.1:5173/`.
2. Click `Scene`.
3. Set `Loop` to `Motor Tape`.
4. Use `Hard Balloon`.
5. Set planner to `DeepSeek V4 Pro`.
6. Set twitch to `DeepSeek V4 Flash`.
7. Keep `Tape` at `2.5s`, `Step` at `50ms`, and `Slow` at `0.35x`.
8. Run the scenario.
9. Watch the replay and look for the `Planner` / `Twitch` badge over the stage.

If the replay has `agentPhases`, the viewer uses those spans to show active mode and slow playback
during twitch windows. If it is an older Body replay with no phase spans, the Body panel and transcript
still show Body tick evidence.

## Agent-Facing Scenario Flow

The Vite dev server exposes two scenario endpoints:

- `POST /api/scenario/run` with `{ airframe, scenario }`
- `POST /api/scenario/inspect` with `{ replay, pilotId?, time? }`

`/api/scenario/run` returns a full replay after the run completes. It is not streaming yet.

`/api/scenario/inspect` is the bridge for agent monitoring and out-of-sim conversation. It returns:

- active planner/body/twitch phase at a time
- planner/body/twitch phase counts
- last Pilot decision, rationale, action summary, and observation text
- last Body prompt, raw output, field, feel, and solution

This is the mechanism for "take the pilot/body out of the sim and talk to them." The next coaching loop
should build on this rather than scraping React panels.

## Replay Evidence To Read

A replay is the authoritative artifact. Look at:

- `replay.decisions`: Pilot or planner observations, actions, rationales, usage, fallback state.
- `replay.bodyTicks`: Body prompts, proprioception, raw output, parsed muscle grammar, solution, latency.
- `replay.agentPhases`: planner/twitch spans for the motor-program path.
- `replay.frames`: physics truth for positions, controls, events, projectiles, and hits.

Do not call a model "flying" if its decisions came from fallback. Check `decision.source`.
Do not call a Body "live" if the replay has a scripted Body model.

For headless replay reading:

```bash
npm run transcript:replay -- path/to/replay.json --out /tmp/flight-transcript.md
npm run verify:replay -- path/to/replay.json --require-ensemble
```

## Mental Model For Coaching

Treat the agent as a distributed pilot, not as one monolithic model.

The slow Pilot/planner should:

- maintain tactical geometry and energy
- use cockpit `camera-ascii@2`, not just numeric bearings
- write smooth, flyable control intentions
- arm a held action instead of directly firing through the whole tape
- avoid over-controlling when the target is near the pipper

The Body/twitch controller should:

- live one tick at a time
- read proprioception and the ASCII field
- keep the aircraft controllable
- make small pipper corrections in twitch mode
- call `SOLUTION now` only when the target is centered and weapons are free

The coach should diagnose:

- Did the Pilot lose the visual picture?
- Did it confuse vertical sign, high/low, or bearingUp?
- Did the motor tape stay smooth, or did it fight itself?
- Did twitch wake too late, too briefly, or not latch long enough?
- Did Body grammar parse, but the felt expectation mismatch physics?
- Did the prompt ask for something the aircraft cannot do?

The psychologist role is to improve the communication contract between Pilot and Body. Do not solve
this by injecting scripted flight behavior.

## Important Files

- `src/studio/schema.ts`: Studio scenario config, model slugs, motor tape tuning fields.
- `src/viewer/StudioScreen.tsx`: Scene UI controls and replay panels.
- `src/viewer/FlightScene.tsx`: playback clock; slows during twitch via replay phase spans.
- `src/replay/agentPhases.ts`: shared active-phase and playback-time-scale helpers.
- `src/server/scenarioRun.ts`: builds server-side scenario match configs from Studio scenarios.
- `src/server/scenarioAgent.ts`: inspect endpoint helper for agent monitoring and out-of-sim context.
- `src/runtime/match.ts`: core match loop; records decisions, Body ticks, and motor-program phase spans.
- `src/runtime/scenario.ts`: scenario starts, including `balloon-hard`.
- `src/protocol/schema.ts`: Zod contracts for actions, replay frames, Body ticks, and `agentPhases`.
- `src/agent/actionSpec.ts`: model-facing action specs, including `set_motor_program`.
- `src/agent/controllers/pi.ts`: model controller and shared flight rules.
- `src/body/telemetry.ts`: Body prompt construction and gun discipline cue.
- `src/body/model.ts`: scripted Body fallback used for deterministic tests.
- `tests/motorProgram.test.ts`: motor-program and twitch handoff coverage.
- `tests/scenarioApi.test.ts`: server scenario builder and inspect helper coverage.
- `tests/e2e/visual.spec.ts`: browser smoke, including Scene motor tape controls.

## Current Handoff State

Recent integration work is uncommitted. There are also unrelated untracked files in the worktree from
earlier exploration; do not sweep them into a commit without checking scope.

Known verification state at this handoff:

- `npm test` passed after the integration changes.
- `npm run build` passed after the integration changes.
- `npm run e2e` passed after serializing Playwright workers and updating stale builder/HUD checks.
- After that, an extra Scene-mode motor tape browser smoke was added and passed in desktop isolation.
- A final full e2e rerun was intentionally interrupted by the user. Rerun `npm run e2e` before claiming
  the latest tree is fully browser-green.

The dev server may already be running on `127.0.0.1:5173`. Check with:

```bash
lsof -n -P -iTCP:5173 -sTCP:LISTEN
```

Playwright is intentionally serialized with `workers: 1` because the VRM/WebGL tests were saturating
the browser/GPU path when desktop and mobile ran at the same time.

## Known Gaps

- Scenario execution via `/api/scenario/run` returns a replay after completion. A true live monitor
  stream is not implemented yet.
- The inspect endpoint can extract pilot/body context from a replay, but it does not yet call a chat
  model to conduct a coaching conversation.
- Motor-program/twitch handoff is integrated into game replays, but live model reliability still needs
  prompt coaching and scenario iteration.
- A live hard-balloon shootdown is not yet a stable product guarantee. Treat each replay as evidence,
  not as proof that the architecture is solved.
- Full game-engine integration is still future work; this repo currently uses the React/Three Studio
  app and deterministic replay system as the modern game surface.

## Coaching Loop To Use Next

1. Spawn a scenario from Scene mode or `/api/scenario/run`.
2. Inspect the replay with `/api/scenario/inspect` at the interesting time.
3. Read `decisions`, `bodyTicks`, and `agentPhases`.
4. Ask what the Pilot believed, what the Body felt, and where the contract failed.
5. Change prompts or action contracts only where the evidence points.
6. Rerun the same scenario and compare replay evidence.
7. Keep scripted behavior out of the live path unless it is a deterministic test fixture.

The intended next milestone is a coaching and prompt-development loop where a supervising agent can
launch a scenario, watch it, extract the Pilot/Body context, talk through the failure mode, update the
prompt/interface, and rerun. This document tees up that work.
