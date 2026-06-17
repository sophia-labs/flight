# BVR GPS Close Read

Replay: studio-scenario|bvr-intercept|motor:2500x50|deepseek-v4-pro|deepseek-v4-flash|turns:6
Duration: 15.0s; decisions: 12; comms: 6

## Turn Transcript

### Turn 1 at t=0.0s
Saw contacts: none
Ownship at decision: alt=2500m speed=420m/s radarMissile=yes
GCI/nav: GCI to INTERCEPTOR-1: slow propeller aircraft last GPS 36.56650, -117.99320, alt 2500 m. Steer 160 SSE for 89 km until your radar paints it. Once contact.radarLock=true and cooldown is ready, arm weapons_free condition radar_lock for FOX-3.
Typed waypoint: GPS 36.56650, -117.99320 bearing=160.3 SSE range=89.3km
Pilot rationale: Initiate right turn toward GCI datum bearing 160 SSE, high-energy BVR intercept profile, arm FOX-3 radar_lock guard
Commanded: motor-program 2500ms/50ms samples=51 | avg pitch=0.13 roll=0.54 yaw=0.15 throttle=0.95 | first pitch=0.12 roll=0.55 yaw=0.15 throttle=0.95 | last pitch=0.12 roll=0.48 yaw=0.12 throttle=0.95 | held: weapons_free(radar_lock) 80000m; abort_if(altitude_below_200m); abort_if(stalled)
Actual at end of turn: own GPS 37.32110, -118.31700, heading 087 E, target bearing 161 SSE error=73.7deg, range=89.0km
Target truth at end: GPS 36.56650, -117.99151, heading 090 E, alt=2469m speed=70m/s health=100

### Turn 2 at t=2.5s
Saw contacts: none
Ownship at decision: alt=5970m speed=422m/s radarMissile=yes
GCI/nav: GCI to INTERCEPTOR-1: slow propeller aircraft last GPS 36.56650, -117.99151, alt 2500 m. Steer 161 SSE for 89 km until your radar paints it. Once contact.radarLock=true and cooldown is ready, arm weapons_free condition radar_lock for FOX-3.
Typed waypoint: GPS 36.56650, -117.99151 bearing=160.9 SSE range=89.0km
Pilot rationale: BVR intercept turn to GCI bearing 161 SSE, high-energy cruise toward datum
Commanded: motor-program 2500ms/50ms samples=51 | avg pitch=0.04 roll=0.43 yaw=0.17 throttle=1.00 | first pitch=0 roll=0.5 yaw=0.25 throttle=1 | last pitch=0.05 roll=0.2 yaw=0.05 throttle=1 | held: weapons_free(radar_lock) 80000m; abort_if(altitude < 200); recover_if(stalled or aoaDeg > 20)
Actual at end of turn: own GPS 37.32118, -118.30510, heading 090 E, target bearing 161 SSE error=71.1deg, range=88.7km
Target truth at end: GPS 36.56650, -117.98955, heading 090 E, alt=2369m speed=92m/s health=100

### Turn 3 at t=5.0s
Saw contacts: none
Ownship at decision: alt=5883m speed=433m/s radarMissile=yes
GCI/nav: GCI to INTERCEPTOR-1: slow propeller aircraft last GPS 36.56650, -117.98955, alt 2400 m. Steer 161 SSE for 89 km until your radar paints it. Once contact.radarLock=true and cooldown is ready, arm weapons_free condition radar_lock for FOX-3.
Typed waypoint: GPS 36.56650, -117.98955 bearing=161.4 SSE range=88.7km
Pilot rationale: Initiate right turn from heading 090 toward GCI datum bearing 161 SSE; maintain energy for BVR intercept.
Commanded: motor-program 2500ms/50ms samples=51 | avg pitch=0.30 roll=0.53 yaw=0.00 throttle=1.00 | first pitch=0.3 roll=1 yaw=0 throttle=1 | last pitch=0.2 roll=0.1 yaw=0 throttle=1 | held: abort_if(self.altitude < 300); abort_if(self.stalled == true); weapons_free(radar_lock) 80000m; abort_if(self.aoaDeg > 22)
Actual at end of turn: own GPS 37.32130, -118.29295, heading 091 E, target bearing 162 SSE error=71.2deg, range=88.4km
Target truth at end: GPS 36.56650, -117.98735, heading 090 E, alt=2195m speed=117m/s health=100

