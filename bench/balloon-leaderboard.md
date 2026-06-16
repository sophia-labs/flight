# Balloon-intercept benchmark — embodied Body leaderboard

Same balloon scenario + same scripted anti-dive coaching Pilot for all; the Body model is the only variable.
K=2 matches/model, 8 turns max, BODY_TIMEOUT=20000ms. On-solution = onNose ≥ cos(0.42) AND range ≤ 2900 m (the exact balloon gun cone + range from resolveWeapons).

| # | model | kills/K | mean t-on-balloon (s) | mean latency (s) | parse-rate | $/run |
|---|-------|---------|-----------------------|------------------|------------|-------|
| 1 | `mistralai/mistral-small-3.2-24b-instruct` | 2/2 | 4.48 | 2.42 | 1.00 | $0.0041 |
| 2 | `meta-llama/llama-3.3-70b-instruct` | 2/2 | 4.16 | 4.89 | 0.99 | $0.0074 |
| 3 | `openai/gpt-4o-mini` | 2/2 | 4.08 | 1.42 | 1.00 | $0.0135 |
| 4 | `deepseek-v4-flash` | 2/2 | 4.00 | 1.82 | 1.00 | $0.0056 |
| 5 | `google/gemini-2.5-flash-lite` | 2/2 | 3.68 | 0.85 | 0.99 | $0.0096 |
| 6 | `anthropic/claude-3.5-haiku` | 2/2 | 3.52 | 2.31 | 0.98 | $0.0891 |
| 7 | `qwen/qwen3-30b-a3b` | 2/2 | 3.20 | 4.51 | 0.54 | $0.0091 |

Total benchmark cost: $0.2771  ·  wall-clock: 2762.4s

## Per-model detail

| model | runs | kills | maxTOB (s) | meanTTK (s) | peakOnNose | closest (m) | shots | hits | latency (s) | parse | $/run | errors |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `mistralai/mistral-small-3.2-24b-instruct` | 2 | 2 | 5.44 | 10.96 | 1.000 | 2177 | 2 | 2 | 2.42 | 1.00 | $0.0041 | 0 |
| `meta-llama/llama-3.3-70b-instruct` | 2 | 2 | 4.16 | 9.76 | 1.000 | 2030 | 2 | 2 | 4.89 | 0.99 | $0.0074 | 0 |
| `openai/gpt-4o-mini` | 2 | 2 | 4.16 | 9.76 | 1.000 | 2073 | 2 | 2 | 1.42 | 1.00 | $0.0135 | 0 |
| `deepseek-v4-flash` | 2 | 2 | 4.00 | 9.76 | 1.000 | 2171 | 2 | 2 | 1.82 | 1.00 | $0.0056 | 0 |
| `google/gemini-2.5-flash-lite` | 2 | 2 | 3.84 | 9.76 | 1.000 | 2221 | 2 | 2 | 0.85 | 0.99 | $0.0096 | 0 |
| `anthropic/claude-3.5-haiku` | 2 | 2 | 3.68 | 9.76 | 1.000 | 2205 | 2 | 2 | 2.31 | 0.98 | $0.0891 | 0 |
| `qwen/qwen3-30b-a3b` | 2 | 2 | 3.20 | 9.76 | 1.000 | 2416 | 2 | 2 | 4.51 | 0.54 | $0.0091 | 0 |
