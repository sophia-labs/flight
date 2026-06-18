# BVR doctrine sortie comparison r1

## What changed

Added a headless Tomcat BVR doctrine runner at `src/headless/tomcatBvrDoctrineSorties.ts`.

The runner synthesizes the current research into a live planner-only agent:
- GCI datum before radar contact.
- Raw motor-program tape output.
- Explicit lessons for roll impulse/neutralize, altitude preservation, q-limit avoidance, shallow right intercept, and 25 km radar-lock shot gating.
- Cost accounting from provider usage, with stop-on-missing-cost behavior.
- Replay and report artifacts under `reports/coach/bvr-doctrine-*`.

The final runner also adds two important hardenings:
- Compact BVR-specific action rules instead of the generic dogfight motor-program manual.
- A mechanical action filter that strips any `weapons_free` guard except `radar_lock` at `rangeM <= 25000`.

## Paid sortie ledger

| Run | Model | Turns | Cost | Fallbacks | Radar lock | Final altitude | Final health | Notes |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `deepseek-v4-pro-r1` | DeepSeek V4 Pro | 12 | $0.0186 | 0 | no | 1495 m | 53.8 | Original default radar guard; bad sink/over-q. |
| `deepseek-v4-pro-strict-r1` | DeepSeek V4 Pro | 12 | $0.0163 | 0 | no | 1781 m | 58.7 | Default shot guard removed, still overbank/sink. |
| `sonnet-4-6-strict-r1` | Claude Sonnet 4.6 | 12 | $0.1871 | 5 | no | 2306 m | 88.4 | Cleaner throttle and less damage, but OpenRouter token-credit errors after turn 6. |
| `deepseek-v4-pro-compact-r1` | DeepSeek V4 Pro | 12 | $0.0155 | 0 | no | 1931 m | 68.2 | Compact prompt; still prompt-violated by adding gun guards before filter. |
| `deepseek-v4-pro-filter-smoke-r1` | DeepSeek V4 Pro | 4 | $0.0043 | 0 | no | 5571 m | 100.0 | Smoke test of final guard; not a full intercept. |

Total recorded provider spend: **$0.2419**.

Zero-cost failed retries:
- `sonnet-4-6-bvr-override-r2`: OpenRouter refused on max-token credit limit.
- `sonnet-4-6-compact-r1`: OpenRouter refused because prompt tokens exceeded current credit limit.
- `sonnet-4-6-compact-r2`: model/tool call reached the runner but produced invalid numeric args under the 400-token cap.

## Readout

The doctrine transfer is not enough yet. Both DeepSeek and Sonnet can restate the research, but under live raw motor tape they continue to fly the same failure mode: sustained bank/pull, gradual high-speed descent, then q-limit damage before radar acquisition.

Sonnet was materially cleaner than DeepSeek: lower peak speed, much less damage, and a slower altitude loss. It still failed the actual BVR objective and had provider fallbacks, so Opus was not justified under the user's budget instruction.

Prompt-only weapons discipline was also insufficient. DeepSeek kept adding gun guards even after the BVR prompt said not to. The final runner now enforces the BVR shot doctrine mechanically by filtering held actions.

## Engineering implication

The next step should not be "try a smarter planner" first. We need a more cybernetic control surface:
- A deterministic motor-tape compiler for BVR intercept primitives: roll impulse, bank target, load/pitch schedule, throttle schedule, rollout cue.
- Or an intermediate Body that owns bank/load/altitude stabilization while the planner chooses intercept parameters.
- A stable BVR target controller; the current prop target still falls to the deck during the intercept.
- Score terms and observations for altitude floor, q-limit risk, and roll-state error so debrief can teach the specific motor failure.

The current live LLM pilots are still working toward the deterministic motor tape, not matching it.
