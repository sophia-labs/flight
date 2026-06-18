# Tomcat BVR diagnosis r1

## Question
Why is it so hard to get a good Tomcat-like trace in the BVR scenario: engine, airframe, control surfaces, sensors, or something else?

## Short answer
The dominant blocker is not engine thrust or radar/weapon availability. It is the combination of:

1. Initial geometry: the target starts ~70 deg right of the nose, so the Tomcat must turn a long way before radar geometry is good.
2. Raw motor-tape controls: sustained roll input means continuous roll, not a commanded bank hold. A live pilot must author roll-in, neutralize, pitch/load, and roll-out explicitly.
3. Q-limit/energy coupling: at 420 m/s the Tomcat is safe at the 6000 m start, but if it descends to ~3000 m it is at/over the q-limit and takes damage. In the successful motor tape, health loss begins at ~25 s around 3150 m while still at ~419 m/s.
4. Target/scenario pathology: Day Tripper’s current “gentle” raw-stick controller crashes the prop into the floor around 22 s. This turns the task into a long look-down/deck chase, not a clean BVR intercept.

## Evidence from the saved motor-tape success
Artifact: `reports/coach/tomcat-bvr-motor-tape-motor-high-r1-best-replay.json`

The trace proves reachability but not doctrine quality:
- Initial range: 89265 m.
- First radar lock: turn 40, range 76920 m.
- 25 km radar point: turn 121, range 24959 m, altitude 3239 m, speed 251 m/s.
- AIM-54C shot: 300.05 s.
- But minimum Tomcat altitude: 55 m.
- Final Tomcat health: 39.
- Max G: 13.9.

The successful profile was `high-a6000-b12-p0.1-pa0.00009-t0.02`: bank limit 12 deg, low base throttle 0.02, pitch-base 0.1, altitude target 6000 m.

## Engine
Not the primary blocker.

Compiled Tomcat stats show a strong jet:
- mass ~32,850 kg, wing area ~50.7 m2.
- afterburner thrust ~245.5 kN, thrust/weight ~0.76.
- performance envelope tests require >200 kN afterburner thrust, Mach >2, and >40k fpm climb capability.

The problem is not insufficient thrust to close. The problem is that once the trace descends at high speed, the sim’s q-limit punishes it. At sea level, 420 m/s is ~108 kPa dynamic pressure against a 75 kPa q-limit, a 44% exceedance. At 3000 m, 420 m/s is ~76.8 kPa, still slightly over the limit. At 6000 m, 420 m/s is fine.

## Airframe / aero model
Partly a blocker, mainly through high wing loading and q-limit behavior.

The Tomcat is heavy in the compiled model:
- wing loading ~6361 N/m2.
- stall speed rises with altitude: ~78 m/s sea level, ~110 m/s at 6000 m, ~130 m/s at 9000 m.
- At 6000 m, useful turn rates exist, but a 420 m/s turn has a large radius and lower sustained turn rate than a 250-310 m/s profile.

So a good trace should not be “burn straight, dive, then yank.” It should stay high, manage speed, and use shallow-to-moderate intercept geometry.

## Control surfaces / control interface
This is a major practical blocker for live pilots.

The compiled surfaces are not obviously missing: wings roll, tailerons pitch, fins yaw. But the live agent interface is `motor-program`, meaning raw controls. There is no bank-hold or load-hold protection in the tape itself.

A constant-tape probe from the BVR start showed that even modest sustained roll inputs tend to become roll/spiral problems. Sustained roll is not a bank command; it is continuous roll authority. The pilot must learn a sequence:
- roll impulse toward the target,
- neutralize roll near desired bank,
- hold enough pitch/load to avoid under-1g descent,
- roll out before the radar point,
- manage throttle/speed without speedbrakes.

The successful replay shows under-1g/high-speed descent early, followed by q-limit damage before recovery. That is why the trace looks bad even though it eventually gets the lock.

## Sensors / weapons
Not the main blocker, but the initial sensor geometry is real.

The radar model is simple and appears functional:
- nose radar max range: 120 km.
- radar cone half-angle: 0.35 rad, about 20 deg.
- Phoenix effective radar weapon range gate: 85 km.

The initial target is ~89.3 km away and about 70 deg right of the nose, so the radar-only sensor correctly sees nothing at the first decision. The server BVR scenario gives a GCI waypoint, so the pilot has offboard datum tasking before radar contact. Once the nose gets inside the cone, radar lock appears; the saved trace gets first lock at ~76.9 km and fires at 24.96 km.

## Target/scenario issue
Day Tripper is currently a bad BVR target because its raw-stick “gentle” controller does not actually hold altitude over long runs. In the saved replay the prop reaches the floor around 22 s. A static-target isolation kept the target at 2500 m but the Tomcat still damaged itself, so target fall is not the primary Tomcat-control failure. It is still a scenario quality bug: a BVR training target should not crash before the intercept.

## Working conclusion
The hard part is not “bad engine” or “broken radar.” It is a coupled pedagogy/control problem:

- The sim asks a live pilot to fly a high-speed, off-axis intercept using raw 2.5 s motor tapes.
- The q-limit model makes high-speed descent lethal below ~3 km.
- The target starts outside the radar cone, so the pilot must use GCI-style navigation until acquisition.
- The prop target currently falls to the floor, making terminal geometry uglier than intended.

## Recommended next fixes
1. Add a BVR-specific motor-tape curriculum: roll-in/neutralize, shallow intercept, altitude-preserving closure, terminal radar cone stabilization.
2. Add deterministic score terms for “never below 3000 m,” “no q-limit damage,” “radar lock at <=25 km,” and “target remains alive/airborne.”
3. Replace Day Tripper’s BVR target controller with a stable level-flight controller or static/waypoint target fixture.
4. Consider an agent-facing higher-level primitive for `targetBankDeg + targetLoadG` inside training, while still requiring final motor-tape distillation.
5. Surface q-limit/overspeed warnings in observations and debriefs; current pilots do not get enough explicit feedback that descending at 420 m/s is killing the airframe.
