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
  StudioScenarioConfigSchema,
  type StudioScenarioConfig,
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

export function buildServerScenarioMatchConfig(
  blueAirframe: Airframe,
  scenario: StudioScenarioConfig,
): MatchConfig {
  assertLiveKeysAvailable(scenario);
  const bodyModelSlug = bodyModelSlugFor(scenario.bodyModel);
  const body = createHeadlessBodyConfig({
    modelSlug: bodyModelSlug,
    maxTokens: numberEnv("SCENARIO_BODY_MAX_TOKENS", numberEnv("BODY_MAX_TOKENS", 96)),
    maxRetries: numberEnv("SCENARIO_BODY_MAX_RETRIES", numberEnv("BODY_MAX_RETRIES", 2)),
    emptyRetries: numberEnv("SCENARIO_BODY_EMPTY_RETRIES", numberEnv("BODY_EMPTY_RETRIES", 1)),
    timeoutMs: numberEnv("SCENARIO_BODY_TIMEOUT_MS", numberEnv("BODY_TIMEOUT_MS", 8_000)),
  });
  const livePilot = scenario.pilotModel !== "scripted-body-pilot";
  const blueController = livePilot
    ? piController({
        slug: scenario.pilotModel,
        spec: actionSpecs["pilot-intent"],
        rules: FLIGHT_RULES,
        maxTokens: numberEnv("SCENARIO_PILOT_MAX_TOKENS", 512),
      })
    : bodyPilotController(0.82);
  const redEntry =
    scenario.kind === "balloon"
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
    turnDuration: TURN_DURATION,
    frameDt: FRAME_DT,
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
          label: livePilot ? `${scenario.pilotModel}/pilot-intent` : "scripted body pilot",
          config: {
            bodyId: body.manifest.bodyId,
            bodyModel: bodyModelLabel(bodyModelSlug),
          },
        },
        controller: blueController,
        body,
      },
      [redEntry.meta.id]: redEntry,
    },
  };
}

function initialAircraftForScenario(blueAirframe: Airframe, kind: StudioScenarioConfig["kind"]) {
  if (kind === "balloon") return createBalloonScenarioAircraft(blueAirframe);
  if (kind === "stern-gun") return createDuelGunStartAircraft(blueAirframe, defaultAirframe());
  return createInitialAircraft(blueAirframe, defaultAirframe());
}

function scenarioRunId(scenario: StudioScenarioConfig): string {
  const pilot = scenario.pilotModel === "scripted-body-pilot" ? "scripted-pilot" : safeSlug(scenario.pilotModel);
  const body = scenario.bodyModel === "scripted-fixed-wing-body" ? "scripted-body" : safeSlug(scenario.bodyModel);
  return `studio-scenario|${scenario.kind}|${pilot}|${body}|turns:${normalizedTurnCount(scenario.turnCount)}`;
}

function bodyModelSlugFor(bodyModel: StudioScenarioConfig["bodyModel"]): string {
  return bodyModel === "scripted-fixed-wing-body" ? SCRIPTED_BODY_MODEL : bodyModel;
}

function assertLiveKeysAvailable(scenario: StudioScenarioConfig): void {
  const livePilot = scenario.pilotModel !== "scripted-body-pilot";
  const liveBody = scenario.bodyModel !== "scripted-fixed-wing-body";
  if (livePilot && !process.env.OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY is required for the live scenario pilot");
  }
  if (liveBody && !process.env.OPENROUTER_API_KEY && !process.env.DEEPSEEK_API_KEY) {
    throw new Error("OPENROUTER_API_KEY or DEEPSEEK_API_KEY is required for the live scenario body");
  }
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
