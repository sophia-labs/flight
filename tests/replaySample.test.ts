import { describe, expect, it } from "vitest";
import type { ReplayFrame } from "../src/protocol/schema";
import { sampleReplayFrame } from "../src/viewer/replaySample";

function frame(index: number): ReplayFrame {
  return {
    index,
    time: index * 0.16,
    turn: 1,
    events: [],
    aircraft: [
      {
        id: "blue-1",
        callsign: "Blue",
        team: "blue",
        color: "#4da3ff",
        position: { x: index * 10, y: 100 + index * 2, z: -index * 5 },
        velocity: { x: 1 + index, y: 2 + index, z: 3 + index },
        orientation: { x: 0, y: 0, z: 0, w: 1 },
        controls: {
          pitch: index === 0 ? -1 : 1,
          roll: index === 0 ? 0 : 0.8,
          yaw: index === 0 ? -0.4 : 0.4,
          throttle: index === 0 ? 0.2 : 1,
          trigger: index > 0,
        },
        airspeed: 100 + index * 20,
        altitude: 1000 + index * 40,
        aoaDeg: index,
        gLoad: 1 + index,
        health: 100,
        weaponCooldown: 0,
        stalled: false,
        surfaceControls: [
          {
            id: "aileron",
            axis: "roll",
            input: index === 0 ? 0 : 0.8,
            deflectionDeg: index === 0 ? 0 : 12,
            effectiveAoADeg: index === 0 ? 1 : 5,
            localAoADeg: index === 0 ? 2 : 6,
            totalAoADeg: index === 0 ? 3 : 7,
            stallSeverity: index === 0 ? 0 : 0.4,
            loadN: index === 0 ? 100 : 500,
          },
        ],
      },
    ],
  };
}

describe("sampleReplayFrame", () => {
  it("interpolates aircraft controls and surface telemetry between replay ticks", () => {
    const sampled = sampleReplayFrame([frame(0), frame(1)], 0.5);
    const ship = sampled?.aircraft[0];
    const surface = ship?.surfaceControls?.[0];

    expect(sampled?.time).toBeCloseTo(0.08);
    expect(ship?.position.x).toBeCloseTo(5);
    expect(ship?.controls.pitch).toBeCloseTo(0);
    expect(ship?.controls.roll).toBeCloseTo(0.4);
    expect(ship?.controls.throttle).toBeCloseTo(0.6);
    expect(surface?.deflectionDeg).toBeCloseTo(6);
    expect(surface?.loadN).toBeCloseTo(300);
  });

  it("clamps sample positions to the replay bounds", () => {
    const frames = [frame(0), frame(1)];
    expect(sampleReplayFrame(frames, -5)?.index).toBe(0);
    expect(sampleReplayFrame(frames, 5)?.time).toBeCloseTo(0.16);
  });
});
