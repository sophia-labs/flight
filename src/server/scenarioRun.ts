import { z } from "zod";
import { actionSpecs } from "../agent/actionSpec";
import { bodyPilotController } from "../agent/controllers/bodyPilot";
import { FLIGHT_RULES, piController } from "../agent/controllers/pi";
import { defensiveController, pursuitFallback } from "../agent/controllers/scripted";
import { perfectSensor } from "../agent/observation";
import { competenceEvaluator } from "../eval/outcome";
import { AirframeSchema, MatchReplaySchema, type Airframe, type MatchReplay } from "../protocol/schema";
import type { MatchConfig } from "../runtime/config";
import { runMatch } from "../runtime/match";
import {
  FRAME_DT,
  TURN_DURATION,
  createBalloonScenarioAircraft,
  createChallengingBalloonScenarioAircraft,
  createDuelGunStartAircraft,
  createInitialAircraft,
  staticController,
} from "../runtime/scenario";
import { defaultAirframe } from "../sim/airframe";
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
  const frameDt = motorProgram ? scenario.motorProgramSampleMs / 1000 : FRAME_DT;
  const turnDuration = motorProgram ? scenario.motorProgramTurnMs / 1000 : TURN_DURATION;
  const bodyModelSlug = bodyModelSlugFor(motorProgram ? scenario.twitchBodyModel : scenario.bodyModel);
  const body = createHeadlessBodyConfig({
    modelSlug: bodyModelSlug,
    maxTokens: numberEnv("SCENARIO_BODY_MAX_TOKENS", numberEnv("BODY_MAX_TOKENS", 96)),
    maxRetries: numberEnv("SCENARIO_BODY_MAX_RETRIES", numberEnv("BODY_MAX_RETRIES", 2)),
    emptyRetries: numberEnv("SCENARIO_BODY_EMPTY_RETRIES", numberEnv("BODY_EMPTY_RETRIES", 1)),
    timeoutMs: numberEnv("SCENARIO_BODY_TIMEOUT_MS", numberEnv("BODY_TIMEOUT_MS", 8_000)),
    bodyTickDt: frameDt,
  });
  const pilotModelSlug = pilotModelSlugFor(scenario);
  const livePilot = motorProgram || scenario.pilotModel !== "scripted-body-pilot";
  const blueController = livePilot
    ? piController({
        slug: pilotModelSlug,
        spec: actionSpecs[motorProgram ? "motor-program" : "pilot-intent"],
        rules: FLIGHT_RULES,
        maxTokens: numberEnv("SCENARIO_PILOT_MAX_TOKENS", motorProgram ? 4_096 : 512),
      })
    : bodyPilotController(0.82);
  const balloonScenario = scenario.kind === "balloon" || scenario.kind === "balloon-hard";
  const redEntry =
    balloonScenario
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
    initialAircraft: initialAircraftForScenario(blueAirframe, scenario.kind),
    sensor: perfectSensor,
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
        ...(motorProgram ? { reflexBody: body, reflexPlaybackTimeScale: scenario.twitchTimeScale } : { body }),
      },
      [redEntry.meta.id]: redEntry,
    },
  };
}

function initialAircraftForScenario(blueAirframe: Airframe, kind: StudioScenarioConfig["kind"]) {
  if (kind === "balloon-hard") return createChallengingBalloonScenarioAircraft(blueAirframe);
  if (kind === "balloon") return createBalloonScenarioAircraft(blueAirframe);
  if (kind === "stern-gun") return createDuelGunStartAircraft(blueAirframe, defaultAirframe());
  return createInitialAircraft(blueAirframe, defaultAirframe());
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
  return scenario.pilotModel;
}

function assertLiveKeysAvailable(scenario: StudioScenarioConfig): void {
  if (scenario.controlMode === "motor-program") {
    assertModelKey(pilotModelSlugFor(scenario), "motor-program planner");
    assertModelKey(bodyModelSlugFor(scenario.twitchBodyModel), "twitch body");
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
