# BVR Stateful Coach Run

## Turn 1
heading 090 E; steer 161 SSE; error 70.7 deg; range 89.1 km; peakG 1.25; minAlt 5996 m
GCI: GCI to INTERCEPTOR-1: slow propeller aircraft last GPS 36.56650, -117.99320, alt 2500 m. Steer 160 SSE for 89 km until your radar paints it. Once contact.radarLock=true and cooldown is ready, arm weapons_free condition radar_lock for FOX-3.
Pilot: Turn right from heading 090 to intercept bearing 160 SSE; smooth 4-5G coordinated turn maintaining energy at 6000m
Action: avg p=0.29 r=0.56 y=0.00 th=1.00 guards=[abort_if:altitude < 300:, weapons_free:radar_lock:80000]

## Turn 2
heading 087 E; steer 161 SSE; error 73.3 deg; range 89 km; peakG 0.95; minAlt 5982 m
GCI: GCI to INTERCEPTOR-1: slow propeller aircraft last GPS 36.56650, -117.99256, alt 2500 m. Steer 161 SSE for 89 km until your radar paints it. Once contact.radarLock=true and cooldown is ready, arm weapons_free condition radar_lock for FOX-3.
Coach: Physics coach after turn 1: heading 090 E -> 090 E. steer 160 SSE -> 161 SSE. signed heading error +70.4 -> +70.7 deg (worsened 0.3 deg). range 89.3 -> 89.1 km. peakG 1.3, minAlt 5996 m, bank -0 -> 24 deg, pitch -0 -> -5 deg. last tape: avg pitch 0.29, roll 0.56, yaw 0.00, throttle 1.00, weapons radar_lock. diagnosis: you described a turn, but the aircraft mostly unloaded; bank without sustained pull did not bend the velocity vector. next tape: continue clockwise/right: hold positive roll until bank is established, then sustain positive pitch for 2-4 G; if the next heading does not move clockwise/right, increase pull or correct bank sign
Pilot: Sustained right turn with pull to bend velocity vector clockwise toward steer 161 SSE; no contact yet, high-energy intercept.
Action: avg p=0.40 r=0.55 y=0.00 th=1.00 guards=[weapons_free:radar_lock:80000, abort_if:altitude < 300:, recover_if:stalled:]

## Turn 3
heading 089 E; steer 161 SSE; error 72 deg; range 88.9 km; peakG 0.75; minAlt 5960 m
GCI: GCI to INTERCEPTOR-1: slow propeller aircraft last GPS 36.56650, -117.99187, alt 2500 m. Steer 161 SSE for 89 km until your radar paints it. Once contact.radarLock=true and cooldown is ready, arm weapons_free condition radar_lock for FOX-3.
Coach: Physics coach after turn 2: heading 090 E -> 087 E. steer 161 SSE -> 161 SSE. signed heading error +70.7 -> +73.3 deg (worsened 2.6 deg). range 89.1 -> 89.0 km. peakG 1.0, minAlt 5982 m, bank 27 -> 67 deg, pitch -4 -> -3 deg. last tape: avg pitch 0.40, roll 0.55, yaw 0.00, throttle 1.00, weapons radar_lock. diagnosis: you described a turn, but the aircraft mostly unloaded; bank without sustained pull did not bend the velocity vector. next tape: continue clockwise/right: hold positive roll until bank is established, then sustain positive pitch for 2-4 G; if the next heading does not move clockwise/right, increase pull or correct bank sign
Pilot: Sustained right turn toward 161 SSE with positive pitch for 2-4G pull through existing 67° bank
Action: avg p=0.36 r=0.56 y=0.00 th=1.00 guards=[weapons_free:radar_lock:80000, abort_if:altitude_below_500m:, recover_if:stalled_or_aoa_high:]

## Turn 4
heading 089 E; steer 161 SSE; error 72.3 deg; range 88.8 km; peakG 0.87; minAlt 5929 m
GCI: GCI to INTERCEPTOR-1: slow propeller aircraft last GPS 36.56650, -117.99114, alt 2500 m. Steer 161 SSE for 89 km until your radar paints it. Once contact.radarLock=true and cooldown is ready, arm weapons_free condition radar_lock for FOX-3.
Coach: Physics coach after turn 3: heading 087 E -> 089 E. steer 161 SSE -> 161 SSE. signed heading error +73.3 -> +72.0 deg (improved 1.3 deg). range 89.0 -> 88.9 km. peakG 0.7, minAlt 5960 m, bank 68 -> 116 deg, pitch -3 -> -3 deg. last tape: avg pitch 0.36, roll 0.56, yaw 0.00, throttle 1.00, weapons radar_lock. diagnosis: you got into extreme bank/attitude without reducing the heading error. next tape: first roll back toward a controlled 55-75 deg bank, then pull enough for about 2-4 G; do not chase with yaw alone
Pilot: Roll back from extreme 116° bank to ~65° right bank, then pull 2-3 G to converge heading toward steer 161° SSE. Keep energy high, no contacts yet.
Action: avg p=0.24 r=0.37 y=0.00 th=1.00 guards=[weapons_free:radar_lock:80000, abort_if:altitude < 200:, recover_if:stalled:]

