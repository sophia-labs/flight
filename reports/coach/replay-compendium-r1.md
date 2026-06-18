# Replay compendium r1

## Scope

This compendium covers every replay-shaped JSON artifact currently available under `reports/`:
top-level `id`, `frames[]`, and aircraft state over time. It excludes summaries, digests, envelope
reports, and tabular row dumps.

Chronology is filesystem mtime rendered in `America/Montevideo`. Costs are replay-recorded provider
usage when present. Some Sonnet retry artifacts are all-fallback replays; they are included because
they document provider/contract failure modes, but they should not be read as successful model flights.

Replay count: **23**.
Recorded replay spend: **about $0.88**.

## Conceptual Progression

1. **Balloon coaching baseline.** We first tested whether a planner could improve ordinary motor
   flying against balloon tasks. The doctrine improved safety and altitude retention, but not enough
   to create reliable task completion.
2. **Missile sear validation.** The missile replay showed that weapon authorization and seeker release
   can work when geometry is already plausible.
3. **Simplified BVR validation.** Short-range radar-lock setups proved the active-radar stack can shoot
   and hit, but also showed that a naive BVR pilot can kill the target while destroying itself.
4. **Full BVR/GCI runs.** The full 89 km setup exposed the true problem: no initial radar contact, large
   lateral geometry error, and the target falling toward the deck.
5. **Deterministic motor-tape proof.** A searched tape proved the Tomcat can mechanically reach radar
   lock and fire, but the trace was ugly: low altitude, q-limit damage, and a deck-level target.
6. **Doctrine transfer to live LLM pilots.** DeepSeek and Sonnet could state the lessons but still flew
   sustained bank/pull into descent and over-q damage.
7. **Mechanical guard hardening.** Prompt-only weapon discipline failed, so the runner now strips
   premature or wrong `weapons_free` guards.
8. **Half-second receding horizon.** Shorter increments made the first 10 seconds much cleaner, but the
   same descent basin returned over a full 30 seconds.
9. **Both-side tactics.** The BVR target was fixed into a stable training datum. That removed a real
   scenario bug, but the Tomcat still needs a control-layer change.

## Chronological Replay Index

