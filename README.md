# Flight Duel

A physics-driven flight combat sim where LLM-scale agents can fly through auditable control layers. Version 0.8.0 adds an embodied fixed-wing Body loop: a Pilot emits desire, the Body emits strict motor grammar, the adapter maps muscles onto the existing airplane, and replay telemetry records the consequence.

## Run

```bash
npm install
npm run dev
```

Open `http://127.0.0.1:5173/`.

## Checks

```bash
npm test
npm run build
npm run e2e
```

`npm test` runs deterministic sim tests. `npm run e2e` runs the browser smoke test against the Vite app.

## Shape

- `src/sim`: deterministic headless simulation, aircraft state, controls, simple aerodynamics, weapon resolution.
- `src/body`: fixed-wing Body manifest, qualitative proprioception, motor grammar parsing, invalid-output policy, and Body runtime.
- `src/protocol`: Zod schemas and public state/action contracts.
- `src/viewer`: React and Three.js replay viewer, telemetry, timeline, and virtual control displays.

The viewer renders replay frames and Body audit traces. It does not own the combat truth.