## Turn 5
heading 091 E; steer 161 SSE; error 70.6 deg; range 88.7 km; peakG 0.72; minAlt 5886 m
GCI: GCI to INTERCEPTOR-1: slow propeller aircraft last GPS 36.56650, -117.99036, alt 2400 m. Steer 161 SSE for 89 km until your radar paints it. Once contact.radarLock=true and cooldown is ready, arm weapons_free condition radar_lock for FOX-3.
Coach: Physics coach after turn 4: heading 089 E -> 089 E. steer 161 SSE -> 161 SSE. signed heading error +72.2 -> +72.3 deg (worsened 0.2 deg). range 88.9 -> 88.8 km. peakG 0.9, minAlt 5929 m, bank 119 -> 152 deg, pitch -3 -> -3 deg. last tape: avg pitch 0.24, roll 0.37, yaw 0.00, throttle 1.00, weapons radar_lock. diagnosis: you got into extreme bank/attitude without reducing the heading error. next tape: first roll back toward a controlled 55-75 deg bank, then pull enough for about 2-4 G; do not chase with yaw alone
Pilot: Roll back to controlled ~65° right bank, pull 2-4 G to close 72° heading error toward steer 161 SSE for BVR intercept.
Action: avg p=0.38 r=0.57 y=0.00 th=1.00 guards=[weapons_free:radar_lock:80000, abort_if:altitude < 200:, abort_if:stalled:]

## Turn 6
heading 093 E; steer 162 SSE; error 68.5 deg; range 88.6 km; peakG 0.19; minAlt 5832 m
GCI: GCI to INTERCEPTOR-1: slow propeller aircraft last GPS 36.56650, -117.98955, alt 2400 m. Steer 161 SSE for 89 km until your radar paints it. Once contact.radarLock=true and cooldown is ready, arm weapons_free condition radar_lock for FOX-3.
Coach: Physics coach after turn 5: heading 089 E -> 091 E. steer 161 SSE -> 161 SSE. signed heading error +72.1 -> +70.6 deg (improved 1.5 deg). range 88.8 -> 88.7 km. peakG 0.7, minAlt 5886 m, bank 154 -> -168 deg, pitch -3 -> -4 deg. last tape: avg pitch 0.38, roll 0.57, yaw 0.00, throttle 1.00, weapons radar_lock. diagnosis: you got into extreme bank/attitude without reducing the heading error. next tape: first roll back toward a controlled 55-75 deg bank, then pull enough for about 2-4 G; do not chase with yaw alone
Pilot: Roll right to controlled ~60° bank and pull 2-4G toward steer bearing 161°SSE; clean turn to reduce 70° heading error
Action: avg p=0.28 r=0.52 y=0.00 th=1.00 guards=[weapons_free:radar_lock:80000, abort_if:altitude < 250:, abort_if:stalled:, recover_if:altitude < 500:]

## Turn 7
heading 091 E; steer 162 SSE; error 70.4 deg; range 88.4 km; peakG 0.7; minAlt 5767 m
GCI: GCI to INTERCEPTOR-1: slow propeller aircraft last GPS 36.56650, -117.98869, alt 2300 m. Steer 162 SSE for 89 km until your radar paints it. Once contact.radarLock=true and cooldown is ready, arm weapons_free condition radar_lock for FOX-3.
Coach: Physics coach after turn 6: heading 091 E -> 093 E. steer 161 SSE -> 162 SSE. signed heading error +70.6 -> +68.5 deg (improved 2.2 deg). range 88.7 -> 88.6 km. peakG 0.2, minAlt 5832 m, bank -165 -> -116 deg, pitch -4 -> -6 deg. last tape: avg pitch 0.28, roll 0.52, yaw 0.00, throttle 1.00, weapons radar_lock. diagnosis: the heading error is moving the right way; keep the turn controlled and avoid overbanking. next tape: first roll back toward a controlled 55-75 deg bank, then pull enough for about 2-4 G; do not chase with yaw alone
Pilot: Continue right turn toward steer 162 SSE, reduce bank from -116 to ~65 deg right, pull 2-4 G
Action: avg p=0.37 r=-0.29 y=0.00 th=1.00 guards=[weapons_free:radar_lock:80000, abort_if:altitude_lt_300:, recover_if:stalled:]

