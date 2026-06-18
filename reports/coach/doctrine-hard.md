# Coach diagnostic — doctrine-hard

planner=deepseek-v4-pro  scenario=balloon-hard  field=off  turns≤18
decisions=18  fallbacks=0  pilotCost=$0.0177  replay=reports/coach/doctrine-hard.json

## Flying score (no shots fired — would-hit geometry)
closestRange=231m   peak alignment=3.9° off nose (1.0=dead-on → 0.998)
would-hit time=0.00s   first firing position=NEVER   would-hit on turns=[none]
(a round reaches 2900m; within 42m of the axis = a hit)

## Energy & control (competenceEvaluator)
energyRetained=1.31   meanAirspeed=244m/s   minAlt=642m
fracStalled=0.00   fracOnDeck=0.00   controlSmoothness=0.71

## Per turn — what it SAW, what it COMMANDED
turn src  rng off° R     U     clo   | alt  spd aoa  g   st | tape (start→end[min,max])
 1  ok  5645   4 -0.07 -0.00  -168 | 1520 168   0 1.0 . | p+0.08→+0.05[+0.05,+0.08] r+0.00→+0.00[+0.00,+0.00] thr+0.70→+0.45[+0.45,+0.70]
        yaw -0.06→-0.02[-0.06,-0.02]  held=[weapons_free,abort_if,abort_if,recover_if]
        “Smooth approach to balloon target, center pipper, manage closure for gun pass”
 2  ok  5211   5 -0.08 -0.02  -179 | 1501 179   0 1.1 . | p+0.15→+0.08[+0.08,+0.15] r+0.00→+0.00[+0.00,+0.00] thr+1.00→+1.00[+1.00,+1.00]
        “Straight run toward balloon at 5.2 km, shallow climb to preserve energy, slight right correction for bearing alignment.”
 3  ok  4743   8 -0.08 -0.12  -194 | 1500 196   1 1.8 . | p-0.12→-0.12[-0.12,-0.12] r-0.06→-0.06[-0.06,-0.06] thr+0.90→+0.90[+0.90,+0.90]
        “gentle pipper correction onto balloon, close range, weapons_free guard for reflex handoff”
 4  ok  4239   7 -0.09  0.09  -210 | 1514 210  -4 1.0 . | p+0.10→+0.03[+0.03,+0.10] r+0.00→+0.00[+0.00,+0.00] thr+0.90→+0.90[+0.90,+0.90]
        “Close on balloon dead ahead with gentle nose alignment, hold speed for now, set guns guard”
 5  ok  3694   5 -0.08  0.04  -227 | 1458 227   0 1.7 . | p+0.02→+0.02[+0.02,+0.02] r+0.00→+0.00[+0.00,+0.00] thr+0.95→+0.95[+0.95,+0.95]
        “Close on stationary balloon target, maintain nose-on, prepare for throttle reduction”
 6  ok  3106   5 -0.07  0.04  -243 | 1416 244  -1 1.1 . | p+0.08→+0.00[+0.00,+0.08] r+0.04→+0.00[+0.00,+0.04] thr+0.90→+0.50[+0.50,+0.90]
        “Close on balloon dead ahead, slight correction to center, prepare guns”
 7  ok  2480   4 -0.07  0.03  -256 | 1380 256  -2 0.8 . | p+0.08→+0.02[+0.02,+0.08] r+0.10→+0.02[+0.02,+0.10] thr+0.40→+0.40[+0.32,+0.40]
        “Guns pass setup: target nearly dead ahead, high closure, need to bleed speed and center pipper”
 8  ok  1834   5 -0.08  0.01  -261 | 1346 262  -1 1.0 . | p+0.00→+0.00[+0.00,+0.00] r+0.00→+0.00[+0.00,+0.00] thr+0.50→+0.50[+0.50,+0.50]
        “guns run on balloon: steady nose, chop throttle to avoid overshoot, weapons-free guard”
 9  ok  1174   8 -0.13  0.05  -267 | 1307 269  -2 0.6 . | p+0.15→+0.03[+0.03,+0.20] r+0.18→+0.00[+0.00,+0.18] thr+0.35→+0.30[+0.30,+0.35]
        “merge entry: chop throttle, roll right, pitch up to put pipper on target, handoff with guns guard”
