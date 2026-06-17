import { z } from "zod";
import { actionSpecs } from "../agent/actionSpec";
import { bodyPilotController } from "../agent/controllers/bodyPilot";
import { FLIGHT_RULES, piController } from "../agent/controllers/pi";
import { defensiveController, pursuitFallback } from "../agent/controllers/scripted";
import { perfectSensor, radarSensorModel, type SensorModel } from "../agent/observation";
import { competenceEvaluator } from "../eval/outcome";
import { AirframeSchema, MatchReplaySchema, type Airframe, type MatchReplay } from "../protocol/schema";
import type { MatchConfig } from "../runtime/config";
import { runMatch } from "../runtime/match";
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

const BVR_GCI_MESSAGE =
  "GCI to INTERCEPTOR-1: SLOW CONTACT LAST KNOWN BRG 315, RANGE 42 KM, ALTITUDE LOW. INTERCEPT AND IDENTIFY. If radarLock appears, arm weapons_free condition radar_lock for FOX-3 release; do not assume visual tally.";

const BVR_FLIGHT_RULES = `${FLIGHT_RULES}

BVR intercept scenario:
- You are flying the player aircraft as a live pilot in the game engine, not following a scripted intercept.
- This is an intercept-and-identify mission with active-radar BVR missiles available when self.radarMissileLoaded is true.
- messages may include GCI or data-link cues. Treat them as offboard reports; contacts still come from your aircraft sensor model.
- If contacts is empty, fly a stable high-energy search/intercept profile from the GCI cue: stay well above the deck, keep speed up, and avoid steep nose-low dives.
- If a radar contact appears, use bearingRight/bearingUp/range/closureRate to point and manage closure. Do not lawn-dart while chasing a low slow target.
- When a contact has radarLock=true and weaponCooldown is ready, arm weapons_free with condition radar_lock and keep the tape smooth. The engine releases the active-radar missile only on a real lock.
- Keep direct trigger false in motor-program samples unless the observation explicitly presents a valid weapon solution.`;

const ScenarioRunRequestSchema = z.object({
  airframe: AirframeSchema,
  scenario: StudioScenarioConfigSchema,
});

export interface ScenarioRunResponse {
  replay: MatchReplay;
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
  const blueController = livePilot
    ? piController({
        slug: pilotModelSlug,
        spec: actionSpecs[motorProgram ? "motor-program" : "pilot-intent"],
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
        ...(bvrScenario ? { messages: [BVR_GCI_MESSAGE] } : {}),
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