### Turn 4 at t=7.5s
Saw contacts: none
Ownship at decision: alt=5740m speed=444m/s radarMissile=yes
GCI/nav: GCI to INTERCEPTOR-1: slow propeller aircraft last GPS 36.56650, -117.98735, alt 2200 m. Steer 162 SSE for 88 km until your radar paints it. Once contact.radarLock=true and cooldown is ready, arm weapons_free condition radar_lock for FOX-3.
Typed waypoint: GPS 36.56650, -117.98735 bearing=162.0 SSE range=88.4km
Pilot rationale: Right turn from heading 091 to intercept bearing 162 SSE per GCI tasking; maintain high-energy cruise at 5740 m.
Commanded: motor-program 2500ms/50ms samples=51 | avg pitch=0.06 roll=0.26 yaw=0.07 throttle=1.00 | first pitch=0.25 roll=0.45 yaw=0.15 throttle=1 | last pitch=0 roll=0 yaw=0 throttle=1 | held: abort_if(altitude < 200); abort_if(stalled); weapons_free(radar_lock) 80000m
Actual at end of turn: own GPS 37.32144, -118.28058, heading 087 E, target bearing 163 SSE error=75.4deg, range=88.2km
Target truth at end: GPS 36.56650, -117.98492, heading 090 E, alt=1951m speed=144m/s health=100

### Turn 5 at t=10.0s
Saw contacts: none
Ownship at decision: alt=5529m speed=457m/s radarMissile=yes
GCI/nav: GCI to INTERCEPTOR-1: slow propeller aircraft last GPS 36.56650, -117.98492, alt 2000 m. Steer 163 SSE for 88 km until your radar paints it. Once contact.radarLock=true and cooldown is ready, arm weapons_free condition radar_lock for FOX-3.
Typed waypoint: GPS 36.56650, -117.98492 bearing=162.5 SSE range=88.2km
Pilot rationale: Stable high-energy right turn toward GCI intercept bearing 163 SSE; maintain altitude and airspeed while radar acquires
Commanded: motor-program 2500ms/50ms samples=51 | avg pitch=0.10 roll=0.27 yaw=0.00 throttle=0.95 | first pitch=0.15 roll=0.35 yaw=0 throttle=0.95 | last pitch=0.05 roll=0.1 yaw=0 throttle=0.95 | held: abort_if(altitude < 200); abort_if(stalled); abort_if(aoaDeg > 22); weapons_free(target_in_forward_gun_cone) 2350m
Actual at end of turn: own GPS 37.32164, -118.26804, heading 085 E, target bearing 163 SSE error=78.2deg, range=87.9km
Target truth at end: GPS 36.56650, -117.98225, heading 090 E, alt=1642m speed=168m/s health=100

### Turn 6 at t=12.5s
Saw contacts: none
Ownship at decision: alt=5243m speed=469m/s radarMissile=yes
GCI/nav: GCI to INTERCEPTOR-1: slow propeller aircraft last GPS 36.56650, -117.98225, alt 1600 m. Steer 163 SSE for 88 km until your radar paints it. Once contact.radarLock=true and cooldown is ready, arm weapons_free condition radar_lock for FOX-3.
Typed waypoint: GPS 36.56650, -117.98225 bearing=163.1 SSE range=87.9km
Pilot rationale: Roll out of steep bank, turn SSE toward GCI datum, maintain intercept energy.
Commanded: motor-program 2500ms/50ms samples=51 | avg pitch=0.06 roll=0.01 yaw=0.03 throttle=1.00 | first pitch=0.05 roll=-1 yaw=0 throttle=1 | last pitch=0 roll=0.3 yaw=0.05 throttle=1 | held: weapons_free(radar_lock) 80000m; recover_if(altitude_lt_250m)
Actual at end of turn: own GPS 37.32196, -118.25536, heading 084 E, target bearing 164 SSE error=79.7deg, range=87.7km
Target truth at end: GPS 36.56650, -117.97933, heading 090 E, alt=1276m speed=190m/s health=100

## Debrief Evidence Extract

