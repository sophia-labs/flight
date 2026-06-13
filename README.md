# Flight Duel

A first vertical slice for a turn-based, physics-driven flight combat sim that LLM agents can play through joystick-like controls.

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
- `src/protocol`: Zod schemas and public state/action contracts.
- `src/viewer`: React and Three.js replay viewer, telemetry, timeline, and virtual control displays.

The viewer renders replay frames. It does not own the combat truth.
