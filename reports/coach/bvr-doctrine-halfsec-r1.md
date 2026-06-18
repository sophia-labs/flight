# BVR doctrine half-second control r1

## Change

Parameterized `src/headless/tomcatBvrDoctrineSorties.ts` with `BVR_DOCTRINE_TURN_DURATION_S`.

For `BVR_DOCTRINE_TURN_DURATION_S=0.5`, the runner now:
- sets the match turn duration to 0.5 s,
- prompts for a 500 ms motor program,
- forces normalized actions to `durationMs=500`,
- uses sparse knots at `0, 250, 500` ms,
- reports `turnDurationS` and `programMs`,
- filters `weapons_free` guards against the live observation, so no radar guard survives unless the current observation has `radarLock=true` at `range <= 25000`.

## Runs

| Run | Turn interval | Sim time | Decisions | Cost | Final altitude | Final health | Max speed | Radar lock |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `deepseek-v4-pro-halfsec-r1` | 0.5 s | 10 s | 20 | $0.0245 | 5609 m | 100.0 | 420 m/s | no |
| `deepseek-v4-pro-halfsec-30s-r1` | 0.5 s | 30 s | 60 | $0.0688 | 1859 m | 69.0 | 446 m/s | no |

Comparison against prior 30 s DeepSeek runs:

| Run | Turn interval | Decisions | Cost | Closure | Final altitude | Final health | Max speed |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `deepseek-v4-pro-strict-r1` | 2.5 s | 12 | $0.0163 | 4207 m | 1781 m | 58.7 | 458 m/s |
| `deepseek-v4-pro-compact-r1` | 2.5 s | 12 | $0.0155 | 4097 m | 1931 m | 68.2 | 452 m/s |
| `deepseek-v4-pro-halfsec-30s-r1` | 0.5 s | 60 | $0.0688 | 3974 m | 1859 m | 69.0 | 446 m/s |

## Readout

Half-second receding-horizon control materially improves the early trace. At 10 s the Tomcat is still high, healthy, and under the q-limit:
- altitude 5570 m at 10 s,
- health 100,
- speed 418 m/s.

But it does not solve the 30 s BVR problem. The same basin returns after about 15-20 s:
- altitude 4980 m at 15 s,
- altitude 4144 m at 20 s,
- health loss begins around 22.5 s as the aircraft descends fast,
- final altitude 1859 m and health 69.0 at 30 s.

The half-second loop is therefore useful but not sufficient. It reduces open-loop damage and makes early corrections less catastrophic, but the planner still chooses a sustained bank/pull policy that slowly trades altitude for heading change. The prop target also falls to the deck during the same window, which keeps pulling the intercept geometry downward.

## Implication

Shorter LLM increments are not the missing cybernetic layer. They are a mitigation.

The next control surface should be one of:
- a Body primitive that stabilizes bank/load/altitude while the planner chooses heading or intercept parameters,
- a deterministic BVR motor-tape compiler with bank target, load target, altitude floor, and rollout cue,
- or a curriculum that explicitly scores roll-state error and altitude leakage before asking for full BVR acquisition.
