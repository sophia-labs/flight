import { z } from "zod";
import { actionSpecs, motorProgramSpecWithDefaultWeaponsFree } from "../agent/actionSpec";
import { bodyPilotController } from "../agent/controllers/bodyPilot";
import { FLIGHT_RULES, piController } from "../agent/controllers/pi";
import { defensiveController, pursuitFallback } from "../agent/controllers/scripted";
import { perfectSensor, radarSensorModel, type SensorModel } from "../agent/observation";
import { competenceEvaluator } from "../eval/outcome";
import { AirframeSchema, MatchReplaySchema, type Airframe, type MatchReplay } from "../protocol/schema";
import type { MatchConfig } from "../runtime/config";
import {
  createAgentMessageBus,
  mergeAgentComms,
  type AgentMessageBus,
  type AgentMessageProvider,
} from "../runtime/comms";
import { createMatchRoundStepper, runMatch, type MatchRoundStepper } from "../runtime/match";
import { formatGps, waypointForAircraft } from "../runtime/navigation";
import { createPhysicsCoachProvider } from "../runtime/physicsCoach";
import {
  FRAME_DT,
  TURN_DURATION,
  createBalloonScenarioAircraft,
  createBvrInterceptAircraft,
  createChallengingBalloonScenarioAircraft,
  createDuelGunStartAircraft,
  createInitialAircraft,
  gentlePropController,
  staticController,
} from "../runtime/scenario";
import { defaultAirframe } from "../sim/airframe";
import { selectRadarDevice } from "../sim/mountedSensor";
import {
  SCRIPTED_BODY_MODEL,
  bodyModelLabel,
  createHeadlessBodyConfig,
} from "../headless/bodyConfig";
import {
  DIRECT_DEEPSEEK_PLANNER_MODEL,
  DIRECT_DEEPSEEK_TWITCH_MODEL,
  StudioScenarioConfigSchema,
  type StudioScenarioConfig,
  type StudioScenarioConfigInput,
} from "../studio/schema";

const NO_CONTACT_SENSOR: SensorModel = {
  detect() {
    return [];
  },
};

const BVR_TARGET_ID = "prop-1";

const BVR_FLIGHT_RULES = `${FLIGHT_RULES}

BVR intercept scenario:
- You are flying the player aircraft as a live pilot in the game engine, not following a scripted intercept.
- This is an intercept-and-identify mission with active-radar BVR missiles available when self.radarMissileLoaded is true.
- messages/comms may include GCI or data-link cues. Treat them as offboard reports; contacts still come from your aircraft sensor model.
- If comms.navigation.waypoints includes a GPS target datum, fly a stable intercept toward that coordinate and general bearing. That datum is not a radar contact; it is offboard tasking.
- If contacts is empty, fly a stable high-energy GPS intercept profile from the GCI cue: stay well above the deck, keep speed up, and avoid steep nose-low dives.
- Physics coach messages are derived from the recorded sim frames before the current decision. Treat them as ground-truth instruction about how your last stick tape actually flew.
- If the coach says heading error did not improve, do not repeat the same "turn" tape. Correct the stick tape until own heading converges on the steer bearing.
- If a radar contact appears, use bearingRight/bearingUp/range/closureRate to point and manage closure. Do not lawn-dart while chasing a low slow target.
- When a contact has radarLock=true and weaponCooldown is ready, arm weapons_free with condition radar_lock and keep the tape smooth. The engine releases the active-radar missile only on a real lock.
- Keep direct trigger false in motor-program samples unless the observation explicitly presents a valid weapon solution.`;

const ScenarioRunRequestSchema = z.object({
  airframe: AirframeSchema,
  scenario: StudioScenarioConfigSchema,
});

const ScenarioRoundMessageSchema = z.object({
  content: z.string().trim().min(1).max(2_000),
  to: z.string().min(1).max(80).default("all"),
});

const ScenarioRoundRequestSchema = ScenarioRunRequestSchema.extend({
  sessionId: z.string().min(1).max(120).optional(),
  reset: z.boolean().optional(),
  message: ScenarioRoundMessageSchema.optional(),
});

export interface ScenarioRunResponse {
  replay: MatchReplay;
}

export interface ScenarioRoundResponse {
  sessionId: string;
  turn: number;
  maxTurns: number;
  complete: boolean;
  replay: MatchReplay;
  progress: import("../runtime/config").MatchProgress[];
}

