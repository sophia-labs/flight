# Coach diagnostic — doctrine

planner=deepseek-v4-pro  scenario=balloon  field=off  turns≤14
decisions=14  fallbacks=0  pilotCost=$0.0146  replay=reports/coach/doctrine.json

## Flying score (no shots fired — would-hit geometry)
closestRange=30m   peak alignment=0.0° off nose (1.0=dead-on → 1.000)
would-hit time=4.90s   first firing position=0.0s   would-hit on turns=[1,5,6]
(a round reaches 2900m; within 42m of the axis = a hit)

## Energy & control (competenceEvaluator)
energyRetained=1.49   meanAirspeed=182m/s   minAlt=1156m
fracStalled=0.00   fracOnDeck=0.00   controlSmoothness=0.85

## Per turn — what it SAW, what it COMMANDED
turn src  rng off° R     U     clo   | alt  spd aoa  g   st | tape (start→end[min,max])
 1  ok  2800   0 -0.00  0.00  -150 | 1320 150   0 1.0 . | p+0.00→+0.00[+0.00,+0.00] r+0.00→+0.00[+0.00,+0.00] thr+0.75→+0.75[+0.75,+0.75] ◄would-hit
        “close range on stationary balloon dead ahead, stable level flight for handoff”
 2  ok  2406   3  0.00  0.05  -165 | 1300 165  -1 0.7 . | p+0.08→+0.00[+0.00,+0.08] r+0.00→+0.00[+0.00,+0.00] thr+0.90→+0.50[+0.50,+0.90]
        “Close on balloon dead ahead with slight nose-up to center pipper”
 3  ok  1975   6  0.00  0.10  -178 | 1260 179  -1 0.7 . | p+0.08→+0.00[+0.00,+0.08] r+0.00→+0.00[+0.00,+0.00] thr+1.00→+1.00[+1.00,+1.00]
        “Close straight on balloon, slight nose-up to centre pipper, hold weapons_free for gun pass.”
 4  ok  1505   9 -0.00  0.15  -197 | 1204 199  -1 0.8 . | p+0.18→+0.10[+0.10,+0.18] r+0.00→+0.00[+0.00,+0.00] thr+0.55→+0.55[+0.55,+0.55]
        “gentle pitch-up to bring pipper onto balloon, manage closure for shot”
 5  ok   998   3  0.00  0.06  -209 | 1156 209   2 2.4 . | p+0.00→+0.02[+0.00,+0.09] r+0.00→+0.00[+0.00,+0.00] thr+0.35→+0.35[+0.35,+0.35] ◄would-hit
        “balloon dead ahead, slight low, closure ~208 m/s; decelerate to avoid overshoot and settle pipper”
 6  ok   470   5 -0.00  0.09  -213 | 1170 214  -1 0.8 . | p+0.15→+0.00[+0.00,+0.15] r+0.00→+0.00[+0.00,+0.00] thr+0.30→+0.50[+0.30,+0.50] ◄would-hit
        “Closing fast on damaged balloon; chop throttle to avoid overshoot, pull lead for gun shot”
 7  ok    75 157 -0.00  0.39   200 | 1197 218  -1 1.1 . | p+0.50→+0.00[-0.15,+0.65] r+0.00→+0.00[+0.00,+0.00] thr+0.30→+0.50[+0.30,+0.50]
        “Stationary balloon dead ahead 75m, high closure — chop and pull up to avoid overshoot, then weapons_free for the shot”
 8  ok   599 166 -0.00  0.24   205 | 1316 212  -0 1.3 . | p+0.85→+0.35[+0.35,+0.90] r+0.00→+0.00[+0.00,+0.35] thr+0.65→+0.40[+0.40,+0.65]
        “Immelmann reversal to reacquire balloon behind and above”
 9  ok  1073 131 -0.08  0.76   152 | 1605 190  13 6.7 . | p+0.80→+0.50[+0.50,+0.80] r-0.25→+0.00[-0.25,+0.00] thr+0.80→+0.65[+0.65,+0.80]
        “Target behind and above: climbing left turn to reverse and re-engage balloon”
10  ok  1361 102  0.14  0.97    74 | 2017 166  15 5.2 . | p+0.65→+0.10[+0.10,+0.65] r+0.30→+0.00[+0.00,+0.30] thr+0.70→+0.50[+0.50,+0.70]
        “Pull nose up and right to capture balloon above and behind the nose”
11  ok  1453  88  0.06  1.00    11 | 2332 148   6 2.1 . | p+0.80→+0.75[+0.75,+0.80] r+0.08→+0.06[+0.06,+0.08] thr+0.88→+0.85[+0.85,+0.88]
        “Aggressive pitch-up to bring nose onto high balloon target; slight right roll for lateral alignment”
12  ok  1431  60 -0.08  0.87   -38 | 2488 148  15 3.8 . | p+0.35→+0.20[+0.20,+0.35] r-0.25→+0.00[-0.25,+0.00] thr+0.40→+0.30[+0.30,+0.40]
        “Slice turn toward target, reduce closure, bring nose to bear”
13  ok  1251  48 -0.14  0.72   -95 | 2397 153   4 1.6 . | p+0.45→+0.20[+0.20,+0.55] r-0.25→+0.15[-0.35,+0.15] thr+0.50→+0.50[+0.40,+0.50]
        “Slice turn to pull nose onto high right-quarter target while managing closure and avoiding overshoot”
14  ok   976  36 -0.01  0.59  -128 | 2127 174   7 3.1 . | p+0.35→+0.10[+0.10,+0.45] r+0.00→+0.00[+0.00,+0.00] thr+0.35→+0.60[+0.30,+0.60]
        “closure high negative; chop throttle to bleed speed, pitch up to capture target in gun cone, then hold for weapons_free guard”
