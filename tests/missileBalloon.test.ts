import { describe, expect, it } from "vitest";
import { runMatch } from "../src/runtime/match";
import { buildMissileBalloonMatchConfig, buildMissileSearMatchConfig } from "../src/runtime/scenario";

// The basic combat harness: a heat-seeker at a hot balloon. Proves the whole IR pipeline end to end
// through the EXISTING trigger path — a thermal balloon emits enough heat to lock at 5 km, the loaded
// AIM-9 launches on the trigger, PN-guides to the target, and the warhead pops the fragile balloon.
describe("missile balloon combat harness", () => {
  it("launches an AIM-9 that locks the hot balloon at 5 km and kills it", async () => {
    const replay = await runMatch(buildMissileBalloonMatchConfig(8));

    // A missile round was actually spawned (not a bullet).
    const launched = replay.frames.some((f) => (f.projectiles ?? []).some((p) => p.kind === "missile"));
    expect(launched, "an AIM-9 missile was launched").toBe(true);

    // The seeker acquired the hot balloon (the heat override cleared min-lock at range).
    const acquired = replay.frames.some((f) =>
      (f.projectiles ?? []).some((p) => p.kind === "missile" && p.lockState === "acquired"),
    );
    expect(acquired, "the seeker acquired an IR lock on the balloon").toBe(true);

    // The balloon is dead at the end of the run.
    const balloon = replay.frames.at(-1)?.aircraft.find((a) => a.id === "balloon");
    expect(balloon, "balloon present in final frame").toBeTruthy();
    expect(balloon!.health, "balloon killed by the missile").toBeLessThanOrEqual(0);
  });

  it("leaves a cold (no-heat) balloon unlockable — the override is what makes it an IR target", async () => {
    // Sanity that we didn't just make ALL balloons hot: targetHeatSignature only emits for an override.
    const { createBalloonTarget } = await import("../src/runtime/scenario");
    const { targetHeatSignature } = await import("../src/sim/flight");
    const cold = createBalloonTarget({ x: 0, y: 1300, z: 0 });
    const hot = createBalloonTarget({ x: 0, y: 1300, z: 0 }, 10);
    const observer = { x: 0, y: 1300, z: 5000 };
    expect(targetHeatSignature(cold, observer)).toBeLessThan(0.2 * 25); // below 5 km min-lock-equivalent
    expect(targetHeatSignature(hot, observer)).toBe(10);
  });

  it("agent-facing: a no-twitch motor-program planner arming weapons_free fires the FOX-2 on IR lock", async () => {
    const replay = await runMatch(buildMissileSearMatchConfig(6));

    const launched = replay.frames.some((f) => (f.projectiles ?? []).some((p) => p.kind === "missile"));
    expect(launched, "the IR sear released the AIM-9").toBe(true);

    // The planner's OBSERVATION surfaced the loadout + lock (so a live planner could reason about the shot).
    const decisions = replay.decisions ?? [];
    const sawLoadout = decisions.some((d) => d.agentId === "blue-1" && d.observation.self.missileLoaded === true);
    const sawLock = decisions.some(
      (d) => d.agentId === "blue-1" && d.observation.contacts.some((c) => c.missileLock === true),
    );
    expect(sawLoadout, "observation surfaced missileLoaded").toBe(true);
    expect(sawLock, "observation surfaced missileLock").toBe(true);

    const balloon = replay.frames.at(-1)?.aircraft.find((a) => a.id === "balloon");
    expect(balloon!.health, "hot balloon killed by the FOX-2").toBeLessThanOrEqual(0);
  });
});