export async function runScenarioApiRequest(input: unknown): Promise<ScenarioRunResponse> {
  const request = ScenarioRunRequestSchema.parse(input);
  const replay = await runMatch(buildServerScenarioMatchConfig(request.airframe, request.scenario));
  return { replay: MatchReplaySchema.parse(replay) };
}

// Runs a scenario match with streaming progress via the onProgress callback.
// The caller is responsible for serializing progress events (e.g. to SSE).
export async function runScenarioStreaming(
  input: unknown,
  onProgress: (progress: import("../runtime/config").MatchProgress) => void,
): Promise<void> {
  const request = ScenarioRunRequestSchema.parse(input);
  const config = buildServerScenarioMatchConfig(request.airframe, request.scenario);
  await runMatch({ ...config, onProgress });
}

export async function stepScenarioRoundApiRequest(input: unknown): Promise<ScenarioRoundResponse> {
  const request = ScenarioRoundRequestSchema.parse(input);
  const baseConfig = buildServerScenarioMatchConfig(request.airframe, request.scenario);
  const existing =
    request.sessionId && !request.reset ? roundSessions.get(request.sessionId) : undefined;
  const session =
    existing && existing.configId === baseConfig.id
      ? existing
      : createRoundSession(baseConfig);
  roundSessions.set(session.id, session);

  if (request.message) {
    session.bus.send({
      id: `operator-${Date.now()}`,
      from: "operator",
      to: request.message.to,
      channel: "operator",
      priority: "priority",
      content: request.message.content,
      includeNavigation: true,
    });
  }

  const result = await session.stepper.nextRound();
  return {
    sessionId: session.id,
    turn: result.turn,
    maxTurns: baseConfig.maxTurns,
    complete: result.complete,
    replay: MatchReplaySchema.parse(result.replay),
    progress: result.progress,
  };
}

export function buildServerScenarioMatchConfig(
  blueAirframe: Airframe,
  input: StudioScenarioConfigInput,
): MatchConfig {
  const scenario = StudioScenarioConfigSchema.parse(input);
  assertLiveKeysAvailable(scenario);
  const motorProgram = scenario.controlMode === "motor-program";
  const bvrScenario = scenario.kind === "bvr-intercept";
  const frameDt = motorProgram ? scenario.motorProgramSampleMs / 1000 : FRAME_DT;
  const turnDuration = motorProgram ? scenario.motorProgramTurnMs / 1000 : TURN_DURATION;
  const bodyModelSlug = bodyModelSlugFor(motorProgram ? scenario.twitchBodyModel : scenario.bodyModel);
  const initialAircraft = initialAircraftForScenario(blueAirframe, scenario.kind);
  const blueSensor = bvrScenario ? sensorForBvr(initialAircraft) : perfectSensor;
  const body = createHeadlessBodyConfig({
    modelSlug: bodyModelSlug,
    maxTokens: numberEnv("SCENARIO_BODY_MAX_TOKENS", numberEnv("BODY_MAX_TOKENS", 96)),
    maxRetries: numberEnv("SCENARIO_BODY_MAX_RETRIES", numberEnv("BODY_MAX_RETRIES", 2)),
    emptyRetries: numberEnv("SCENARIO_BODY_EMPTY_RETRIES", numberEnv("BODY_EMPTY_RETRIES", 1)),
    timeoutMs: numberEnv("SCENARIO_BODY_TIMEOUT_MS", numberEnv("BODY_TIMEOUT_MS", 8_000)),
    bodyTickDt: frameDt,
  });
  const pilotModelSlug = pilotModelSlugFor(scenario);
  const livePilot = bvrScenario || motorProgram || scenario.pilotModel !== "scripted-body-pilot";
  const actionSpec =
    motorProgram && bvrScenario
      ? motorProgramSpecWithDefaultWeaponsFree("radar-lock")
      : actionSpecs[motorProgram ? "motor-program" : "pilot-intent"];
  const blueController = livePilot
    ? piController({
        slug: pilotModelSlug,
        spec: actionSpec,
        rules: bvrScenario ? BVR_FLIGHT_RULES : FLIGHT_RULES,
        maxTokens: numberEnv("SCENARIO_PILOT_MAX_TOKENS", motorProgram ? 4_096 : 512),
      })
    : bodyPilotController(0.82);
  const balloonScenario = scenario.kind === "balloon" || scenario.kind === "balloon-hard";
  const redEntry =
    bvrScenario
      ? {
          meta: { id: "prop-1", kind: "scripted" as const, label: "Day Tripper (unarmed sightseeing)" },
          controller: gentlePropController,
        }
      : balloonScenario
      ? {
          meta: { id: "balloon", kind: "scripted" as const, label: "balloon (static)" },
          controller: staticController,
        }
      : {
          meta: { id: "red-1", kind: "scripted" as const, label: "defensive" },
          controller: defensiveController(0.64),
        };

  return {
    id: scenarioRunId(scenario),
    turnDuration,
    frameDt,
    maxTurns: normalizedTurnCount(scenario.turnCount),
    decisionTimeoutMs: numberEnv("SCENARIO_DECISION_TIMEOUT_MS", 30_000),
    initialAircraft,
    sensor: bvrScenario ? NO_CONTACT_SENSOR : perfectSensor,
    evaluator: competenceEvaluator,
    fallback: pursuitFallback,
    ...(bvrScenario
      ? {
          comms: {
            providers: [
              bvrGciProvider(),
              createPhysicsCoachProvider({ agentId: "blue-1", targetId: BVR_TARGET_ID }),
            ],
          },
        }
      : {}),
    agents: {
      "blue-1": {
        meta: {
          id: "blue-1",
          kind: livePilot ? "llm" : "scripted",
          label: livePilot
            ? `${pilotModelSlug}/${motorProgram ? "motor-program" : "pilot-intent"}`
            : "scripted body pilot",
          config: {
            bodyId: body.manifest.bodyId,
            ...(motorProgram
              ? {
                  controlMode: "motor-program",
                  twitchBodyModel: bodyModelLabel(bodyModelSlug),
                  motorProgramTurnMs: scenario.motorProgramTurnMs,
                  motorProgramSampleMs: scenario.motorProgramSampleMs,
                  twitchTimeScale: scenario.twitchTimeScale,
                }
              : { bodyModel: bodyModelLabel(bodyModelSlug) }),
          },
        },
        controller: blueController,
        sensor: blueSensor,
        ...(motorProgram ? { reflexBody: body, reflexPlaybackTimeScale: scenario.twitchTimeScale } : { body }),
      },
      [redEntry.meta.id]: redEntry,
    },
  };
}

