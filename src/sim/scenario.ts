import { MatchReplaySchema, type ControlInput, type MatchReplay, type ReplayFrame } from "../protocol/schema";
import { chooseDefensiveControls, choosePursuitControls } from "./agents";
import { DEFAULT_MODEL, stepSimulation } from "./flight";
import { length, quatLookRotation, vec3 } from "./math";
import type { AircraftState, FlightMetrics } from "./types";
import { toSnapshot } from "./types";

const TURN_DURATION = 2.4;
const FRAME_DT = 0.16;
const STEPS_PER_TURN = Math.round(TURN_DURATION / FRAME_DT);
const INITIAL_METRICS: FlightMetrics = {
  airspeed: 0,
  altitude: 0,
  aoaDeg: 0,
  gLoad: 1,
  stalled: false,
};

export function generateDemoMatch(turnCount = 28): MatchReplay {
  const aircraft = createInitialAircraft();
  const frames: ReplayFrame[] = [];
  let time = 0;
  let frameIndex = 0;

  frames.push(snapshot(frameIndex++, time, 0, aircraft, []));

  for (let turn = 1; turn <= turnCount; turn += 1) {
    const controlsById = chooseTurnControls(aircraft, turn);

    for (let step = 0; step < STEPS_PER_TURN; step += 1) {
      const result = stepSimulation(aircraft, controlsById, FRAME_DT);
      time += FRAME_DT;
      frames.push(snapshot(frameIndex++, time, turn, result.aircraft, result.events));
    }

    if (aircraft.some((ship) => ship.health <= 0)) {
      break;
    }
  }

  return MatchReplaySchema.parse({
    id: "demo-merge-001",
    turnDuration: TURN_DURATION,
    frameDt: FRAME_DT,
    frames,
  });
}

function chooseTurnControls(aircraft: AircraftState[], turn: number): Record<string, ControlInput> {
  const blue = aircraft.find((ship) => ship.id === "blue-1");
  const red = aircraft.find((ship) => ship.id === "red-1");

  if (!blue || !red) {
    return {};
  }

  return {
    [blue.id]: choosePursuitControls(blue, red, 0.82),
    [red.id]: chooseDefensiveControls(red, blue, turn),
  };
}

function createInitialAircraft(): AircraftState[] {
  const blueVelocity = vec3(112, 2, -118);
  const redVelocity = vec3(-112, 0, 112);

  return [
    {
      id: "blue-1",
      callsign: "Blue Kite",
      team: "blue",
      color: "#4da3ff",
      position: vec3(-960, 1_080, 860),
      velocity: blueVelocity,
      orientation: quatLookRotation(blueVelocity),
      controls: { pitch: 0, roll: 0, yaw: 0, throttle: 0.86, trigger: false },
      health: 100,
      weaponCooldown: 1.1,
      model: DEFAULT_MODEL,
      metrics: { ...INITIAL_METRICS, airspeed: length(blueVelocity), altitude: 1_080 },
    },
    {
      id: "red-1",
      callsign: "Red Anvil",
      team: "red",
      color: "#ff6b61",
      position: vec3(980, 1_020, -760),
      velocity: redVelocity,
      orientation: quatLookRotation(redVelocity),
      controls: { pitch: 0, roll: 0, yaw: 0, throttle: 0.82, trigger: false },
      health: 100,
      weaponCooldown: 0.4,
      model: DEFAULT_MODEL,
      metrics: { ...INITIAL_METRICS, airspeed: length(redVelocity), altitude: 1_020 },
    },
  ];
}

function snapshot(
  index: number,
  time: number,
  turn: number,
  aircraft: AircraftState[],
  events: ReplayFrame["events"],
): ReplayFrame {
  return {
    index,
    time,
    turn,
    aircraft: aircraft.map(toSnapshot),
    events,
  };
}
