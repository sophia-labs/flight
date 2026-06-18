# BVR doctrine both-tactics r1

## Changes

Improved both sides of the BVR training setup:

- Blue/Tomcat doctrine now explicitly says to solve lateral geometry first, treat 6000 m as altitude capital, avoid nose-down radar search, recover above 5500 m before radar contact, and gate FOX-3 authorization to radar lock inside 25 km.
- Red/Day Tripper now uses a BVR-specific level target controller instead of the old sightseeing raw-stick controller.
- BVR scenario starts Day Tripper at a trimmed cruise speed of 105 m/s instead of 55 m/s, avoiding the early energy hole that caused it to sink into the deck.
- The server BVR scenario now uses the level BVR target, so the app and headless runner train against the same target behavior.

## Target-only check

No LLM calls. Blue held static; Day Tripper used the new BVR target controller for 30 s.

| Time | Target altitude | Target speed |
| ---: | ---: | ---: |
| 0.0 s | 2500 m | 105 m/s |
| 10.0 s | 2410 m | 126 m/s |
| 20.0 s | 2399 m | 130 m/s |
| 30.0 s | 2448 m | 130 m/s |

This fixes the target pathology. The target no longer falls to the floor during the intercept window.

## Paid DeepSeek comparison

All runs are 30 s, 0.5 s decision interval, DeepSeek V4 Pro.

| Run | Target | Cost | Closure | Final Tomcat alt | Final Tomcat health | Final target alt | Radar lock |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| `deepseek-v4-pro-halfsec-30s-r1` | stock falling target | $0.0688 | 3974 m | 1859 m | 69.0 | 138 m | no |
| `deepseek-v4-pro-halfsec-leveltarget-r1` | weak level target | $0.0707 | 3691 m | 2090 m | 78.0 | 239 m | no |
| `deepseek-v4-pro-halfsec-leveltarget-r2` | trimmed level target | $0.0705 | 4265 m | 1967 m | 73.9 | 2448 m | no |

## Readout

The target fix worked. The Tomcat fix helped the prompt but did not change the learned control basin enough.

With the final stable target, the Tomcat still followed the same underlying pattern:
- 10 s: 5588 m, health 100, speed 418 m/s.
- 15 s: 5018 m, health 100, speed 424 m/s.
- 20 s: 4225 m, health 100, speed 433 m/s.
- 25 s: 3197 m, health 96.3, speed 442 m/s.
- 30 s: 1967 m, health 73.9, speed 446 m/s.

So the deck-chase target was a real bug, but not the root cause of the Tomcat failure. The live planner still treats heading correction as sustained bank/pull and leaks altitude until q-limit damage starts.

## Implication

We should keep the level BVR target and the stronger high-intercept doctrine. They make the scenario more pedagogically honest.

But the next real move is still a control-layer change: bank/load/altitude stabilization as a Body primitive or deterministic BVR motor-tape compiler. Prompt tactics alone do not make raw motor tapes cybernetically stable enough.
