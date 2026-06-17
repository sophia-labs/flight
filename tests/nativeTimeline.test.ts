import { describe, expect, it } from "vitest";
import type { AircraftSnapshot, MatchReplay, ReplayFrame, Vec3 } from "../src/protocol/schema";
import { buildNativeRenderTimeline } from "../src/render/nativeTimeline";
import { defaultAirframe } from "../src/sim/airframe";

const neutralControls = { pitch: 0, roll: 0, yaw: 0, throttle: 0.7, trigger: false };

function ship(index: number, overrides: Partial<AircraftSnapshot> = {}): AircraftSnapshot {
  return {
    id: "blue-1",
    callsign: "Blue",
    team: "blue",
    color: "#4da3ff",
    position: { x: index * 50, y: 1000 + index * 5, z: -index * 40 },
    velocity: { x: 140, y: 0, z: -120 },
    orientation: { x: 0, y: 0, z: 0, w: 1 },
    controls: { ...neutralControls, roll: index * 0.4, pitch: index * 0.2 },
    airspeed: 180,
    altitude: 1000,
    aoaDeg: 2,
    gLoad: 1.2,
    health: 100,
    weaponCooldown: 0,
    stalled: false,
    ...overrides,
  };
}

function frame(index: number, aircraft: AircraftSnapshot[] = [ship(index)]): ReplayFrame {
  return {
    index,
    time: index * 0.5,
    turn: 0,
    aircraft,
    events:
      index === 0
        ? [
            {
              type: "shot",
              message: "test shot",
              actorId: "blue-1",
              origin: { x: 0, y: 1000, z: 0 },
              impact: { x: 200, y: 1010, z: -600 },
            },
          ]
        : [],
  };
}

function replay(frames: ReplayFrame[] = [frame(0), frame(1)]): MatchReplay {
  return {
    id: "native-render-test",
    turnDuration: 1,
    frameDt: 0.5,
    frames,
    airframes: { "blue-1": defaultAirframe() },
  };
}

function expectFiniteVec(point: Vec3): void {
  expect(Number.isFinite(point.x)).toBe(true);
  expect(Number.isFinite(point.y)).toBe(true);
  expect(Number.isFinite(point.z)).toBe(true);
}

