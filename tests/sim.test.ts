import { describe, expect, it } from "vitest";
import { ControlInputSchema } from "../src/protocol/schema";
import { basisFromQuat, dot, normalize, quatLookRotation, vec3 } from "../src/sim/math";
import { generateDemoMatch } from "../src/sim/scenario";

describe("flight sim replay generation", () => {
  it("produces deterministic replay data", () => {
    const first = generateDemoMatch(8);
    const second = generateDemoMatch(8);

    expect(first).toEqual(second);
    expect(first.frames.length).toBeGreaterThan(20);
  });

  it("keeps every generated control input inside the public protocol", () => {
    const replay = generateDemoMatch(10);

    for (const frame of replay.frames) {
      for (const aircraft of frame.aircraft) {
        expect(() => ControlInputSchema.parse(aircraft.controls)).not.toThrow();
        expect(Number.isFinite(aircraft.position.x)).toBe(true);
        expect(Number.isFinite(aircraft.velocity.y)).toBe(true);
        expect(aircraft.health).toBeGreaterThanOrEqual(0);
        expect(aircraft.health).toBeLessThanOrEqual(100);
      }
    }
  });

  it("creates an orientation that points the aircraft forward vector at the desired heading", () => {
    const desired = normalize(vec3(10, 1, -8));
    const orientation = quatLookRotation(desired);
    const basis = basisFromQuat(orientation);

    expect(dot(basis.forward, desired)).toBeGreaterThan(0.999);
  });
});