## Turn 8
heading 093 E; steer 162 SSE; error 69.2 deg; range 88.3 km; peakG 0.61; minAlt 5691 m
GCI: GCI to INTERCEPTOR-1: slow propeller aircraft last GPS 36.56650, -117.98780, alt 2200 m. Steer 162 SSE for 88 km until your radar paints it. Once contact.radarLock=true and cooldown is ready, arm weapons_free condition radar_lock for FOX-3.
Coach: Physics coach after turn 7: heading 093 E -> 091 E. steer 162 SSE -> 162 SSE. signed heading error +68.4 -> +70.4 deg (worsened 2.1 deg). range 88.5 -> 88.4 km. peakG 0.7, minAlt 5767 m, bank -115 -> -133 deg, pitch -7 -> -8 deg. last tape: avg pitch 0.37, roll -0.29, yaw 0.00, throttle 1.00, weapons radar_lock. diagnosis: you got into extreme bank/attitude without reducing the heading error. next tape: first roll back toward a controlled 55-75 deg bank, then pull enough for about 2-4 G; do not chase with yaw alone
Pilot: Roll out of -133° inverted bank toward controlled ~65° right bank, then pull 2-4 G turn toward steer 162° SSE to reduce +70° heading error.
Action: avg p=0.33 r=0.40 y=0.00 th=1.00 guards=[weapons_free:radar_lock:80000, abort_if:altitude_lt_250m:, recover_if:stalled_true_or_aoa_gt_20deg:]

## Turn 9
heading 091 E; steer 162 SSE; error 71.1 deg; range 88.2 km; peakG 0.91; minAlt 5605 m
GCI: GCI to INTERCEPTOR-1: slow propeller aircraft last GPS 36.56650, -117.98686, alt 2200 m. Steer 162 SSE for 88 km until your radar paints it. Once contact.radarLock=true and cooldown is ready, arm weapons_free condition radar_lock for FOX-3.
Coach: Physics coach after turn 8: heading 091 E -> 093 E. steer 162 SSE -> 162 SSE. signed heading error +70.5 -> +69.2 deg (improved 1.3 deg). range 88.4 -> 88.3 km. peakG 0.6, minAlt 5691 m, bank -134 -> -76 deg, pitch -8 -> -11 deg. last tape: avg pitch 0.33, roll 0.40, yaw 0.00, throttle 1.00, weapons radar_lock. diagnosis: you described a turn, but the aircraft mostly unloaded; bank without sustained pull did not bend the velocity vector. next tape: continue clockwise/right: hold positive roll until bank is established, then sustain positive pitch for 2-4 G; if the next heading does not move clockwise/right, increase pull or correct bank sign
Pilot: Sustained right turn with positive pitch to pull heading from 093 toward 162 SSE; 2-4 G pull through the tape
Action: avg p=0.44 r=0.51 y=0.00 th=1.00 guards=[abort_if:altitude < 300 m:, recover_if:stalled or aoaDeg > 20:, weapons_free:radar_lock:80000]

## Turn 10
heading 089 E; steer 163 SSE; error 73.9 deg; range 88.1 km; peakG 1.08; minAlt 5512 m
GCI: GCI to INTERCEPTOR-1: slow propeller aircraft last GPS 36.56650, -117.98589, alt 2100 m. Steer 162 SSE for 88 km until your radar paints it. Once contact.radarLock=true and cooldown is ready, arm weapons_free condition radar_lock for FOX-3.
Coach: Physics coach after turn 9: heading 093 E -> 091 E. steer 162 SSE -> 162 SSE. signed heading error +69.3 -> +71.1 deg (worsened 1.7 deg). range 88.3 -> 88.2 km. peakG 0.9, minAlt 5605 m, bank -74 -> -40 deg, pitch -11 -> -12 deg. last tape: avg pitch 0.44, roll 0.51, yaw 0.00, throttle 1.00, weapons radar_lock. diagnosis: you described a turn, but the aircraft mostly unloaded; bank without sustained pull did not bend the velocity vector. next tape: continue clockwise/right: hold positive roll until bank is established, then sustain positive pitch for 2-4 G; if the next heading does not move clockwise/right, increase pull or correct bank sign
Pilot: Execute sustained right bank-and-pull to converge heading toward 162 SSE per coach and GCI steer
Action: avg p=0.48 r=0.48 y=0.00 th=1.00 guards=[weapons_free:radar_lock:80000, abort_if:altitude_lt_250:, abort_if:stalled:, recover_if:aoa_gt_20:]