function initialAircraftForScenario(blueAirframe: Airframe, kind: StudioScenarioConfig["kind"]) {
  if (kind === "bvr-intercept") return createBvrInterceptAircraft(blueAirframe);
  if (kind === "balloon-hard") return createChallengingBalloonScenarioAircraft(blueAirframe);
  if (kind === "balloon") return createBalloonScenarioAircraft(blueAirframe);
  if (kind === "stern-gun") return createDuelGunStartAircraft(blueAirframe, defaultAirframe());
  return createInitialAircraft(blueAirframe, defaultAirframe());
}

function bvrGciProvider(): AgentMessageProvider {
  return (context) => {
    if (context.agentId !== "blue-1") return [];
    const target = context.world.find((ship) => ship.id === BVR_TARGET_ID);
    if (!target) return [];
    const waypoint = waypointForAircraft({
      id: "bvr-target-datum",
      label: "Day Tripper last GPS",
      self: context.self,
      target,
      note: "Offboard GCI coordinate; radar must still acquire before FOX-3.",
    });
    return [
      {
        id: "bvr-gci-gps-datum",
        from: "GCI",
        to: "blue-1",
        channel: "gci",
        priority: "priority",
        content:
          `GCI to INTERCEPTOR-1: slow propeller aircraft last GPS ${formatGps(waypoint.gps)}, ` +
          `alt ${Math.round((waypoint.altitudeM ?? 0) / 100) * 100} m. ` +
          `Steer ${Math.round(waypoint.bearingDeg ?? 0).toString().padStart(3, "0")} ${waypoint.compass ?? ""} ` +
          `for ${Math.round((waypoint.rangeM ?? 0) / 1000)} km until your radar paints it. ` +
          `Once contact.radarLock=true and cooldown is ready, arm weapons_free condition radar_lock for FOX-3.`,
        repeat: "each-turn",
        navigation: {
          ...context.navigation,
          waypoints: [waypoint],
        },
      },
    ];
  };
}

