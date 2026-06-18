# Coach diagnostic — missile

planner=deepseek-v4-pro  scenario=missile  field=off  turns≤18
decisions=7  fallbacks=0  pilotCost=$0.0066  replay=reports/coach/missile.json

## Flying score (no shots fired — would-hit geometry)
closestRange=4554m   peak alignment=0.9° off nose (1.0=dead-on → 1.000)
would-hit time=0.00s   first firing position=NEVER   would-hit on turns=[none]
(a round reaches 2900m; within 42m of the axis = a hit)

## Missile engagement (AIM-9 FOX-2)
launched=10.8s   lock=10.8s   balloon killed=16.5s   shots=1 hits=1

## Energy & control (competenceEvaluator)
energyRetained=1.55   meanAirspeed=240m/s   minAlt=1214m
fracStalled=0.00   fracOnDeck=0.00   controlSmoothness=0.87

## Per turn — what it SAW, what it COMMANDED
turn src  rng off° R     U     clo   | alt  spd aoa  g   st | tape (start→end[min,max])
 1  ok  8532  35 -0.57 -0.01  -160 | 1640 195   0 1.0 . | p+0.00→+0.05[+0.00,+0.30] r+0.00→-0.05[-0.50,+0.00] thr+0.90→+0.90[+0.90,+0.90]
        “Roll left to put the balloon on the nose for an AIM-9 lock.”
 2  ok  8111  27 -0.39  0.22  -181 | 1639 208   5 3.7 . | p+0.15→+0.10[+0.10,+0.25] r-0.25→-0.05[-0.30,-0.05] thr+1.00→+1.00[+1.00,+1.00]
        “center the balloon for missile lock; it's left and above, closing fast”
 3  ok  7614   9 -0.13  0.10  -214 | 1692 218   3 2.9 . | p+0.15→+0.00[+0.00,+0.15] r-0.20→+0.00[-0.20,+0.00] thr+0.50→+0.30[+0.30,+0.50]
        “Close range on slow balloon, center target for missile lock, manage energy for merge”
 4  ok  7066   1 -0.00 -0.02  -223 | 1697 223  -2 0.6 . | p+0.04→+0.01[+0.01,+0.04] r+0.01→+0.00[+0.00,+0.01] thr+0.95→+0.95[+0.95,+0.95]
        “maintain nose-on track for imminent AIM-9 lock as closure brings target into range”
 5  ok  6489   8  0.09 -0.12  -238 | 1629 241  -1 0.8 . | p-0.12→+0.00[-0.12,+0.00] r+0.09→+0.00[+0.00,+0.09] thr+0.95→+0.90[+0.90,+0.95]
        “Line up on distant balloon dead ahead, slight right/down correction to center pipper, prepare missile lock.”
 6  ok  5874  13  0.21 -0.05  -254 | 1488 261  -3 0.3 . | p+0.12→+0.12[+0.12,+0.12] r+0.28→+0.28[+0.28,+0.28] thr+0.95→+0.95[+0.95,+0.95]
        “close on stationary balloon dead ahead, slight right/low correction”
 7  ok  5227  19  0.33  0.05  -264 | 1300 280   1 3.7 . | p+0.15→+0.15[+0.15,+0.15] r+0.20→+0.20[+0.20,+0.20] thr+0.90→+0.80[+0.80,+0.90]
        “Close range on balloon target from ~5.2 km; maintain energy while reducing closure for eventual gun pass.”