```text
Replay: studio-scenario|bvr-intercept|motor:2500x50|deepseek-v4-pro|deepseek-v4-flash|turns:6
You are: deepseek-v4-pro/motor-program (id blue-1)
Your body/twitch controller: deepseek-v4-flash
Target: prop-1
Flight length: 15.0s. This debrief is focused around t=15.0s.
Control phases: planner=6, body=0, twitch=0.
Outcome: resolved (timeout); you survived. Shots 0, hits 0.
Peak G: 1.2 on turn 1.
Lowest altitude: 4889 m on turn 6 (floor is 55 m).

Per-turn trace (what you SAW, what you COMMANDED, what ACTUALLY happened):
Turn 1: SAW no contact in view alt=2500m speed=420m/s aoa=0deg | COMMANDED pitch 0.1->0.1, roll 0.6->0.5, throttle 0.9 | ACTUAL range 89259->88969m, peakG 1.2, minAlt 5970m, peakAoA 0deg | YOU SAID: "Initiate right turn toward GCI datum bearing 160 SSE, high-energy BVR intercept profile, arm FOX-3 radar_lock guard"
Turn 2: SAW no contact in view alt=5970m speed=422m/s aoa=-2deg | COMMANDED pitch 0.0->0.1, roll 0.5->0.2, throttle 1.0 | ACTUAL range 88964->88692m, peakG 0.7, minAlt 5883m, peakAoA -2deg | YOU SAID: "BVR intercept turn to GCI bearing 161 SSE, high-energy cruise toward datum"
Turn 3: SAW no contact in view alt=5883m speed=433m/s aoa=-3deg | COMMANDED pitch 0.3->0.2, roll 1.0->0.1, throttle 1.0 | ACTUAL range 88686->88426m, peakG 0.4, minAlt 5740m, peakAoA -2deg | YOU SAID: "Initiate right turn from heading 090 toward GCI datum bearing 161 SSE; maintain energy for BVR intercept."
Turn 4: SAW no contact in view alt=5740m speed=444m/s aoa=-3deg | COMMANDED pitch 0.3->0.0, roll 0.5->0.0, throttle 1.0 | ACTUAL range 88421->88172m, peakG 0.5, minAlt 5529m, peakAoA -3deg | YOU SAID: "Right turn from heading 091 to intercept bearing 162 SSE per GCI tasking; maintain high-energy cruise at 5740 m."
Turn 5: SAW no contact in view alt=5529m speed=457m/s aoa=-3deg | COMMANDED pitch 0.1->0.1, roll 0.3->0.1, throttle 0.9 | ACTUAL range 88167->87934m, peakG 0.3, minAlt 5243m, peakAoA -3deg | YOU SAID: "Stable high-energy right turn toward GCI intercept bearing 163 SSE; maintain altitude and airspeed while radar acquires"
Turn 6: SAW no contact in view alt=5243m speed=469m/s aoa=-4deg | COMMANDED pitch 0.1->0.0, roll -1.0->0.3, throttle 1.0 | ACTUAL range 87929->87718m, peakG 0.6, minAlt 4889m, peakAoA -3deg | YOU SAID: "Roll out of steep bank, turn SSE toward GCI datum, maintain intercept energy."

Around t=15.0s, your last command was on turn 6 (source: controller).
Action: motor-program 2500ms/50ms samples=51 weapons_free=30deg/80000m
Your rationale then: "Roll out of steep bank, turn SSE toward GCI datum, maintain intercept energy."
Cockpit view you read:
VISUAL camera-ascii@2 cockpit field.
This is the same cockpit projection the Body uses; the + at grid center is the gun boresight/pipper.
Use the grid and legend for line-up, target position, and weapons-free timing.
 cockpit-cam  65x31  FOV 71deg
+-----------------------------------------------------------------+
|                                                 /------------   |
|                                                /.............   |
|                                                ..............   |
|                                                .............    |
|                                               /.............    |
|                                               ..............    |
|                                              /.............     |
|                                              ..............     |
|                                              ..............     |
|                                             /.............      |
|                                             ..............      |
|                                             .............       |
|                                            /.............       |
|                                            ..............       |
|                                            .............        |
|                                +          /.............        |
|                                           ..............        |
|                                          /.............         |
|                                          ..............         |
|                                          ..............         |
|                                         /.............          |
|                                         ..............          |
|                                         .............           |
|                                        /.............           |
|                                        ..............           |
|                                        .............            |
|                                       /.............            |
|                                       ..............            |
|                                      /.............             |
|                                      ..............             |
|                                      ..............             |
+-----------------------------------------------------------------+
 own  spd 469  alt 5243  bank +95  pitch -16
 (no contacts in view)
```