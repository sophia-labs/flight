// Headless pilot training chamber.
//
// Example:
//   FLIGHT_GARDEN_GRAPH_ID=flight-training \
//   FLIGHT_GARDEN_MCP_URL=http://127.0.0.1:8086/mcp \
//   FLIGHT_GARDEN_TOKEN=dev-token \
//   CHAMBER_SORTIES=3 \
//   CHAMBER_REFLECTION_MODEL=deepseek-v4-pro \
//   npm run chamber
import { aircraftArchetypes } from "../sim/aircraftCatalog";
import { runTrainingChamber, type TrainingDrillInput } from "../training/chamber";
import {
  DIRECT_DEEPSEEK_PLANNER_MODEL,
  DIRECT_DEEPSEEK_TWITCH_MODEL,
  type StudioScenarioConfigInput,
} from "../studio/schema";

async function main(): Promise<void> {
  const requestedDrill = process.env.CHAMBER_DRILL?.trim();
  const airframeId = env("CHAMBER_AIRFRAME", requestedDrill === "prop-flight-camp" ? "day-tripper" : "variable-sweep-tomcat");
  const archetype = aircraftArchetypes.find((candidate) => candidate.id === airframeId);
  if (!archetype) {
    throw new Error(`unknown CHAMBER_AIRFRAME=${airframeId}`);
  }

  const scenario = scenarioFromEnv();
  const drill = drillFromEnv(scenario);
  const sorties = numberEnv("CHAMBER_SORTIES", 3);
  const pilotId = env("CHAMBER_PILOT_ID", "blue-1");
  const reflectionModel = env("CHAMBER_REFLECTION_MODEL", drill?.pilotModel ?? scenario.pilotModel);

  console.error(
    `chamber: sorties=${sorties} scenario=${scenario.kind} ` +
      `${drill ? `drill=${drill.kind} ` : ""}control=${scenario.controlMode} ` +
      `pilot=${drill?.pilotModel ?? scenario.pilotModel} reflection=${reflectionModel}`,
  );

  const result = await runTrainingChamber({
    airframe: archetype.airframe,
    scenario,
    ...(drill ? { drill } : {}),
    sorties,
    runId: process.env.CHAMBER_RUN_ID,
    pilotId,
    reflectionModel,
    reflectionMaxTokens: numberEnv("CHAMBER_REFLECTION_MAX_TOKENS", 1_200),
    onProgress(progress) {
      console.error(`chamber s${progress.sortieIndex} ${progress.phase}: ${progress.message}`);
    },
  });

  const summary = {
    runId: result.runId,
    pilotId: result.pilotId,
    graphId: result.graphId,
    currentStateDocumentId: result.currentStateDocumentId,
    sorties: result.sorties.map((sortie) => ({
      index: sortie.sortieIndex,
      replayId: sortie.replay.id,
      sortieDocumentId:
        sortie.sortieJournal.enabled && sortie.sortieJournal.status === "written"
          ? sortie.sortieJournal.documentId
          : undefined,
      reflectionDocumentId: sortie.reflectionJournal.documentId,
      currentStateDocumentId: sortie.currentStateJournal.documentId,
      reflectionModel: sortie.reflection.model,
      reflectionScripted: sortie.reflection.scripted,
      turns: sortie.reflection.grounding.turns,
      outcome: sortie.reflection.grounding.outcome,
    })),
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

function scenarioFromEnv(): StudioScenarioConfigInput {
  const kind = env("CHAMBER_SCENARIO", "bvr-intercept") as StudioScenarioConfigInput["kind"];
  const controlMode = env("CHAMBER_CONTROL_MODE", "motor-program") as StudioScenarioConfigInput["controlMode"];
  const pilotModel = env("CHAMBER_PILOT_MODEL", DIRECT_DEEPSEEK_PLANNER_MODEL);
  return {
    schemaVersion: 1,
    kind,
    controlMode,
    pilotModel,
    bodyModel: env("CHAMBER_BODY_MODEL", "scripted-fixed-wing-body"),
    twitchBodyModel: env("CHAMBER_TWITCH_BODY_MODEL", DIRECT_DEEPSEEK_TWITCH_MODEL),
    turnCount: numberEnv("CHAMBER_TURNS", kind === "bvr-intercept" ? 8 : 4),
    motorProgramTurnMs: numberEnv("CHAMBER_MOTOR_PROGRAM_TURN_MS", 2_500),
    motorProgramSampleMs: numberEnv("CHAMBER_MOTOR_PROGRAM_SAMPLE_MS", 50),
    twitchTimeScale: numberEnv("CHAMBER_TWITCH_TIME_SCALE", 0.35),
    cameraMode: "pilot-cinema",
  };
}

function drillFromEnv(scenario: StudioScenarioConfigInput): TrainingDrillInput | undefined {
  const kind = process.env.CHAMBER_DRILL?.trim();
  if (!kind) return undefined;
  if (kind !== "positive-aoa-load" && kind !== "prop-flight-camp") {
    throw new Error(`unknown CHAMBER_DRILL=${kind}`);
  }
  return {
    kind,
    pilotModel: env("CHAMBER_PILOT_MODEL", scenario.pilotModel),
    stage: process.env.CHAMBER_DRILL_STAGE?.trim() || undefined,
    turnCount: numberEnv("CHAMBER_TURNS", 6),
    motorProgramTurnMs: numberEnv("CHAMBER_MOTOR_PROGRAM_TURN_MS", 2_500),
    motorProgramSampleMs: numberEnv("CHAMBER_MOTOR_PROGRAM_SAMPLE_MS", 50),
    decisionTimeoutMs: numberEnv("CHAMBER_DECISION_TIMEOUT_MS", 60_000),
  };
}

function env(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value || fallback;
}

function numberEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
