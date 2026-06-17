# BVR GPS Intercept And Stateful Physics Coaching

Date: 2026-06-17

## Goal

The BVR preset should be playable from the scenario menu as a round-by-round planning exercise:

1. Start `BVR GPS Intercept`.
2. The Tomcat pilot does not get omniscient target contacts.
3. GCI sends the last known GPS datum for the prop plane, target altitude, steer bearing, and range.
4. The pilot flies stick-level motor programs toward the datum until the nose radar gets a real contact.
5. A FOX-3 shot is authorized only when `contact.radarLock=true`.
6. The operator can advance one planning frame at a time or autoplay rounds.

The pilot should still be "flying stick." The system should teach from physics evidence, not replace stick flying with a heading autopilot.

## Implementation Map

- `src/runtime/comms.ts` carries typed messages, live operator messages, GCI tasking, and now read-only replay history for providers.
- `src/runtime/navigation.ts` converts local sim positions into GPS, compass bearings, waypoints, and ownship navigation fixes.
- `src/runtime/match.ts` exposes `createMatchRoundStepper`, records comms in replays, and gives comms providers frames/decisions/comms accumulated before the current decision.
- `src/runtime/physicsCoach.ts` is a deterministic stateful coach. It reads only previous frames and the previous decision, then emits a `coach` message with:
  - heading start/end
  - steer bearing start/end
  - signed heading-error change
  - range change
  - peak G
  - min altitude
  - bank and pitch attitude
  - prior tape summary
  - a concrete next-tape correction
- `src/server/scenarioRun.ts` wires the BVR preset to GCI GPS messages plus the physics coach.
- `src/agent/actionSpec.ts` supports a BVR-specific motor-program default: omitted weapons-free guards become `radar_lock` rather than the generic gun-cone guard.
- `src/viewer/StudioScreen.tsx` and `src/App.tsx` expose `Next Agent Round` / `Auto Rounds`.

## Important Fixes

- The BVR Tomcat now starts with consistent position altitude and metrics altitude. The first observation no longer says 2500 m while the aircraft is actually at 6000 m.
- The BVR motor-program pilot no longer silently falls back to `target_in_forward_gun_cone` when it omits a weapons guard. The BVR default is `weapons_free(radar_lock)`.
- The GCI GPS datum is repeated each round and includes typed `navigation.waypoints`.
- The physics coach messages are recorded in replay comms, so close reads and debriefs can audit exactly what instruction the pilot received.

## Bench Results

The key lesson from the DeepSeek and Sonnet runs is that target GPS was not the bottleneck. Both pilots received GPS and steer bearing, understood the task in rationale, and still failed to turn the aircraft decisively toward SSE.

| Pilot | Setup | Best heading error | Final heading error | Best peak G | Cost |
| --- | --- | ---: | ---: | ---: | ---: |
| DeepSeek Pro | 8 x 1s rounds, GCI + physics coach | 69.1 deg | 72.8 deg | 1.90 G | $0.0136 |
| Sonnet 4.6 | 8 x 1s rounds, GCI + physics coach | 69.2 deg | 71.2 deg | 1.56 G | $0.3012 |

Artifacts:

- `reports/bvr-live/bvr-gps-close-read.md`
- `reports/bvr-live/bvr-gps-pilot-interview.md`
- `reports/bvr-live/bvr-stateful-coach-run-2.md`
- `reports/bvr-live/bvr-sonnet-4.6-coach-bench.md`

## Current Diagnosis

The pilots are not missing target location. They are missing calibrated stick-flying skill for this aircraft:

- They say "turn right to SSE" but write tapes that only create small heading-rate.
- They overbank past controlled attitude, then spend later rounds recovering.
- They assume `pitch +0.6..+0.8` should yield 2-4 G, but the replay often shows 1.0-1.6 G.
- A shorter planning cadence helps only when paired with physics-derived feedback.

The next curriculum should separate two skills:

1. Capture and hold a controlled 55-75 deg bank without rolling through it.
2. Once bank is controlled, pull enough to get measured G and heading-rate, then verify heading error improved next round.

This preserves stick flying while giving the pilot the same kind of feedback a flight instructor would provide after each maneuver.

## Verification

Last verified on 2026-06-17:

- `npx tsc --noEmit`
- `npx vitest run tests/comms.test.ts tests/motorProgram.test.ts tests/scenarioApi.test.ts`
- `npm test`
- `npm run build`
- `git diff --check`
