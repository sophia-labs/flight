import { describe, expect, it } from "vitest";
import { actionSpecs, motorProgramSpecWithDefaultWeaponsFree } from "../src/agent/actionSpec";
import { controlForMotorProgram } from "../src/agent/action";
import { fixedWingBodyManifest } from "../src/body/manifest";
import type { BodyModel } from "../src/body/model";
import { minimalEvaluator } from "../src/eval/outcome";
import { perfectSensor } from "../src/agent/observation";
import { pursuitFallback } from "../src/agent/controllers/scripted";
import type { Controller } from "../src/agent/controller";
import type { MatchConfig } from "../src/runtime/config";
import { runMatch } from "../src/runtime/match";
import { createBalloonScenarioAircraft, createBvrInterceptAircraft, FRAME_DT, staticController } from "../src/runtime/scenario";
import { aircraftArchetypes } from "../src/sim/aircraftCatalog";
import { quatLookRotation, vec3 } from "../src/sim/math";
import type { MotorProgramAction, Observation } from "../src/protocol/schema";

function neutralProgram(overrides: Partial<MotorProgramAction> = {}): MotorProgramAction {
  return {
    kind: "motor-program",
    durationMs: 2_500,
    sampleDtMs: 50,
    samples: [
      { tMs: 0, pitch: 0, roll: 0, yaw: 0, throttle: 0.9, trigger: false },
      { tMs: 2_500, pitch: 0, roll: 0, yaw: 0, throttle: 0.9, trigger: false },
    ],
    heldActions: [
      {
        kind: "weapons_free",
        condition: "target_in_forward_gun_cone",
        coneDeg: 18,
        rangeM: 6_000,
      },
    ],
    ...overrides,
  };
}

function fixedBodyOutput(output: string): BodyModel {
  return async () => output;
}

function configFor(
  action: MotorProgramAction,
  bodyModel: BodyModel,
  onObservation?: (observation: Observation) => void,
): MatchConfig {
  const aircraft = createBalloonScenarioAircraft();
  aircraft[0].position = vec3(0, 1_000, 1_000);
  aircraft[0].velocity = vec3(0, 0, -150);
  aircraft[0].orientation = quatLookRotation(vec3(0, 0, -1));
  aircraft[1].position = vec3(0, 1_000, 0);
  const controller: Controller = async (observation) => {
    onObservation?.(observation);
    return { action, rationale: "test motor program" };
  };
  return {
    id: "motor-program-test",
    turnDuration: FRAME_DT,
    frameDt: FRAME_DT,
    maxTurns: 1,
    decisionTimeoutMs: 1_000,
    initialAircraft: aircraft,
    sensor: perfectSensor,
    evaluator: minimalEvaluator,
    fallback: pursuitFallback,
    agents: {
      "blue-1": {
        meta: {
          id: "blue-1",
          kind: "scripted",
          label: "motor-program-test",
          config: { twitchBodyModel: "scripted" },
        },
        controller,
        reflexBody: { manifest: fixedWingBodyManifest, model: bodyModel },
      },
      balloon: {
        meta: { id: "balloon", kind: "scripted", label: "balloon" },
        controller: staticController,
      },
    },
  };
}