interface RoundSession {
  id: string;
  configId: string;
  bus: AgentMessageBus;
  stepper: MatchRoundStepper;
}

const roundSessions = new Map<string, RoundSession>();

function createRoundSession(baseConfig: MatchConfig): RoundSession {
  const bus = createAgentMessageBus();
  const config: MatchConfig = {
    ...baseConfig,
    comms: mergeAgentComms(baseConfig.comms, { buses: [bus] }),
  };
  return {
    id: `scenario-round-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    configId: baseConfig.id,
    bus,
    stepper: createMatchRoundStepper(config),
  };
}

function sensorForBvr(aircraft: ReturnType<typeof createBvrInterceptAircraft>): SensorModel {
  const blue = aircraft.find((ship) => ship.id === "blue-1");
  const radar = selectRadarDevice(blue?.devices);
  return radar ? radarSensorModel(radar) : NO_CONTACT_SENSOR;
}

function scenarioRunId(scenario: StudioScenarioConfig): string {
  const motorProgram = scenario.controlMode === "motor-program";
  const pilot = safeSlug(pilotModelSlugFor(scenario));
  const body = bodyModelSlugFor(motorProgram ? scenario.twitchBodyModel : scenario.bodyModel);
  const bodyLabel = body === SCRIPTED_BODY_MODEL ? "scripted-body" : safeSlug(body);
  const mode = motorProgram ? `motor:${scenario.motorProgramTurnMs}x${scenario.motorProgramSampleMs}` : "body-pilot";
  return `studio-scenario|${scenario.kind}|${mode}|${pilot}|${bodyLabel}|turns:${normalizedTurnCount(scenario.turnCount)}`;
}

function bodyModelSlugFor(bodyModel: StudioScenarioConfig["bodyModel"]): string {
  return bodyModel === "scripted-fixed-wing-body" ? SCRIPTED_BODY_MODEL : bodyModel;
}

function pilotModelSlugFor(scenario: StudioScenarioConfig): string {
  if (scenario.controlMode === "motor-program") {
    return scenario.pilotModel === "scripted-body-pilot" ? DIRECT_DEEPSEEK_PLANNER_MODEL : scenario.pilotModel;
  }
  if (scenario.kind === "bvr-intercept" && scenario.pilotModel === "scripted-body-pilot") {
    return DIRECT_DEEPSEEK_PLANNER_MODEL;
  }
  return scenario.pilotModel;
}

function assertLiveKeysAvailable(scenario: StudioScenarioConfig): void {
  if (scenario.controlMode === "motor-program") {
    assertModelKey(pilotModelSlugFor(scenario), "motor-program planner");
    assertModelKey(bodyModelSlugFor(scenario.twitchBodyModel), "twitch body");
    return;
  }
  if (scenario.kind === "bvr-intercept") {
    assertModelKey(pilotModelSlugFor(scenario), "BVR pilot");
    if (scenario.bodyModel !== "scripted-fixed-wing-body") {
      assertModelKey(bodyModelSlugFor(scenario.bodyModel), "BVR body");
    }
    return;
  }
  if (scenario.pilotModel !== "scripted-body-pilot") assertModelKey(scenario.pilotModel, "scenario pilot");
  if (scenario.bodyModel !== "scripted-fixed-wing-body") assertModelKey(bodyModelSlugFor(scenario.bodyModel), "scenario body");
}

function assertModelKey(modelSlug: string, role: string): void {
  if (modelSlug === SCRIPTED_BODY_MODEL || modelSlug === "scripted-body-pilot") return;
  if (isDirectDeepSeekSlug(modelSlug)) {
    if (!process.env.DEEPSEEK_API_KEY) {
      throw new Error(`DEEPSEEK_API_KEY is required for ${role} model ${modelSlug}`);
    }
    return;
  }
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error(`OPENROUTER_API_KEY is required for ${role} model ${modelSlug}`);
  }
}

function isDirectDeepSeekSlug(modelSlug: string): boolean {
  return modelSlug.startsWith("deepseek-v");
}

function numberEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizedTurnCount(turnCount: number): number {
  return Math.max(1, Math.min(80, Math.round(Number.isFinite(turnCount) ? turnCount : 2)));
}

function safeSlug(value: string): string {
  return value.replace(/[^a-z0-9.]+/gi, "-").replace(/^-|-$/g, "");
}
