# Coach diagnostic — baseline

planner=deepseek-v4-pro  scenario=balloon  field=off  turns≤14
decisions=14  fallbacks=0  pilotCost=$0.0137  replay=reports/coach/baseline.json

## Flying score (no shots fired — would-hit geometry)
closestRange=71m   peak alignment=0.0° off nose (1.0=dead-on → 1.000)
would-hit time=4.10s   first firing position=0.0s   would-hit on turns=[1,3,4,12]
(a round reaches 2900m; within 42m of the axis = a hit)

## Energy & control (competenceEvaluator)
energyRetained=1.34   meanAirspeed=219m/s   minAlt=55m
fracStalled=0.00   fracOnDeck=0.06   controlSmoothness=0.57

## Per turn — what it SAW, what it COMMANDED
turn src  rng off° R     U     clo   | alt  spd aoa  g   st | tape (start→end[min,max])
 1  ok  2800   0 -0.00  0.00  -150 | 1320 150   0 1.0 . | p+0.00→+0.00[+0.00,+0.00] r+0.00→+0.00[+0.00,+0.00] thr+1.00→+1.00[+1.00,+1.00] ◄would-hit
        “Balloon dead ahead at 2800m, fly straight to close range for guns”
 2  ok  2401   2  0.00  0.04  -169 | 1300 169  -0 0.8 . | p+0.15→+0.00[+0.00,+0.15] r+0.00→+0.00[+0.00,+0.00] thr+1.00→+1.00[+1.00,+1.00]
        “Line up pipper on stationary balloon slightly above nose, authorize guns”
 3  ok  1954   2  0.00  0.03  -188 | 1273 188  -0 1.1 . | p+0.00→+0.00[+0.00,+0.12] r+0.00→+0.00[+0.00,+0.00] thr+1.00→+1.00[+1.00,+1.00] ◄would-hit
        “Hot pursuit closure; slight pitch-up to bring pipper onto balloon for guns handoff.”
 4  ok  1461   1  0.00  0.03  -206 | 1250 206  -1 1.0 . | p+0.04→+0.00[+0.00,+0.04] r+0.00→+0.00[+0.00,+0.00] thr+1.00→+1.00[+1.00,+1.00] ◄would-hit
        “finish the wounded balloon dead ahead with a slight nose-up correction and weapons_free handoff”
 5  ok   925   4  0.00  0.07  -223 | 1228 223  -1 0.7 . | p-0.08→+0.00[-0.08,+0.00] r+0.00→+0.00[+0.00,+0.00] thr+1.00→+1.00[+1.00,+1.00]
        “Clean guns shot: target dead ahead, slight high, range 925m, health 12. Nudge nose down onto target.”
 6  ok   347  13  0.00  0.23  -236 | 1184 241  -1 0.8 . | p+0.05→+0.00[-0.05,+0.08] r+0.00→+0.00[+0.00,+0.00] thr+0.80→+0.90[+0.80,+0.90]
        “Close-range gun pass on damaged balloon dead ahead, slight high”
 7  ok   290 169  0.00  0.19   249 | 1128 256  -2 0.2 . | p+0.00→+0.00[+0.00,+0.95] r+0.60→+0.00[+0.00,+1.00] thr+1.00→+1.00[+1.00,+1.00]
        “Hard reversing turn to engage balloon that is directly behind”
 8  ok   912 137 -0.17  0.66   215 | 1044 254  13 12.3 . | p+0.40→+0.00[+0.00,+0.70] r-0.60→+0.00[-0.60,+0.10] thr+1.00→+1.00[+1.00,+1.00]
        “Reversal: target behind/above/left, need to bring nose around for gun solution on low-health balloon”
 9  ok  1339 115  0.11  0.90   125 |  816 257   5 6.1 . | p+0.90→+0.80[+0.80,+0.90] r+0.80→+0.50[+0.50,+0.80] thr+1.00→+1.00[+1.00,+1.00]
        yaw +0.30→+0.20[+0.20,+0.30]  held=[weapons_free,abort_if,abort_if]
        “Aggressive climbing reversal to bring rear-high balloon into gun solution”
10  ok  1569 101 -0.96  0.18    63 |  483 253  13 13.3 . | p+0.70→+0.30[+0.30,+0.90] r-1.00→-0.30[-1.00,-0.30] thr+1.00→+1.00[+1.00,+1.00]
        yaw +0.00→+0.20[+0.00,+0.20]  held=[weapons_free,abort_if,abort_if,recover_if]
        “Hard left turn to bring nose to target on left beam”
11  ok  1553  55  0.55  0.61  -151 |   57 224  -6 2.9 . | p+0.60→+0.35[+0.35,+0.70] r+0.55→+0.05[+0.05,+0.55] thr+1.00→+1.00[+1.00,+1.00]
        yaw +0.20→+0.00[+0.00,+0.20]  held=[weapons_free,abort_if,abort_if,recover_if]
        “Aggressive lead pursuit against high-right balloon, pull nose onto target for guns solution”
12  ok  1111   8 -0.11  0.09  -202 |  256 209   9 7.2 . | p+0.12→+0.00[+0.00,+0.12] r+0.00→+0.00[+0.00,+0.00] thr+1.00→+1.00[+1.00,+1.00] ◄would-hit
        yaw -0.08→+0.00[-0.08,+0.00]  held=[weapons_free,abort_if,abort_if,recover_if]
        “Fine pipper correction: target nearly dead ahead, minor left/up offset, closing fast on wounded balloon”
13  ok   605  10 -0.17  0.02  -199 |  683 201  -2 0.4 . | p+0.08→+0.00[+0.00,+0.08] r-0.12→+0.00[-0.12,+0.00] thr+1.00→+1.00[+1.00,+1.00]
        yaw -0.15→+0.00[-0.15,+0.00]  held=[weapons_free,abort_if,recover_if]
        “Clean gun shot: target 605m, nearly dead ahead, slight left and up correction”
14  ok   133  44 -0.69 -0.04  -148 | 1108 197  -1 0.6 . | p+0.70→+0.10[+0.00,+0.70] r-1.00→+0.00[-1.00,+0.20] thr+1.00→+1.00[+1.00,+1.00]
        yaw -0.50→+0.00[-0.50,+0.10]  held=[weapons_free,abort_if,abort_if]
        “Hard left roll and pull to bring pipper onto close balloon at 133m, slight low”