describe("motor-program action", () => {
  it("interpolates smooth control samples by elapsed time", () => {
    const control = controlForMotorProgram(
      {
        kind: "motor-program",
        durationMs: 2_500,
        sampleDtMs: 50,
        samples: [
          { tMs: 0, pitch: -0.2, roll: -0.4, yaw: 0, throttle: 0.6, trigger: false },
          { tMs: 2_500, pitch: 0.2, roll: 0.4, yaw: 0.2, throttle: 1, trigger: false },
        ],
        heldActions: [],
      },
      1_250,
    );

    expect(control.pitch).toBeCloseTo(0);
    expect(control.roll).toBeCloseTo(0);
    expect(control.yaw).toBeCloseTo(0.1);
    expect(control.throttle).toBeCloseTo(0.8);
    expect(control.trigger).toBe(false);
  });

  it("coerces planner tool output into a sorted tape with a default weapons-free guard", () => {
    const action = actionSpecs["motor-program"].toAction({
      durationMs: 2_500,
      sampleDtMs: 50,
      samples: [
        { tMs: 2_500, pitch: 0.1, roll: 0.2, yaw: 0, throttle: 1, trigger: false },
        { tMs: 250, pitch: -0.1, roll: -0.2, yaw: 0, throttle: 0.8, trigger: false },
      ],
      heldActions: [],
    });

    expect(action.kind).toBe("motor-program");
    if (action.kind !== "motor-program") throw new Error("expected motor-program");
    expect(action.samples[0].tMs).toBe(0);
    expect(action.samples.at(-1)?.tMs).toBe(2_500);
    expect(action.samples).toHaveLength(51);
    expect(action.samples[1].tMs).toBe(50);
    expect(action.heldActions.some((held) => held.kind === "weapons_free")).toBe(true);
  });

  it("can default omitted BVR weapons-free guards to radar lock instead of guns", () => {
    const action = motorProgramSpecWithDefaultWeaponsFree("radar-lock").toAction({
      durationMs: 1_000,
      sampleDtMs: 50,
      samples: [{ tMs: 0, pitch: 0.2, roll: 0.6, yaw: 0, throttle: 0.9, trigger: false }],
      heldActions: [],
    });

    expect(action.kind).toBe("motor-program");
    if (action.kind !== "motor-program") throw new Error("expected motor-program");
    expect(action.heldActions).toContainEqual(
      expect.objectContaining({
        kind: "weapons_free",
        condition: "radar_lock",
        coneDeg: 30,
        rangeM: 80_000,
      }),
    );
    expect(action.heldActions.some((held) => held.condition === "target_in_forward_gun_cone")).toBe(false);
  });

  it("wakes the twitch Body only when a held weapons-free cone is active", async () => {
    const bodyModel = fixedBodyOutput(
      [
        "MUSCLE ROLL=0 PITCH=0 YAW=0 PUSH=4",
        "TONE hold 1",
        "EXPECT ROLL=stable PITCH=stable SPEED=stable MARGIN=safe",
        "SOLUTION cold",
        "FEEL checking the pipper",
        "MEM twitch",
      ].join("\n"),
    );

    const active = await runMatch(configFor(neutralProgram(), bodyModel));
    expect(active.bodyTicks).toHaveLength(1);
    expect(active.bodyTicks?.[0]?.pilotIntent.style).toBe("twitch_guns");
    expect(active.agentPhases?.map((phase) => phase.mode)).toEqual(["planner", "twitch"]);
    expect(active.agentPhases?.find((phase) => phase.mode === "twitch")).toMatchObject({
      reason: "target_in_forward_gun_cone",
      timeScale: 0.35,
    });

    const inactive = await runMatch(
      configFor(
        neutralProgram({
          heldActions: [
            {
              kind: "weapons_free",
              condition: "target_in_forward_gun_cone",
              coneDeg: 1,
              rangeM: 10,
            },
          ],
        }),
        bodyModel,
      ),
    );
    expect(inactive.bodyTicks ?? []).toHaveLength(0);
  });

  it("feeds cockpit ASCII into the slow motor-program planner observation", async () => {
    let seenText = "";
    await runMatch(
      configFor(neutralProgram(), fixedBodyOutput("MUSCLE ROLL=0 PITCH=0 YAW=0 PUSH=4"), (observation) => {
        seenText = observation.text ?? "";
      }),
    );

    expect(seenText).toContain("camera-ascii@2");
    expect(seenText).toContain("65x31");
    expect(seenText).toContain("gun boresight");
    expect(seenText).toContain("+");
  });

  it("releases an active-radar missile from a motor-program weapons-free guard without twitch guns", async () => {
    const tomcat = aircraftArchetypes.find((candidate) => candidate.id === "variable-sweep-tomcat")!;
    const aircraft = createBvrInterceptAircraft(tomcat.airframe);
    const blue = aircraft[0];
    const red = aircraft[1];
    blue.position = vec3(0, 10_000, 0);
    blue.velocity = vec3(0, 0, -320);
    blue.orientation = quatLookRotation(vec3(0, 0, -1));
    blue.weaponCooldown = 0;
    red.position = vec3(0, 10_000, -25_000);
    red.velocity = vec3(0, 0, -120);
    red.orientation = quatLookRotation(vec3(0, 0, -1));

    const controller: Controller = async () => ({
      action: neutralProgram({
        heldActions: [
          {
            kind: "weapons_free",
            condition: "radar_lock",
            coneDeg: 30,
            rangeM: 80_000,
          },
        ],
      }),
      rationale: "arm radar missile sear",
    });

    const replay = await runMatch({
      id: "motor-program-bvr-sear-test",
      turnDuration: 0.1,
      frameDt: 0.1,
      maxTurns: 1,
      decisionTimeoutMs: 1_000,
      initialAircraft: aircraft,
      sensor: perfectSensor,
      evaluator: minimalEvaluator,
      fallback: pursuitFallback,
      agents: {
        "blue-1": {
          meta: {
            id: "blue-1",
            kind: "scripted",
            label: "motor-program-radar-sear-test",
            config: { twitchBodyModel: "scripted" },
          },
          controller,
          reflexBody: {
            manifest: fixedWingBodyManifest,
            model: fixedBodyOutput(
              [
                "MUSCLE ROLL=0 PITCH=0 YAW=0 PUSH=4",
                "TONE hold 1",
                "EXPECT ROLL=stable PITCH=stable SPEED=stable MARGIN=safe",
                "SOLUTION cold",
                "FEEL not used",
                "MEM radar",
              ].join("\n"),
            ),
          },
        },
        "prop-1": {
          meta: { id: "prop-1", kind: "scripted", label: "prop" },
          controller: staticController,
        },
      },
    });

    const events = replay.frames.flatMap((frame) => frame.events);
    expect(events.some((event) => event.type === "shot" && event.message.includes("AIM-54C"))).toBe(true);
    expect(replay.frames.some((frame) =>
      (frame.projectiles ?? []).some((projectile) =>
        projectile.kind === "missile" &&
        projectile.guidance === "active-radar" &&
        projectile.missileModel === "aim-54c" &&
        projectile.lockState === "acquired",
      ),
    )).toBe(true);
    expect(replay.bodyTicks ?? []).toHaveLength(0);
    expect(replay.agentPhases?.map((phase) => phase.mode)).toEqual(["planner"]);
  });

  it("does not treat a gun-cone weapons-free guard as active-radar missile consent", async () => {
    const tomcat = aircraftArchetypes.find((candidate) => candidate.id === "variable-sweep-tomcat")!;
    const aircraft = createBvrInterceptAircraft(tomcat.airframe);
    const blue = aircraft[0];
    const red = aircraft[1];
    blue.position = vec3(0, 10_000, 0);
    blue.velocity = vec3(0, 0, -320);
    blue.orientation = quatLookRotation(vec3(0, 0, -1));
    blue.weaponCooldown = 0;
    red.position = vec3(0, 10_000, -25_000);
    red.velocity = vec3(0, 0, -120);
    red.orientation = quatLookRotation(vec3(0, 0, -1));

    const controller: Controller = async () => ({
      action: neutralProgram({
        heldActions: [
          {
            kind: "weapons_free",
            condition: "target_in_forward_gun_cone",
            coneDeg: 30,
            rangeM: 80_000,
          },
        ],
      }),
      rationale: "guns only",
    });

    const replay = await runMatch({
      id: "motor-program-bvr-gun-guard-test",
      turnDuration: 0.1,
      frameDt: 0.1,
      maxTurns: 1,
      decisionTimeoutMs: 1_000,
      initialAircraft: aircraft,
      sensor: perfectSensor,
      evaluator: minimalEvaluator,
      fallback: pursuitFallback,
      agents: {
        "blue-1": {
          meta: { id: "blue-1", kind: "scripted", label: "motor-program-gun-guard-test" },
          controller,
        },
        "prop-1": {
          meta: { id: "prop-1", kind: "scripted", label: "prop" },
          controller: staticController,
        },
      },
    });

    const events = replay.frames.flatMap((frame) => frame.events);
    expect(events.some((event) => event.type === "shot" && event.message.includes("AIM-54C"))).toBe(false);
    expect(replay.frames.some((frame) =>
      (frame.projectiles ?? []).some((projectile) => projectile.missileModel === "aim-54c"),
    )).toBe(false);
  });
});
