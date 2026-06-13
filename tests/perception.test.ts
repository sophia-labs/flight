import { describe, expect, it } from "vitest";
import { senseAndEncode } from "../src/agent/perception";
import { PerceptSchema } from "../src/protocol/schema";
import { quatLookRotation, vec3 } from "../src/sim/math";
import type { SensorDevice } from "../src/sim/parts";
import type { AircraftState } from "../src/sim/types";

const NOSE_CAM: SensorDevice = {
  id: "nose-cam",
  kind: "sensor",
  modality: "camera",
  pose: { offset: vec3(0, 0, -18), rotation: { x: 0, y: 0, z: 0, w: 1 } },
  for: { halfAngleRad: 0.7, maxRangeM: 8_000 },
  optics: { hFovRad: Math.PI / 3, aspect: 1.6 },
};

// Minimal AircraftState builder for hand-placed geometry.
function ac(o: {
  id: string;
  position: AircraftState["position"];
  orientation: AircraftState["orientation"];
  team?: AircraftState["team"];
  velocity?: AircraftState["velocity"];
  health?: number;
}): AircraftState {
  return {
    id: o.id,
    callsign: o.id,
    team: o.team ?? "blue",
    color: "#ffffff",
    position: o.position,
    velocity: o.velocity ?? vec3(0, 0, -180),
    orientation: o.orientation,
    controls: { pitch: 0, roll: 0, yaw: 0, throttle: 0.8, trigger: false },
    health: o.health ?? 100,
    weaponCooldown: 0,
    model: {
      massKg: 1,
      wingAreaM2: 1,
      maxThrustN: 1,
      maxPitchRate: 1,
      maxRollRate: 1,
      maxYawRate: 1,
      stallAoARad: 0.4,
    },
    metrics: { airspeed: 180, altitude: o.position.y, aoaDeg: 0, gLoad: 1, stalled: false },
  };
}

// Self flying level down -Z (bank 0, pitch 0); three hostiles in different relations.
function standardScene() {
  const self = ac({
    id: "blue-1",
    team: "blue",
    position: vec3(0, 1000, 0),
    orientation: quatLookRotation(vec3(0, 0, -1)),
    velocity: vec3(0, 4, -180),
  });
  const deadAhead = ac({
    id: "red-1",
    team: "red",
    position: vec3(0, 1000, -1018), // 1000 m ahead of the nose-cam eye
    orientation: quatLookRotation(vec3(0, 0, 1)), // nose-on toward us
    health: 80,
  });
  const upperRight = ac({
    id: "red-2",
    team: "red",
    position: vec3(335, 1279, -1136), // up and to the right
    orientation: quatLookRotation(vec3(-1, 0, 0)),
    health: 64,
  });
  const behind = ac({
    id: "red-3",
    team: "red",
    position: vec3(0, 1000, 600), // behind the camera → out of field of regard
    orientation: quatLookRotation(vec3(0, 0, -1)),
  });
  return { self, world: [self, deadAhead, upperRight, behind] };
}

describe("camera sensor + camera-ascii encoder", () => {
  it("renders a stable, deterministic camera viewport", () => {
    const { self, world } = standardScene();
    const first = senseAndEncode(NOSE_CAM, world, self);
    const second = senseAndEncode(NOSE_CAM, world, self);

    // Byte-stability is the real determinism guard: two encodes serialize identically.
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    // The viewport itself is pinned by snapshot (regenerate intentionally with `vitest -u`).
    expect(first.text).toMatchSnapshot();
  });

  it("frames each in-view contact with a legend line", () => {
    const { self, world } = standardScene();
    const text = senseAndEncode(NOSE_CAM, world, self).text ?? "";

    expect(text).toContain(" own  spd 180  alt 1000  bank +0  pitch +0");
    expect(text).toContain(" red-1  12 o'clock level  rng 1000  nose-R  hp 80");
    expect(text).toContain(" red-2  1 o'clock high");
    // Every viewport row is exactly the bordered grid width.
    const rows = text.split("\n").filter((l) => l.startsWith("|"));
    expect(rows).toHaveLength(15);
    for (const row of rows) expect(row).toHaveLength(35); // "|" + 33 + "|"
  });

  it("gates contacts by field of regard (front cone + range)", () => {
    const { self, world } = standardScene();
    const percept = senseAndEncode(NOSE_CAM, world, self);
    const byId = Object.fromEntries((percept.contacts ?? []).map((c) => [c.id, c]));

    expect(byId["red-1"]?.inView).toBe(true);
    expect(byId["red-2"]?.inView).toBe(true);
    expect(byId["red-3"]?.inView).toBe(false); // behind the camera
    // A gated-out contact never reaches the legend.
    expect(percept.text).not.toContain("red-3");
  });

  it("projects bearing signs correctly (right = +x, up = +y)", () => {
    const { self, world } = standardScene();
    const upperRight = (senseAndEncode(NOSE_CAM, world, self).contacts ?? []).find(
      (c) => c.id === "red-2",
    );
    expect(upperRight).toBeDefined();
    expect(upperRight!.ndcX).toBeGreaterThan(0); // to the right
    expect(upperRight!.ndcY).toBeGreaterThan(0); // above
  });

  it("stays finite and -0-free for degenerate geometry, and validates against the schema", () => {
    const self = ac({
      id: "blue-1",
      position: vec3(0, 1000, 0),
      orientation: quatLookRotation(vec3(0, 0, -1)),
    });
    const lvl = quatLookRotation(vec3(0, 0, -1));
    const coincident = ac({ id: "red-1", team: "red", position: vec3(0, 1000, -18), orientation: lvl }); // at the eye
    const directlyBehind = ac({ id: "red-2", team: "red", position: vec3(0, 1000, 5000), orientation: lvl });
    const onBoresight = ac({ id: "red-3", team: "red", position: vec3(0, 1000, -500), orientation: lvl });

    const percept = senseAndEncode(NOSE_CAM, [self, coincident, directlyBehind, onBoresight], self);

    expect(percept.text).not.toContain("NaN");
    // Every emitted number must be finite and not negative-zero (value-level, since JSON.stringify
    // would hide a -0 as "0"). A -0 would survive in-memory and bite a future toStrictEqual.
    const nums: number[] = [];
    for (const c of percept.contacts ?? []) {
      nums.push(c.ndcX, c.ndcY, c.rangeM, c.aspectDeg, c.angularSizeDeg, c.health);
    }
    if (percept.attitude) nums.push(percept.attitude.bankDeg, percept.attitude.pitchDeg);
    for (const n of nums) {
      expect(Number.isFinite(n)).toBe(true);
      expect(Object.is(n, -0)).toBe(false);
    }
    // The finite-guarded schema accepts it (a NaN would throw here).
    expect(() => PerceptSchema.parse(percept)).not.toThrow();
  });
});