10  ok   520  27 -0.30 -0.34  -242 | 1300 270   1 2.8 . | p-0.18→+0.02[-0.18,+0.02] r-0.35→+0.00[-0.35,+0.00] thr+0.20→+0.40[+0.20,+0.40]
        yaw -0.15→+0.00[-0.15,+0.00]  held=[weapons_free,abort_if,recover_if]
        “Hard throttle chop to bleed closure, roll left and pitch down to track balloon through pipper for gun kill”
11  ok   307 130 -0.75 -0.10   177 | 1322 271  -4 0.8 . | p+0.35→+0.00[-0.02,+0.35] r+0.70→+0.00[+0.00,+0.70] thr+0.70→+0.70[+0.70,+0.70]
        yaw +0.15→+0.00[-0.03,+0.15]  held=[abort_if,abort_if,weapons_free]
        “Overshoot recovery: target is behind 3-9 line and right, climbing turn to re-engage”
12  ok   928 172  0.00 -0.14   276 | 1310 278  -1 1.5 . | p+0.05→+0.05[+0.05,+0.55] r+0.30→+0.00[+0.00,+0.80] thr+0.90→+0.80[+0.80,+0.90]
        “reverse 180° to re-engage balloon behind me”
13  ok  1610 143 -0.05  0.60   245 | 1222 280   9 10.6 . | p+0.25→+0.35[+0.00,+0.55] r+0.00→-0.30[-0.90,+0.00] thr+0.90→+0.70[+0.70,+0.90]
        “Hard break: target is 1.6 km but bearingForward is -0.80 (behind me) and closureRate is +245 m/s opening fast. I'm in a 10.6G pull already wasting energy. Need to unload, reverse turn, and reacquire.”
14  ok  2170 137  0.65  0.18   220 |  764 290  10 13.0 . | p+0.50→+0.05[+0.05,+0.55] r-0.80→+0.00[-0.90,+0.00] thr+0.40→+0.70[+0.35,+0.70]
        yaw +0.30→+0.00[-0.02,+0.30]  held=[weapons_free,abort_if,recover_if]
        “Hard break turn to bring balloon into forward hemisphere”
15  ok  2784 168  0.18  0.09   267 |  647 272   6 8.5 . | p+0.50→+0.05[+0.05,+0.80] r+0.90→+0.00[+0.00,+0.90] thr+1.00→+0.50[+0.50,+1.00]
        “Hard reversal: enemy is behind me (bearingForward -0.98), closing fast at 267 m/s. I need to turn hard to face the threat.”
16  ok  3342 119 -0.22  0.85   143 |  780 252   7 7.4 . | p+0.30→+0.15[+0.15,+0.40] r-0.25→+0.05[-0.25,+0.10] flips=1 thr+0.35→+0.35[+0.35,+0.35]
        “energy-and-nose-positioning-approach-merge”
17  ok  3606 102 -0.11  0.97    64 | 1199 232   4 4.7 . | p+0.65→+0.35[+0.35,+0.70] r-0.15→+0.00[-0.15,+0.00] thr+0.90→+0.85[+0.85,+0.90]
        “Pull nose up to target well above, slight left roll correction, close range”
18  ok  3597  55  0.03  0.82   -85 | 1627 209  11 7.2 . | p+0.55→+0.55[+0.55,+0.55] r+0.02→+0.02[+0.02,+0.02] thr+0.90→+0.90[+0.90,+0.90]
        “Pull nose up to high balloon at 3.6km, center laterally, conserve energy for closure”