| # | Local Time | Replay | Stage | Duration | Decisions/Fallbacks | Cost | Blue Final | Target Final | Final Range | Locks | Shots/Hits | Annotation |
| ---: | --- | --- | --- | ---: | ---: | ---: | --- | --- | ---: | ---: | ---: | --- |
| 1 | 2026-06-16 21:18 | `reports/coach/baseline.json` | Balloon baseline | 35s | 14/0 | $0.0137 | 1549m / 99.8hp | balloon 1222m | 375m | 0 | 0/0 | First numeric coaching baseline. It closed near the balloon but scraped the deck earlier and did not complete the kill. |
| 2 | 2026-06-16 21:26 | `reports/coach/doctrine.json` | Balloon doctrine | 35s | 14/0 | $0.0146 | 1710m / 100hp | balloon 1222m | 609m | 0 | 0/0 | Added doctrine improved safety and altitude retention, but still did not solve final task execution. |
| 3 | 2026-06-16 21:34 | `reports/coach/doctrine-hard.json` | Balloon hard holdout | 45s | 18/0 | $0.0177 | 1828m / 100hp | balloon 1235m | 3248m | 0 | 0/0 | Harder holdout showed the safer doctrine generalized somewhat, but closure/control remained weak. |
| 4 | 2026-06-16 22:02 | `reports/coach/missile.json` | Missile sear | 17.5s | 7/0 | $0.0066 | 1214m / 100hp | balloon 1235m / dead | 4554m | 0 | 1/1 | Validated that missile authorization and release can work when the geometry is not the main bottleneck. |
| 5 | 2026-06-17 16:00 | `reports/bvr-live/simplified-bvr-live-replay.json` | Simplified BVR | 20s | 4/0 | $0.0066 | 286m / 0hp | prop 460m / dead | 16652m | 3 | 3/1 | Short-range setup proved radar lock and hit mechanics, but the pilot destroyed itself in the process. |
| 6 | 2026-06-17 16:01 | `reports/bvr-live/simplified-bvr-live-clean-replay.json` | Simplified BVR clean | 15s | 3/0 | $0.0032 | 4716m / 96.8hp | prop 4672m / dead | 11424m | 3 | 2/1 | Cleaner high-altitude short-range BVR proof: active-radar kill without immediate self-destruction. |
| 7 | 2026-06-17 17:57 | `reports/bvr-live/bvr-gps-close-read-replay.json` | Full BVR close read | 15s | 6/0 | $0.0084 | 4889m / 98hp | prop 1276m | 87718m | 0 | 0/0 | First close read of full 89 km GCI BVR. No radar lock; target already sinking. |
| 8 | 2026-06-17 18:16 | `reports/bvr-live/bvr-stateful-coach-run.json` | Stateful coach | 10s | 10/0 | $0.0197 | 5512m / 100hp | prop 1952m | 88109m | 0 | 0/0 | Stateful coaching kept the early Tomcat trace high and healthy, but only over the first 10 seconds. |
| 9 | 2026-06-17 18:19 | `reports/bvr-live/bvr-stateful-coach-run-2.json` | Stateful coach retry | 8s | 8/0 | $0.0136 | 5691m / 100hp | prop 2153m | 88286m | 0 | 0/0 | Shorter repeat confirmed early-phase improvement, still before radar acquisition. |
| 10 | 2026-06-17 18:29 | `reports/bvr-live/bvr-sonnet-4.6-coach-bench.json` | Sonnet coach bench | 8s | 8/0 | $0.3012 | 5681m / 100hp | prop 2153m | 88273m | 0 | 0/0 | Sonnet produced a similar safe early trace at much higher cost; no evidence yet of acquisition. |
| 11 | 2026-06-17 21:51 | `reports/coach/tomcat-bvr-motor-tape-motor-high-r1-best-replay.json` | Deterministic motor tape | 302.5s | 121/0 | - | 3304m / 38.6hp | prop 55m | 24383m | 82 | 1/0 | Reachability proof. The Tomcat eventually got radar lock and fired, but the trace was not pedagogically acceptable. |
| 12 | 2026-06-17 22:16 | `reports/coach/bvr-doctrine-deepseek-v4-pro-r1/sortie-1-deepseek-v4-pro.json` | DeepSeek doctrine baseline | 30s | 12/0 | $0.0186 | 1495m / 53.8hp | prop 142m | 85407m | 0 | 0/0 | Prompted doctrine did not transfer: the pilot repeated sustained bank/pull and descended into damage. |
| 13 | 2026-06-17 22:20 | `reports/coach/bvr-doctrine-deepseek-v4-pro-strict-r1/sortie-1-deepseek-v4-pro.json` | Strict shot gate | 30s | 12/0 | $0.0163 | 1781m / 58.7hp | prop 142m | 85058m | 0 | 0/0 | Removed hidden default radar guard; behavior still converged to the same descent basin. |
| 14 | 2026-06-17 22:23 | `reports/coach/bvr-doctrine-sonnet-4-6-strict-r1/sortie-1-anthropic-claude-sonnet-4-6.json` | Sonnet doctrine | 30s | 12/5 | $0.1871 | 2306m / 88.4hp | prop 142m | 84959m | 0 | 0/0 | Sonnet was cleaner and less damaging, but had fallbacks and still did not acquire radar. |
| 15 | 2026-06-17 22:25 | `reports/coach/bvr-doctrine-sonnet-4-6-bvr-override-r2/sortie-1-anthropic-claude-sonnet-4-6.json` | Sonnet provider limit | 30s | 12/12 | - | 2358m / 94hp | prop 142m | 86712m | 0 | 0/0 | All fallback due provider/token limits. Useful as failure evidence, not as a Sonnet flight. |
| 16 | 2026-06-17 22:26 | `reports/coach/bvr-doctrine-sonnet-4-6-compact-r1/sortie-1-anthropic-claude-sonnet-4-6.json` | Sonnet compact refusal | 30s | 12/12 | - | 2358m / 94hp | prop 142m | 86712m | 0 | 0/0 | All fallback because the prompt still exceeded the current OpenRouter credit/token envelope. |
| 17 | 2026-06-17 22:27 | `reports/coach/bvr-doctrine-sonnet-4-6-compact-r2/sortie-1-anthropic-claude-sonnet-4-6.json` | Sonnet invalid args | 30s | 12/12 | - | 2358m / 94hp | prop 142m | 86712m | 0 | 0/0 | All fallback after clipped/invalid tool arguments. Documents contract fragility under tight token caps. |
| 18 | 2026-06-17 22:30 | `reports/coach/bvr-doctrine-deepseek-v4-pro-compact-r1/sortie-1-deepseek-v4-pro.json` | Compact doctrine | 30s | 12/0 | $0.0155 | 1931m / 68.2hp | prop 142m | 85168m | 0 | 0/0 | Compact prompt reduced bulk but DeepSeek still violated weapons discipline and flew the same basic profile. |
| 19 | 2026-06-17 22:32 | `reports/coach/bvr-doctrine-deepseek-v4-pro-filter-smoke-r1/sortie-1-deepseek-v4-pro.json` | Mechanical guard smoke | 10s | 4/0 | $0.0043 | 5571m / 100hp | prop 1951m | 87980m | 0 | 0/0 | Smoke test for mechanical `weapons_free` filtering. Healthy early trace, not a full intercept. |
| 20 | 2026-06-18 01:24 | `reports/coach/bvr-doctrine-deepseek-v4-pro-halfsec-r1/sortie-1-deepseek-v4-pro.json` | Half-second short | 10s | 20/0 | $0.0245 | 5609m / 100hp | prop 1952m | 88043m | 0 | 0/0 | Half-second receding horizon materially improved the first 10 seconds. |
| 21 | 2026-06-18 01:34 | `reports/coach/bvr-doctrine-deepseek-v4-pro-halfsec-30s-r1/sortie-1-deepseek-v4-pro.json` | Half-second full | 30s | 60/0 | $0.0688 | 1859m / 69hp | prop 138m | 85292m | 0 | 0/0 | Over 30 seconds, the old descent/over-q basin returned despite finer control increments. |
| 22 | 2026-06-18 11:55 | `reports/coach/bvr-doctrine-deepseek-v4-pro-halfsec-leveltarget-r1/sortie-1-deepseek-v4-pro.json` | Weak level target | 30s | 60/0 | $0.0707 | 2090m / 78hp | prop 239m | 85574m | 0 | 0/0 | First red-side target fix was insufficient; the prop still fell low, though Tomcat health improved. |
| 23 | 2026-06-18 12:11 | `reports/coach/bvr-doctrine-deepseek-v4-pro-halfsec-leveltarget-r2/sortie-1-deepseek-v4-pro.json` | Trimmed level target | 30s | 60/0 | $0.0705 | 1967m / 73.9hp | prop 2448m | 85000m | 0 | 0/0 | Target pathology fixed. Tomcat still failed, isolating the remaining problem to pilot/control tactics. |

## Main Lessons

- The active-radar weapon stack works when geometry is favorable.
- The full BVR scenario is hard because initial geometry, raw motor tapes, altitude/speed/q-limit, and
  target behavior all interact.
- The deterministic motor tape proves reachability, but not a humane/live-pilot policy.
- Prompting a smarter tactical story helps models describe the problem, not reliably fly the solution.
- Half-second control is a useful diagnostic and early-phase mitigation, but too slow and still unstable
  as the primary live pilot interface.
- The stable BVR target should stay. It makes future training honest by removing the false lesson of
  chasing a falling prop.
- The next useful artifact is probably not another sortie. It is a bank/load/altitude Body primitive or
  deterministic BVR motor-tape compiler that converts tactical intent into stable low-level control.