describe("buildNativeRenderTimeline", () => {
  it("exports sampled aircraft, controls, surfaces, events, and cinematic cameras", () => {
    const timeline = buildNativeRenderTimeline(replay(), {
      fps: 4,
      seconds: 1,
      width: 640,
      height: 360,
      cameraMode: "cinematic",
    });

    expect(timeline.schemaVersion).toBe(1);
    expect(timeline.generator).toBe("flight-native-render");
    expect(timeline.frames).toHaveLength(4);
    expect(timeline.frames[0].camera.shot).toBe("lead-pass");
    expect(timeline.frames[0].events).toHaveLength(1);

    const firstShip = timeline.frames[1].aircraft[0];
    expect(firstShip.surfaceControls.map((surface) => surface.id)).toEqual([
      "main-wing-left",
      "main-wing-right",
      "tailplane",
      "fin",
    ]);
    expect(firstShip.controls.roll).toBeGreaterThan(0);
    expect(firstShip.surfaceControls.some((surface) => Math.abs(surface.deflectionDeg) > 0)).toBe(true);

    for (const frame of timeline.frames) {
      expectFiniteVec(frame.camera.eye);
      expectFiniteVec(frame.camera.target);
      expectFiniteVec(frame.camera.up);
      expect(frame.camera.verticalFovDeg).toBeGreaterThan(1);
      expect(frame.camera.verticalFovDeg).toBeLessThan(120);
    }
  });

  it("exports a mounted cockpit camera from the recorded airframe", () => {
    const timeline = buildNativeRenderTimeline(replay(), {
      fps: 2,
      seconds: 2,
      width: 1280,
      height: 720,
      cameraMode: "cockpit",
      loop: false,
    });

    const first = timeline.frames[0];
    const last = timeline.frames.at(-1);
    const aspect = 1280 / 720;
    const hFov = Math.PI / 2.8;
    const expectedVerticalFovDeg = 2 * Math.atan(Math.tan(hFov / 2) / aspect) * (180 / Math.PI);

    expect(first.camera.shot).toBe("cockpit-cam");
    expect(first.camera.verticalFovDeg).toBeCloseTo(expectedVerticalFovDeg, 4);
    expect(last?.replayPosition).toBe(1);
  });

  it("preserves static targets for engine-native renderers", () => {
    const balloon = ship(0, {
      id: "balloon",
      callsign: "Balloon",
      team: "red",
      color: "#ff5da3",
      position: { x: 300, y: 950, z: -500 },
      velocity: { x: 0, y: 0, z: 0 },
      static: true,
    });
    const timeline = buildNativeRenderTimeline(replay([frame(0, [ship(0), balloon]), frame(1, [ship(1), balloon])]), {
      fps: 2,
      seconds: 0.5,
      cameraMode: "orbit",
    });

    expect(timeline.frames[0].aircraft.find((entry) => entry.id === "balloon")?.static).toBe(true);
  });

  it("exports a pilot-hero camera and avatar mount when requested", () => {
    const hardPull = ship(0, {
      controls: { ...neutralControls, roll: 0.8, pitch: 0.7, yaw: 0.25 },
      gLoad: 4.2,
      aoaDeg: 11,
    });
    const timeline = buildNativeRenderTimeline(replay([frame(0, [hardPull])]), {
      fps: 2,
      seconds: 0.5,
      cameraMode: "pilot-hero",
      avatarPath: "public/models/VRM1_Constraint_Twist_Sample.vrm",
    });

    expect(timeline.avatar?.pilotId).toBe("blue-1");
    expect(timeline.avatar?.source).toBe("public/models/VRM1_Constraint_Twist_Sample.vrm");
    expect(timeline.avatar?.scale).toBeGreaterThan(0.1);
    expect(timeline.frames[0].camera.mode).toBe("pilot-hero");
    expect(timeline.frames[0].camera.shot).toBe("pilot-hero-canopy");
    expect(timeline.frames[0].camera.eye.z).toBeLessThan(timeline.frames[0].camera.target.z);
    // pilotPose carries the same per-bone rotations, expressions, and lookAt the React viewer uses.
    const pose = timeline.frames[0].pilotPose;
    expect(pose).toBeDefined();
    // Hard pull (4.2 G, roll 0.8) should drive significant chest/head rotations.
    expect(Math.abs(pose!.bones.chest?.x ?? 0)).toBeGreaterThan(0.01);
    expect(Math.abs(pose!.bones.head?.x ?? 0)).toBeGreaterThan(0.01);
    // gForcePose should produce strain-driven expressions.
    expect(pose!.expressions.angry).toBeGreaterThan(0);
    expect(pose!.expressions.ih).toBeGreaterThan(0);
    expect(Math.abs(pose!.lookAt.x)).toBeGreaterThan(0);
    expect(Math.abs(pose!.lookAt.y)).toBeGreaterThan(0);
  });

  it("exports split-screen cameras, pilot FEEL subtitles, and projectiles", () => {
    const balloon = ship(0, {
      id: "balloon",
      callsign: "Balloon",
      team: "red",
      color: "#ff5da3",
      position: { x: 600, y: 980, z: -900 },
      velocity: { x: 0, y: 0, z: 0 },
      static: true,
    });
    const frames = [
      frame(0, [ship(0), balloon]),
      {
        ...frame(1, [ship(1), balloon]),
        projectiles: [
          {
            id: "bullet-1",
            position: { x: 120, y: 1005, z: -220 },
            velocity: { x: 700, y: 0, z: -700 },
            team: "blue" as const,
          },
        ],
      },
    ];
    const withBody = {
      ...replay(frames),
      bodyTicks: [
        {
          agentId: "blue-1",
          time: 0,
          parsed: { feel: "target centered and the air feels smooth" },
        },
      ] as any,
    } as MatchReplay;
    const timeline = buildNativeRenderTimeline(withBody, {
      fps: 2,
      seconds: 1,
      cameraMode: "split-balloon",
      avatarPath: "public/models/VRM1_Constraint_Twist_Sample.vrm",
      loop: false,
    });

    expect(timeline.layout).toBe("split-screen");
    expect(timeline.avatar?.pilotId).toBe("blue-1");
    expect(timeline.subtitles?.[0].label).toBe("FEEL");
    expect(timeline.subtitles?.[0].text).toContain("target centered");
    expect(timeline.frames[0].camera.mode).toBe("pilot-hero");
    expect(timeline.frames[0].externalCamera?.shot).toBe("split-balloon-orbit");
    expect(timeline.frames[1].projectiles?.[0].id).toBe("bullet-1");
  });

  it("exports a split-screen dogfight camera for dynamic 1v1 replays", () => {
    const rival = ship(0, {
      id: "red-1",
      callsign: "Red",
      team: "red",
      color: "#ff5d61",
      position: { x: 520, y: 1040, z: -760 },
      velocity: { x: -120, y: 0, z: 95 },
    });
    const frames = [
      frame(0, [ship(0), rival]),
      {
        ...frame(1, [ship(1), { ...rival, position: { x: 470, y: 1036, z: -705 } }]),
        projectiles: [
          {
            id: "red-round-1",
            position: { x: 310, y: 1020, z: -460 },
            velocity: { x: -620, y: -20, z: 510 },
            team: "red" as const,
          },
        ],
      },
    ];
    const withBody = {
      ...replay(frames),
      bodyTicks: [
        {
          agentId: "blue-1",
          time: 0,
          parsed: { feel: "bandit off the nose, holding pressure" },
        },
      ] as any,
    } as MatchReplay;
    const timeline = buildNativeRenderTimeline(withBody, {
      fps: 2,
      seconds: 1,
      cameraMode: "split-dogfight",
      avatarPath: "public/models/VRM1_Constraint_Twist_Sample.vrm",
      loop: false,
    });

    expect(timeline.layout).toBe("split-screen");
    expect(timeline.cameraMode).toBe("split-dogfight");
    expect(timeline.frames[0].camera.mode).toBe("pilot-hero");
    expect(timeline.frames[0].externalCamera?.shot).toBe("split-dogfight-orbit");
    expect(timeline.frames[0].externalCamera?.target.x).toBeGreaterThan(0);
    expect(timeline.frames[0].externalCamera?.target.z).toBeLessThan(0);
    expect(timeline.frames[1].projectiles?.[0].team).toBe("red");
    expect(timeline.subtitles?.[0].text).toContain("bandit");
  });
});
