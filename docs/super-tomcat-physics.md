# Super Tomcat Physics Pass

This pass adds the first credible jet-age envelope to the flight sim: an F-14D-style Super Tomcat. The goal is qualitative physics fidelity, not a flight-manual simulator. The important behavior is that the Tomcat is fast for the right reasons and limited by the right regimes.

## Modeled Effects

- Afterburning turbofan propulsion with dry thrust, afterburner thrust, fuel flow, altitude/Mach thrust lapse, inlet recovery, and live engine spool lag.
- Mach-aware atmosphere helpers: temperature, speed of sound, Mach number, dynamic pressure, and q/Mach envelope limits.
- Compressibility and wave drag with sweep-delayed drag rise.
- Variable-sweep wing schedule from 20 to 68 degrees, driven by Mach.
- Sweep effects on effective aspect ratio, maximum lift coefficient, lift slope, zero-lift coefficient, and control authority.
- Live overspeed consequences: over-q or over-Mach creates additional drag, health damage, and buffet/stall telemetry.
- Replay telemetry for Mach, dynamic pressure, sweep angle, afterburner state, and engine spool.
- Visual wing sweep in the Three.js aircraft mesh for sweep-tagged wings.
- The visual model stays in the same aircraft-builder vocabulary as the rest of the catalog: swept `wing`, afterburning `engine`, framed `canopy`, canted fin `wing`, `weapon` stores, and ordinary fuselage/intake parts. The renderer reads those generic part semantics rather than switching to a Tomcat-only asset path.
- AIM-9M-style heat-seeking missiles on the Super Tomcat weapon station, with finite seeker lock, target heat scoring, aspect/range effects, bounded lateral acceleration, and proportional-navigation-style steering.
- AIM-54C-style active-radar BVR missiles on a separate Super Tomcat station, gated by mounted nose-radar track before launch and active seeker guidance after launch. Motor-program pilots must explicitly arm `weapons_free` with `condition: "radar_lock"` before the sear can release FOX-3.

## Super Tomcat Calibration

The catalog aircraft is `variable-sweep-tomcat`, displayed as `Super Tomcat`. It is anchored to F-14D/F110 public-spec numbers:

- Top speed target: 1,544 mph / Mach 2.34 at altitude.
- Climb target: greater than 45,000 ft/min.
- Service ceiling target: 50,000+ ft, approximately 15,200 m.
- Engines: two GE F110-GE-400-class afterburning turbofans.
- Wing sweep: 20 to 68 degrees.

Current generated audit:

- Top speed: 1,532 mph at 14,000 m.
- Best climb: 47,966 ft/min.
- Service ceiling: greater than 18,000 m in the current audit grid.
- Afterburning thrust-to-weight: 0.81 at the modeled full-fuel/stores mass.

## Audit Harnesses

`npm run audit:envelopes -- --json reports/flight-envelopes.json --md reports/flight-envelopes.md`

Builds the deterministic fleet envelope report. It samples altitude, speed, thrust, drag, excess power, climb, turn, Mach, sweep, and dynamic pressure.

`npm run audit:missiles -- --out reports/missile-envelope.json`

Builds the deterministic missile envelope report. It exercises AIM-9M-style launches against rear, beam, head-on, idle/cold, long-range, and jinking moving target cases. The public calibration anchor is NAVAIR's AIM-9M Sidewinder page: infrared homing, Mach 2.5, and 10-18 mile range.

`npm run audit:missiles -- --profile aim-54c --out reports/active-radar-missile-envelope.json`

Builds the deterministic active-radar BVR missile envelope report. It uses the Super Tomcat's mounted nose radar and disables the heat-seeker station so the run exercises the AIM-54C-style profile and FOX-3 kill chain.

## BVR Scenario Path

`bvr-intercept` is server-only. The Studio/App path routes it through `/api/scenario/run`, forces a live LLM pilot, supplies the mounted radar sensor as the blue agent's sensor, and keeps the match-level default sensor empty so perfect information does not leak into BVR observations. The old client/runtime BVR helper now fails loudly instead of creating a scripted pursuit intercept.

`npm run demo:heat-missile -- --out clips/heat-seeking-missile-demo-replay.json`

Builds the replay used for the heat-seeking missile video. Render it with:

`FILM_SENSOR_ID=nose-cam FILM_FPS=30 FILM_TURNS=8 FILM_LABEL='Super Tomcat' npm run film -- --scripted --cinema --replay-in clips/heat-seeking-missile-demo-replay.json --out clips/heat-seeking-missile-demo.mp4`

`npm run audit:props -- --out reports/prop-performance-audit.md`

Keeps the piston aircraft honest against historical-family prop benchmarks. The Super Tomcat is intentionally excluded from this prop-only audit.

## Regression Coverage

- `tests/performanceEnvelope.test.ts` verifies the Super Tomcat is an afterburning variable-sweep jet, reaches jet-class envelope numbers, and outclasses the prop fleet.
- `tests/sim.test.ts` verifies live Super Tomcat sweep telemetry, delayed afterburner spool, overspeed damage, AIM-9M launch telemetry, active-radar BVR missile telemetry, and guided missile hits.
- `tests/motorProgram.test.ts` verifies explicit `radar_lock` authorization for active-radar release and rejects gun-cone guards as FOX-3 consent.
- Full verification before merge:
  - `npm run audit:envelopes -- --json reports/flight-envelopes.json --md reports/flight-envelopes.md`
  - `npm run audit:missiles -- --out reports/missile-envelope.json`
  - `npm run audit:missiles -- --profile aim-54c --out reports/active-radar-missile-envelope.json`
  - `npm run audit:props -- --out reports/prop-performance-audit.md`
  - `npm test`
  - `npm test -- --run tests/performanceEnvelope.test.ts`
  - `git diff --check`
  - `npm run build`

## Known First-Order Approximations

The model now captures qualitative Tomcat behavior, but it is still deliberately compact. It does not model detailed inlet maps, trim drag, glove-vane history, stores-specific drag indexes, compressor-stall probability, hydraulic limits, structural damage modes beyond overspeed health damage, flare/countermeasure logic, seeker noise, or detailed radar/weapon systems.
