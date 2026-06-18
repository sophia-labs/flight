import { createHash } from "node:crypto";
import { motorProgramSpecWithDefaultWeaponsFree } from "../agent/actionSpec";
import type { Controller } from "../agent/controller";
import { piController } from "../agent/controllers/pi";
import { pursuitFallback } from "../agent/controllers/scripted";
import type { SensorModel } from "../agent/observation";
import { buildServerScenarioMatchConfig } from "../server/scenarioRun";
import {
  DEFAULT_DEBRIEF_MODEL,
  debriefScenarioReplay,
  type ScenarioDebriefResponse,
} from "../server/scenarioDebrief";
import { buildDebriefGrounding, debriefEvidenceBlock } from "../server/debriefContext";
import {
  MatchReplaySchema,
  type Airframe,
  type MatchReplay,
  type MotorProgramAction,
} from "../protocol/schema";
import { runMatch } from "../runtime/match";
import { mergeAgentComms, type AgentMessageProvider } from "../runtime/comms";
import type { MatchConfig } from "../runtime/config";
import { createBvrInterceptAircraft } from "../runtime/scenario";
import { competenceEvaluator } from "../eval/outcome";
import { compileAirframe } from "../sim/airframe";
import { fullFuelByTank } from "../sim/mass";
import { length, quatLookRotation, vec3 } from "../sim/math";
import {
  StudioScenarioConfigSchema,
  type StudioScenarioConfig,
  type StudioScenarioConfigInput,
} from "../studio/schema";
import {
  callGardenTool,
  resolveGardenConnection,
  type GardenMcpConnection,
} from "../garden/client";
import {
  journalScenarioReplay,
  type GardenJournalResult,
  type GardenJournalWritten,
} from "../garden/sortieJournal";

export interface PilotGardenContext {
  pilotId: string;
  currentStateDocumentId: string;
  currentState?: {
    content: string;
  };
  missingReason?: string;
}

export interface TrainingChamberProgress {
  phase: "context" | "sortie_start" | "sortie_complete" | "reflection" | "state_written";
  sortieIndex: number;
  message: string;
}

export interface TrainingChamberOptions {
  airframe: Airframe;
  scenario: StudioScenarioConfigInput;
  drill?: TrainingDrillInput;
  sorties: number;
  runId?: string;
  pilotId?: string;
  targetId?: string;
  reflectionModel?: string;
  reflectionMaxTokens?: number;
  connection?: GardenMcpConnection;
  env?: Record<string, string | undefined>;
  runSortie?: (input: TrainingChamberSortieInput) => Promise<MatchReplay>;
  onProgress?: (progress: TrainingChamberProgress) => void;
}

export type TrainingDrillKind = "positive-aoa-load" | "prop-flight-camp";

export interface TrainingDrillInput {
  kind: TrainingDrillKind;
  pilotModel?: string;
  stage?: string;
  turnCount?: number;
  motorProgramTurnMs?: number;
  motorProgramSampleMs?: number;
  decisionTimeoutMs?: number;
}

export interface TrainingChamberSortieInput {
  sortieIndex: number;
  config: MatchConfig;
  gardenContext: PilotGardenContext;
}

export interface TrainingChamberSortieResult {
  sortieIndex: number;
  replay: MatchReplay;
  gardenContext: PilotGardenContext;
  sortieJournal: GardenJournalResult;
  reflection: ScenarioDebriefResponse;
  reflectionJournal: GardenJournalWritten;
  currentStateJournal: GardenJournalWritten;
}

export interface TrainingChamberResult {
  runId: string;
  pilotId: string;
  graphId: string;
  currentStateDocumentId: string;
  sorties: TrainingChamberSortieResult[];
}

interface GardenDocumentRead {
  content?: string;
  markdown?: string;
  document?: {
    content?: string;
    markdown?: string;
    text?: string;
  };
  text?: string;
}

interface GardenWriteResult {
  blockIds?: string[];
}

interface NormalizedTrainingDrill {
  kind: TrainingDrillKind;
  pilotModel: string;
  stage?: string;
  turnCount: number;
  motorProgramTurnMs: number;
  motorProgramSampleMs: number;
  decisionTimeoutMs: number;
}

interface TrainingRunDescriptor {
  kind: string;
  label: string;
  controlMode: string;
  lesson: string;
  briefingFocus: string;
  reflectionFocus: string;
  targetId?: string;
}

const NO_CONTACT_SENSOR: SensorModel = {
  detect() {
    return [];
  },
};

const POSITIVE_AOA_LOAD_RULES = `You are an autonomous pilot flying one aircraft in a training drill.

This is NOT a dogfight, intercept, radar, or weapons problem. There is no target. There are no shots to take. Your only job is to learn a motor tape that makes the aircraft produce measured positive angle-of-attack and load while preserving altitude.

Positive AoA/load drill:
- Success is ownship response: sustained positive AoA and load, not heading, contact acquisition, or weapons.
- Near-term target: peak AoA at least +2 degrees and peak load at least 2.0 G during the turn.
- Keep the floor irrelevant: do not lose more than about 250 m in a turn, do not stall, and do not use huge bank to fake maneuvering.
- If prior Garden or coach evidence says peakG stayed near 1.0-1.5 or peakAoA stayed near 0, your last tape was still unloaded. Increase sustained positive pitch and reduce roll/yaw complexity.
- Start simple: wings near level or mild bank, throttle high, direct positive pitch held long enough for the aircraft to answer.
- Do not write "pull" unless your samples actually hold positive pitch. The aircraft grades the samples, not the prose.
- Leave trigger=false and heldActions empty.`;

const POSITIVE_AOA_LOAD_ACTION_SPEC = {
  ...motorProgramSpecWithDefaultWeaponsFree("none"),
  rules: [
    "ACTION (motor-program drill): output a smooth control tape for the next ~2.5 seconds.",
    "Use durationMs=2500 and sampleDtMs=50 unless the observation says otherwise.",
    "For this drill, leave heldActions=[] and trigger=false in every sample.",
    "Pitch is direct stick/elevator: positive pitch commands nose-up pull/load, negative pitch unloads.",
    "Use sparse control knots if helpful; the runtime resamples them into a smooth 50ms tape.",
    "Keep roll/yaw small until the aircraft has shown measured positive AoA and >2 G.",
  ].join("\n"),
};

function positiveAoaLoadRules(stage: string): string {
  const stageRule =
    stage === "pitch-saturation"
      ? [
          "Stage focus: pitch saturation. Controls are bounded: pitch=+1.0 is full nose-up stick and the maximum allowed value; do not propose pitch above +1.0.",
          "For the first three turns, hold pitch=+1.0 for the full tape unless the aircraft stalls or approaches the floor.",
          "If speed rises while AoA stays low, reduce throttle before reducing pitch. The lesson is to map full-up elevator authority.",
        ].join("\n")
      : stage === "low-speed-pitch"
      ? [
          "Stage focus: low-speed pitch authority. You start slower than the BVR drill because the probe showed full pitch can produce >2 deg AoA below roughly 320 m/s.",
          "Hold pitch=+1.0 for the opening turns and keep throttle low to moderate (0.0-0.3) until measured AoA is established.",
          "Do not reduce pitch merely because the aircraft climbs. This stage is about mapping AoA/load at lower speed, not maintaining a tactical intercept profile.",
        ].join("\n")
      : stage === "very-low-speed-pitch"
      ? [
          "Stage focus: very-low-speed pitch authority. You start near 280 m/s because the probe showed full pitch can produce roughly 3+ deg AoA there.",
          "For the opening turns, hold pitch=+1.0 and keep throttle low (0.0-0.2) unless the aircraft approaches the floor or stalls.",
          "Do not add roll/yaw yet. This sortie is an envelope probe: learn whether speed reduction breaks through the AoA shelf before adding turn geometry.",
        ].join("\n")
      : stage === "pitch-ramp-map"
      ? [
          "Stage focus: pitch response mapping. The last sorties showed full pitch produces only a transient before a 2 deg AoA shelf, so do not start at full pitch.",
          "Use this turn-indexed schedule: turn 1 pitch=+0.30, turn 2 pitch=+0.50, turn 3 pitch=+0.70, turn 4 pitch=+0.90, turns 5+ pitch=+1.00.",
          "Keep throttle fixed near 0.10 and roll/yaw exactly 0. The purpose is to map the response curve, not improvise a maneuver.",
        ].join("\n")
      : stage === "pitch-ramp-throttle-step"
      ? [
          "Stage focus: test the throttle hypothesis after the pitch ramp found a reproducible 2 deg AoA shelf.",
          "Use this pitch schedule: turn 1 pitch=+0.30, turn 2 pitch=+0.50, turn 3 pitch=+0.70, turn 4 pitch=+0.90, turns 5+ pitch=+1.00.",
          "Use this throttle schedule: turns 1-3 throttle=0.10, turns 4-5 throttle=0.30, turns 6+ throttle=0.50. Keep roll/yaw exactly 0.",
        ].join("\n")
      : "Stage focus: discover the lowest simple pitch tape that produces measured positive AoA and load.";
  return `${POSITIVE_AOA_LOAD_RULES}\n\n${stageRule}`;
}

function positiveAoaLoadActionSpec(stage: string) {
  const stageRule =
    stage === "pitch-saturation"
      ? "Pitch saturation stage: pitch is clamped to [-1,+1]. Use pitch=1.0 as full nose-up stick; do not emit values above 1.0."
      : stage === "low-speed-pitch"
      ? "Low-speed pitch stage: pitch is clamped to [-1,+1]. Start with pitch=1.0 and throttle 0.0-0.3 to map positive AoA at the lower-speed start."
      : stage === "very-low-speed-pitch"
      ? "Very-low-speed pitch stage: pitch is clamped to [-1,+1]. Start with pitch=1.0, roll/yaw=0, and throttle 0.0-0.2 to map AoA around 280 m/s."
      : stage === "pitch-ramp-map"
      ? "Pitch-ramp-map stage: pitch is clamped to [-1,+1]. Use turn 1=0.30, turn 2=0.50, turn 3=0.70, turn 4=0.90, turns 5+=1.00; throttle=0.10, roll=0, yaw=0."
      : stage === "pitch-ramp-throttle-step"
      ? "Pitch-ramp-throttle-step stage: use pitch 0.30/0.50/0.70/0.90/1.00 by turn; throttle 0.10 for turns 1-3, 0.30 for turns 4-5, 0.50 for turns 6+; roll=0, yaw=0."
      : "Pitch is clamped to [-1,+1]. If smaller positive pitch values do not load the aircraft, increase toward the +1.0 maximum.";
  return {
    ...POSITIVE_AOA_LOAD_ACTION_SPEC,
    rules: `${POSITIVE_AOA_LOAD_ACTION_SPEC.rules}\n${stageRule}`,
  };
}

const PROP_FLIGHT_CAMP_RULES = `You are an autonomous student pilot flying a small, unarmed propeller aircraft in flight camp.

This is NOT combat. There is no target, no radar, no weapons, and no reason to fire. Your job is to learn stable aircraft control from measured ownship response.

Propeller flight camp:
- Success is basic airmanship: stay alive, keep the aircraft unstalled, preserve altitude, and maintain a usable prop-plane airspeed.
- Near-term target: hold altitude within about 150 m, keep airspeed roughly 45-80 m/s, keep AoA modest and positive, and avoid G spikes.
- Use small smooth inputs. A prop trainer should not need abrupt full-stick commands in normal flight.
- Pitch sets climb/descent and airspeed tradeoff. Throttle manages energy. Roll should be introduced gradually and coordinated with pitch.
- If a turn loses altitude or airspeed, reduce bank, add throttle, and use a smaller positive pitch correction.
- Leave trigger=false and heldActions empty.`;

const PROP_FLIGHT_CAMP_ACTION_SPEC = {
  ...motorProgramSpecWithDefaultWeaponsFree("none"),
  rules: [
    "ACTION (prop flight camp): output a smooth control tape for the next ~2.5 seconds.",
    "Use durationMs=2500 and sampleDtMs=50 unless the observation says otherwise.",
    "For this drill, leave heldActions=[] and trigger=false in every sample.",
    "Use gentle stick: pitch normally between -0.25 and +0.35, roll normally between -0.35 and +0.35, yaw near 0.",
    "Keep throttle in a prop-training band, usually 0.45-0.75 unless recovering energy.",
    "Make one small experiment at a time so the next debrief can connect command to aircraft response.",
  ].join("\n"),
};

export async function runTrainingChamber(options: TrainingChamberOptions): Promise<TrainingChamberResult> {
  const scenario = StudioScenarioConfigSchema.parse(options.scenario);
  const drill = options.drill ? normalizeTrainingDrill(options.drill, scenario) : undefined;
  const descriptor = drill ? drillDescriptor(drill) : scenarioDescriptor(scenario);
  const sorties = clampSorties(options.sorties);
  const runId = options.runId ?? newChamberRunId();
  const pilotId = options.pilotId ?? "blue-1";
  const reflectionModel = options.reflectionModel ?? DEFAULT_DEBRIEF_MODEL;
  const connection = options.connection ?? await requireGardenConnection(options.env);
  const currentStateDocumentId = pilotCurrentStateDocumentId(pilotId);
  const results: TrainingChamberSortieResult[] = [];

  for (let index = 1; index <= sorties; index += 1) {
    const gardenContext = await readPilotGardenContext(connection, pilotId, currentStateDocumentId);
    options.onProgress?.({
      phase: "context",
      sortieIndex: index,
      message: gardenContext.currentState ? "loaded pilot Garden current state" : "no pilot Garden current state yet",
    });

    const baseConfig = drill
      ? buildDrillMatchConfig(options.airframe, drill, pilotId)
      : buildServerScenarioMatchConfig(options.airframe, scenario);
    const config = withGardenBriefing(baseConfig, gardenContext, index, descriptor);
    options.onProgress?.({
      phase: "sortie_start",
      sortieIndex: index,
      message: `running sortie ${index}/${sorties}`,
    });
    const replay = withChamberReplayId(
      MatchReplaySchema.parse(
        await (options.runSortie ?? defaultRunSortie)({ sortieIndex: index, config, gardenContext }),
      ),
      runId,
      index,
    );
    options.onProgress?.({
      phase: "sortie_complete",
      sortieIndex: index,
      message: `sortie ${index} replay complete`,
    });

    const targetId = options.targetId ?? descriptor.targetId;
    const sortieJournal = await journalScenarioReplay(replay, {
      connection,
      pilotId,
      targetId,
    });
    const reflection = await debriefScenarioReplay(replay, {
      pilotId,
      targetId,
      model: reflectionModel,
      maxTokens: options.reflectionMaxTokens,
      messages: [{ role: "user", content: reflectionPrompt(gardenContext, index, descriptor) }],
    });
    options.onProgress?.({
      phase: "reflection",
      sortieIndex: index,
      message: `pilot reflected on sortie ${index}`,
    });

    const reflectionJournal = await writeReflectionDocument(connection, {
      sortieIndex: index,
      pilotId,
      replay,
      reflection,
      gardenContext,
    });
    const currentStateJournal = await writeCurrentStateDocument(connection, {
      sortieIndex: index,
      pilotId,
      descriptor,
      replay,
      reflection,
      currentStateDocumentId,
      previousContext: gardenContext,
    });
    options.onProgress?.({
      phase: "state_written",
      sortieIndex: index,
      message: `updated ${currentStateDocumentId}`,
    });

    results.push({
      sortieIndex: index,
      replay,
      gardenContext,
      sortieJournal,
      reflection,
      reflectionJournal,
      currentStateJournal,
    });
  }

  return {
    runId,
    pilotId,
    graphId: connection.graphId,
    currentStateDocumentId,
    sorties: results,
  };
}

function withChamberReplayId(replay: MatchReplay, runId: string, sortieIndex: number): MatchReplay {
  return MatchReplaySchema.parse({
    ...replay,
    id: `${replay.id}|chamber:${runId}:s${sortieIndex}`,
  });
}

export function pilotCurrentStateDocumentId(pilotId: string): string {
  return `flight-pilot-${slug(pilotId)}-current-state`;
}

function withGardenBriefing(
  config: MatchConfig,
  gardenContext: PilotGardenContext,
  sortieIndex: number,
  descriptor: TrainingRunDescriptor,
): MatchConfig {
  return {
    ...config,
    comms: mergeAgentComms(config.comms, {
      providers: [gardenBriefingProvider(gardenContext, sortieIndex, descriptor)],
    }),
  };
}

function gardenBriefingProvider(
  gardenContext: PilotGardenContext,
  sortieIndex: number,
  descriptor: TrainingRunDescriptor,
): AgentMessageProvider {
  return (context) => {
    if (context.agentId !== gardenContext.pilotId || context.turn !== 1) return [];
    return [
      {
        id: `pilot-garden-briefing-${gardenContext.pilotId}-s${sortieIndex}`,
        from: "Pilot Garden",
        to: gardenContext.pilotId,
        channel: "coach",
        priority: "priority",
        content: renderGardenBriefing(gardenContext, sortieIndex, descriptor),
      },
    ];
  };
}

function renderGardenBriefing(
  gardenContext: PilotGardenContext,
  sortieIndex: number,
  descriptor: TrainingRunDescriptor,
): string {
  const lines = [
    `Pilot Garden briefing for sortie ${sortieIndex}.`,
    `Current-state document: ${gardenContext.currentStateDocumentId}.`,
    `Current lesson: ${descriptor.lesson}`,
    descriptor.briefingFocus,
  ];
  if (gardenContext.currentState?.content) {
    lines.push("Carry forward this prior learning, but obey live cockpit evidence and physics first:");
    lines.push(excerpt(gardenContext.currentState.content, 3_500));
  } else {
    lines.push(`No prior current-state document was loaded (${gardenContext.missingReason ?? "not found"}).`);
    lines.push("Treat this sortie as baseline evidence for the next reflection.");
  }
  return lines.join("\n\n");
}

function buildDrillMatchConfig(
  blueAirframe: Airframe,
  drill: NormalizedTrainingDrill,
  pilotId: string,
): MatchConfig {
  if (drill.kind === "positive-aoa-load") return buildPositiveAoaLoadMatchConfig(blueAirframe, drill, pilotId);
  if (drill.kind === "prop-flight-camp") return buildPropFlightCampMatchConfig(blueAirframe, drill, pilotId);
  throw new Error(`unknown training drill kind: ${(drill as { kind: string }).kind}`);
}

function buildPositiveAoaLoadMatchConfig(
  blueAirframe: Airframe,
  drill: NormalizedTrainingDrill,
  pilotId: string,
): MatchConfig {
  const initialAircraft = createPositiveAoaLoadAircraft(blueAirframe, pilotId, drill.stage);
  const scripted = drill.pilotModel.startsWith("scripted-");
  return {
    id: `training-drill|positive-aoa-load|${safeSlug(drill.stage ?? "load-discovery")}|motor:${drill.motorProgramTurnMs}x${drill.motorProgramSampleMs}|${safeSlug(drill.pilotModel)}|turns:${drill.turnCount}`,
    turnDuration: drill.motorProgramTurnMs / 1000,
    frameDt: drill.motorProgramSampleMs / 1000,
    maxTurns: drill.turnCount,
    decisionTimeoutMs: drill.decisionTimeoutMs,
    initialAircraft,
    sensor: NO_CONTACT_SENSOR,
    evaluator: competenceEvaluator,
    fallback: pursuitFallback,
    comms: {
      providers: [positiveAoaLoadCoachProvider(pilotId, drill.stage ?? "load-discovery")],
    },
    agents: {
      [pilotId]: {
        meta: {
          id: pilotId,
          kind: scripted ? "scripted" : "llm",
          label: `${drill.pilotModel}/positive-aoa-load`,
          config: {
            controlMode: "motor-program",
            motorProgramTurnMs: drill.motorProgramTurnMs,
            motorProgramSampleMs: drill.motorProgramSampleMs,
          },
        },
        controller: scripted
          ? scriptedPositiveAoaLoadController()
          : piController({
              slug: drill.pilotModel,
              spec: positiveAoaLoadActionSpec(drill.stage ?? "load-discovery"),
              rules: positiveAoaLoadRules(drill.stage ?? "load-discovery"),
              maxTokens: 4_096,
            }),
      },
    },
  };
}

function buildPropFlightCampMatchConfig(
  blueAirframe: Airframe,
  drill: NormalizedTrainingDrill,
  pilotId: string,
): MatchConfig {
  const scripted = drill.pilotModel.startsWith("scripted-");
  return {
    id: `training-drill|prop-flight-camp|${safeSlug(drill.stage ?? "basic-stability")}|motor:${drill.motorProgramTurnMs}x${drill.motorProgramSampleMs}|${safeSlug(drill.pilotModel)}|turns:${drill.turnCount}`,
    turnDuration: drill.motorProgramTurnMs / 1000,
    frameDt: drill.motorProgramSampleMs / 1000,
    maxTurns: drill.turnCount,
    decisionTimeoutMs: drill.decisionTimeoutMs,
    initialAircraft: createPropFlightCampAircraft(blueAirframe, pilotId, drill.stage),
    sensor: NO_CONTACT_SENSOR,
    evaluator: competenceEvaluator,
    fallback: pursuitFallback,
    comms: {
      providers: [propFlightCampCoachProvider(pilotId, drill.stage ?? "basic-stability")],
    },
    agents: {
      [pilotId]: {
        meta: {
          id: pilotId,
          kind: scripted ? "scripted" : "llm",
          label: `${drill.pilotModel}/prop-flight-camp`,
          config: {
            controlMode: "motor-program",
            stage: drill.stage ?? "basic-stability",
            motorProgramTurnMs: drill.motorProgramTurnMs,
            motorProgramSampleMs: drill.motorProgramSampleMs,
          },
        },
        controller: scripted
          ? scriptedPropFlightCampController()
          : piController({
              slug: drill.pilotModel,
              spec: propFlightCampActionSpec(drill.stage ?? "basic-stability"),
              rules: propFlightCampRules(drill.stage ?? "basic-stability"),
              maxTokens: 3_200,
            }),
      },
    },
  };
}

function normalizeTrainingDrill(
  input: TrainingDrillInput,
  scenario: StudioScenarioConfig,
): NormalizedTrainingDrill {
  if (input.kind !== "positive-aoa-load" && input.kind !== "prop-flight-camp") {
    throw new Error(`unknown training drill kind: ${(input as { kind: string }).kind}`);
  }
  return {
    kind: input.kind,
    pilotModel: input.pilotModel ?? scenario.pilotModel,
    ...(input.stage?.trim() ? { stage: input.stage.trim() } : {}),
    turnCount: clampTurns(input.turnCount ?? scenario.turnCount ?? 6),
    motorProgramTurnMs: clampMs(input.motorProgramTurnMs ?? scenario.motorProgramTurnMs ?? 2_500, 500, 5_000),
    motorProgramSampleMs: clampMs(input.motorProgramSampleMs ?? scenario.motorProgramSampleMs ?? 50, 25, 250),
    decisionTimeoutMs: clampMs(input.decisionTimeoutMs ?? 60_000, 5_000, 180_000),
  };
}

function createPositiveAoaLoadAircraft(blueAirframe: Airframe, pilotId: string, stage?: string) {
  const blue = structuredClone(createBvrInterceptAircraft(blueAirframe)[0]!);
  const velocity =
    stage === "very-low-speed-pitch" || stage === "pitch-ramp-map" || stage === "pitch-ramp-throttle-step"
      ? vec3(280, 0, 0)
      : stage === "low-speed-pitch"
      ? vec3(320, 0, 0)
      : blue.velocity;
  return [
    {
      ...blue,
      id: pilotId,
      callsign: "AoA Drill 1",
      velocity,
      orientation: quatLookRotation(velocity),
      weaponCooldown: 0,
      weaponAmmo: {},
      controls: { ...blue.controls, throttle: 0.96, trigger: false },
      metrics: { ...blue.metrics, airspeed: length(velocity), aoaDeg: 0, gLoad: 1, stalled: false },
      model: {
        ...blue.model,
        weaponStations: [],
      },
    },
  ];
}

function createPropFlightCampAircraft(blueAirframe: Airframe, pilotId: string, stage?: string) {
  const compiled = compileAirframe(blueAirframe);
  const slowStage =
    stage === "slow-flight-pitch" ||
    stage === "slow-bank-hold" ||
    stage === "slow-bank-template" ||
    stage === "wings-level-recovery-template";
  const velocity = vec3(slowStage ? 35 : 55, 0, 0);
  const altitude = slowStage ? 3_000 : 2_500;
  return [
    {
      id: pilotId,
      callsign: "Prop Camp 1",
      team: "blue" as const,
      color: "#f4c95d",
      position: vec3(0, altitude, 0),
      velocity,
      orientation: quatLookRotation(velocity),
      controls: { pitch: 0, roll: 0, yaw: 0, throttle: 0.56, trigger: false },
      health: 100,
      weaponCooldown: 0,
      model: {
        ...compiled.model,
        weaponStations: [],
      },
      metrics: { airspeed: length(velocity), altitude, aoaDeg: 0, gLoad: 1, stalled: false },
      angularVelocity: vec3(0, 0, 0),
      fuelKg: compiled.model.fuelCapacityKg,
      fuelByTankKg: fullFuelByTank(compiled.model),
      devices: compiled.devices,
      airframe: blueAirframe,
      weaponAmmo: {},
    },
  ];
}

function positiveAoaLoadCoachProvider(agentId: string, stage: string): AgentMessageProvider {
  return (context) => {
    if (context.agentId !== agentId) return [];
    const lines = [
      "Positive AoA/load drill coach.",
      "No target, no radar, no weapons. Success is ownship response: peak AoA >= +2 deg and peak G >= 2.0 without stall or large altitude loss.",
    ];
    if (stage === "pitch-ramp-map" || stage === "pitch-ramp-throttle-step") {
      const scheduledPitch = context.turn <= 1 ? 0.3 : context.turn === 2 ? 0.5 : context.turn === 3 ? 0.7 : context.turn === 4 ? 0.9 : 1.0;
      const scheduledThrottle =
        stage === "pitch-ramp-throttle-step"
          ? context.turn <= 3
            ? 0.1
            : context.turn <= 5
            ? 0.3
            : 0.5
          : 0.1;
      lines.push(
        `Stage ${stage}: this turn's pitch command should be ${scheduledPitch.toFixed(2)} and throttle should be ${scheduledThrottle.toFixed(2)} for the whole tape; roll=0, yaw=0.`,
      );
    }
    const summary = priorTurnOwnshipSummary(context.history?.frames ?? [], agentId, context.turn - 1);
    if (summary) {
      lines.push(
        `Last turn measured: peakAoA=${summary.peakAoA.toFixed(1)} deg, peakG=${summary.peakG.toFixed(1)}, minAlt=${summary.minAlt.toFixed(0)} m, altitudeLoss=${summary.altitudeLoss.toFixed(0)} m, stalled=${summary.stalled ? "yes" : "no"}.`,
      );
      if (summary.peakAoA < 2 || summary.peakG < 2) {
        lines.push("The previous tape was still unloaded. Hold more sustained positive pitch and keep roll/yaw simple.");
      } else {
        lines.push("You produced measurable pull. Keep it controlled and preserve altitude while refining the tape.");
      }
    } else {
      lines.push("First turn: establish the simplest tape that should create measured positive AoA/load.");
    }
    return [
      {
        id: `positive-aoa-load-coach-${agentId}-t${context.turn}`,
        from: "Drill Coach",
        to: agentId,
        channel: "coach",
        priority: "priority",
        content: lines.join("\n"),
        repeat: "each-turn",
      },
    ];
  };
}

function propFlightCampRules(stage: string): string {
  const stageRule =
    stage === "pitch-saturation"
      ? [
          "Stage focus: elevator authority mapping. Controls are bounded: pitch=+1.0 is full nose-up stick and the maximum allowed value; do not propose pitch above +1.0.",
          "For at least the first two turns, hold pitch in the +0.8 to +1.0 range, roll/yaw near zero, and throttle around 0.45-0.60 so the airplane can trade speed for climb.",
          "Only reduce pitch if the aircraft stalls or altitude/airspeed evidence says the full-up test is unsafe.",
        ].join("\n")
      : stage === "slow-flight-pitch"
      ? [
          "Stage focus: slow-flight elevator mapping. You start slower than normal camp because the probe showed low speed is where full-up pitch can produce positive AoA.",
          "For the opening turns, hold pitch near +1.0, roll/yaw near zero, and throttle around 0.25-0.45. Let the airplane show whether it can rotate before speed builds.",
          "If speed rises above 80 m/s while AoA falls negative, keep pitch high and reduce throttle rather than relaxing pitch.",
        ].join("\n")
      : stage === "slow-bank-hold"
      ? [
          "Stage focus: slow-flight bank hold. You start slow and high; make one deliberate signed-roll experiment rather than hunting many controls.",
          "Use a small positive roll command around +0.20 for the first part of the tape, then neutralize roll near 0. Hold pitch around +0.55 to +0.70 and throttle around 0.35-0.45.",
          "Do not change throttle rapidly. Judge whether the roll pulse creates a controllable bank while pitch support prevents the altitude collapse seen in the prior slow-flight sorties.",
        ].join("\n")
      : stage === "slow-bank-template"
      ? [
          "Stage focus: literal held-bank template. The prior sorties failed because the rationale said roll while the samples returned roll to 0.",
          "Every sample must include finite yaw=0. Use pitch=+0.85, roll=+0.20, yaw=0, throttle=0.40, trigger=false for the whole 2500 ms tape.",
          "Do not neutralize roll inside the tape. Do not vary throttle. This sortie tests whether a held roll plus stronger pitch can avoid the previous dive.",
        ].join("\n")
      : stage === "wings-level-recovery-template"
      ? [
          "Stage focus: wings-level recovery. Deterministic probes showed bank was the wrong next variable; roll must stay exactly 0 while the trainer arrests the sink.",
          "Every sample must include finite yaw=0. Use pitch=+1.00, roll=0, yaw=0, throttle=0.55, trigger=false for the whole 2500 ms tape.",
          "Do not add bank or throttle changes. This stage teaches that the prop trainer needs time to accelerate, stop descending, and climb before any turn work.",
        ].join("\n")
      : stage === "generalization-recovery"
      ? [
          "Stage focus: generalization holdout. This is not a literal template. Recover to stable wings-level prop flight from a new entry condition.",
          "Do not add bank until the altitude trend is nonnegative. First stabilize altitude and airspeed, then make only small smooth changes.",
          "Use the cockpit evidence. If speed is rising while altitude falls, stop experimenting with turns and recover wings-level.",
        ].join("\n")
      : stage === "gentle-turns"
      ? "Stage focus: introduce shallow coordinated turns. Use modest roll, preserve altitude with small pitch, and roll back toward level if altitude or speed decays."
      : "Stage focus: basic stability. Stay mostly wings-level and learn the pitch/throttle settings for level flight before adding larger turns.";
  return `${PROP_FLIGHT_CAMP_RULES}\n\n${stageRule}`;
}

function propFlightCampActionSpec(stage: string) {
  const stageRule =
    stage === "pitch-saturation"
      ? "Pitch saturation stage: pitch is clamped to [-1,+1]. Use +0.8..+1.0 for the opening full-up elevator test; do not emit pitch above +1.0."
      : stage === "slow-flight-pitch"
      ? "Slow-flight pitch stage: pitch is clamped to [-1,+1]. Start near pitch=+1.0 with low-to-moderate throttle so AoA can go positive before speed builds."
      : stage === "slow-bank-hold"
      ? "Slow-bank-hold stage: use raw stick units. Try roll=+0.20 briefly, return roll toward 0, hold pitch around +0.55..+0.70, and keep throttle near 0.35..0.45."
      : stage === "slow-bank-template"
      ? [
          "Slow-bank-template stage: output a literal raw-stick motor tape. Use samples at tMs 0, 1250, and 2500.",
          "Each sample must contain pitch=0.85, roll=0.20, yaw=0, throttle=0.40, trigger=false. Do not omit yaw. Do not return roll to 0.",
          "Use heldActions=[] and do not fire.",
        ].join("\n")
      : stage === "wings-level-recovery-template"
      ? [
          "Wings-level-recovery-template stage: output a literal raw-stick motor tape. Use samples at tMs 0, 1250, and 2500.",
          "Each sample must contain pitch=1.00, roll=0, yaw=0, throttle=0.55, trigger=false. Do not omit yaw. Do not add bank.",
          "Use heldActions=[] and do not fire.",
        ].join("\n")
      : stage === "generalization-recovery"
      ? "Generalization-recovery stage: use complete finite motor-program samples with yaw=0, heldActions=[], trigger=false. There is no required template; stabilize wings-level before adding any bank."
      : "Pitch is clamped to [-1,+1]. Use gentle values for normal camp, but increase deliberately if the aircraft keeps unloading.";
  return {
    ...PROP_FLIGHT_CAMP_ACTION_SPEC,
    rules: `${PROP_FLIGHT_CAMP_ACTION_SPEC.rules}\n${stageRule}`,
  };
}

function propFlightCampCoachProvider(agentId: string, stage: string): AgentMessageProvider {
  return (context) => {
    if (context.agentId !== agentId) return [];
    const lines = [
      `Propeller flight camp coach. Stage: ${stage}.`,
      "No target, no radar, no weapons. Success is stable ownship control: altitude near 2500 m, speed about 45-80 m/s, unstalled, smooth inputs.",
    ];
    if (stage === "slow-bank-template") {
      lines.push("Required tape this turn: pitch=0.85, roll=0.20 held through the final sample, yaw=0, throttle=0.40, trigger=false.");
    }
    if (stage === "wings-level-recovery-template") {
      lines.push("Required tape this turn: pitch=1.00, roll=0, yaw=0, throttle=0.55, trigger=false. Let the airplane arrest sink before adding bank.");
    }
    if (stage === "generalization-recovery") {
      lines.push("Holdout instruction: stabilize wings-level first. Do not add bank while altitude is falling or speed is running away.");
    }
    const summary = priorTurnOwnshipSummary(context.history?.frames ?? [], agentId, context.turn - 1);
    if (summary) {
      lines.push(
        `Last turn measured: peakAoA=${summary.peakAoA.toFixed(1)} deg, peakG=${summary.peakG.toFixed(1)}, minAlt=${summary.minAlt.toFixed(0)} m, altitudeLoss=${summary.altitudeLoss.toFixed(0)} m, stalled=${summary.stalled ? "yes" : "no"}.`,
      );
      if (summary.stalled) {
        lines.push("Recover: unload gently, add power, and stop increasing bank until airspeed returns.");
      } else if (summary.altitudeLoss > 120) {
        lines.push("Altitude loss was high. Reduce bank, add throttle, and use a smaller positive pitch correction.");
      } else if (summary.peakG > 2.2) {
        lines.push("The control was too abrupt for prop camp. Smooth the tape and use smaller pitch/roll.");
      } else {
        lines.push("The last turn stayed in a usable training envelope. Make one small, deliberate change.");
      }
    } else {
      lines.push("First turn: find a smooth level-flight tape before trying a turn.");
    }
    return [
      {
        id: `prop-flight-camp-coach-${agentId}-t${context.turn}`,
        from: "Flight Camp Coach",
        to: agentId,
        channel: "coach",
        priority: "priority",
        content: lines.join("\n"),
        repeat: "each-turn",
      },
    ];
  };
}

function priorTurnOwnshipSummary(
  frames: Readonly<MatchReplay["frames"]>,
  agentId: string,
  turn: number,
): { peakAoA: number; peakG: number; minAlt: number; altitudeLoss: number; stalled: boolean } | undefined {
  if (turn < 1) return undefined;
  const snaps = frames
    .filter((frame) => frame.turn === turn)
    .map((frame) => frame.aircraft.find((aircraft) => aircraft.id === agentId))
    .filter((aircraft): aircraft is NonNullable<typeof aircraft> => Boolean(aircraft));
  if (snaps.length === 0) return undefined;
  const startAlt = snaps[0].altitude;
  const minAlt = Math.min(...snaps.map((snap) => snap.altitude));
  return {
    peakAoA: Math.max(...snaps.map((snap) => snap.aoaDeg)),
    peakG: Math.max(...snaps.map((snap) => snap.gLoad)),
    minAlt,
    altitudeLoss: startAlt - minAlt,
    stalled: snaps.some((snap) => snap.stalled),
  };
}

function scriptedPositiveAoaLoadController(): Controller {
  return async (observation) => {
    const pitch = observation.self.gLoad < 1.8 || observation.self.aoaDeg < 2 ? 0.42 : 0.32;
    return {
      action: positiveAoaLoadAction(pitch),
      rationale: `hold simple positive pitch for measured AoA/load; saw g=${observation.self.gLoad.toFixed(1)} aoa=${observation.self.aoaDeg.toFixed(1)}`,
    };
  };
}

function positiveAoaLoadAction(pitch: number): MotorProgramAction {
  const durationMs = 2_500;
  const sampleDtMs = 50;
  return {
    kind: "motor-program",
    durationMs,
    sampleDtMs,
    samples: [
      { tMs: 0, pitch: Math.min(pitch * 0.55, 1), roll: 0, yaw: 0, throttle: 0.96, trigger: false },
      { tMs: 600, pitch, roll: 0.04, yaw: 0, throttle: 0.98, trigger: false },
      { tMs: durationMs, pitch, roll: 0.04, yaw: 0, throttle: 0.98, trigger: false },
    ],
    heldActions: [],
  };
}

function scriptedPropFlightCampController(): Controller {
  return async (observation) => {
    const altitudeError = 2_500 - observation.self.altitude;
    const speedError = 58 - observation.self.airspeed;
    const pitch = Math.max(-0.18, Math.min(0.22, altitudeError * 0.002 + speedError * -0.004));
    const throttle = Math.max(0.46, Math.min(0.76, 0.58 + speedError * 0.006));
    return {
      action: propFlightCampAction(pitch, throttle),
      rationale: `hold prop trainer stable; alt=${observation.self.altitude.toFixed(0)} speed=${observation.self.airspeed.toFixed(0)}`,
    };
  };
}

function propFlightCampAction(pitch: number, throttle: number): MotorProgramAction {
  const durationMs = 2_500;
  const sampleDtMs = 50;
  return {
    kind: "motor-program",
    durationMs,
    sampleDtMs,
    samples: [
      { tMs: 0, pitch: pitch * 0.5, roll: 0, yaw: 0, throttle, trigger: false },
      { tMs: 700, pitch, roll: 0.06, yaw: 0, throttle, trigger: false },
      { tMs: durationMs, pitch, roll: 0.06, yaw: 0, throttle, trigger: false },
    ],
    heldActions: [],
  };
}

async function defaultRunSortie(input: TrainingChamberSortieInput): Promise<MatchReplay> {
  return runMatch(input.config);
}

async function readPilotGardenContext(
  connection: GardenMcpConnection,
  pilotId: string,
  documentId: string,
): Promise<PilotGardenContext> {
  try {
    const response = await callGardenTool<GardenDocumentRead | string>(connection, "read_document", {
      graphId: connection.graphId,
      documentId,
      format: "markdown",
    });
    const content = extractGardenDocumentContent(response);
    if (!content) {
      return { pilotId, currentStateDocumentId: documentId, missingReason: "empty document response" };
    }
    return { pilotId, currentStateDocumentId: documentId, currentState: { content } };
  } catch (error) {
    return {
      pilotId,
      currentStateDocumentId: documentId,
      missingReason: error instanceof Error ? error.message : String(error),
    };
  }
}

async function writeReflectionDocument(
  connection: GardenMcpConnection,
  input: {
    sortieIndex: number;
    pilotId: string;
    replay: MatchReplay;
    reflection: ScenarioDebriefResponse;
    gardenContext: PilotGardenContext;
  },
): Promise<GardenJournalWritten> {
  const documentId = reflectionDocumentId(input.pilotId, input.sortieIndex, input.replay.id);
  const content = renderReflectionDocument(input);
  return writeMarkdownDocument(connection, documentId, content, `Pilot reflection ${input.sortieIndex}`);
}

async function writeCurrentStateDocument(
  connection: GardenMcpConnection,
  input: {
    sortieIndex: number;
    pilotId: string;
    descriptor: TrainingRunDescriptor;
    replay: MatchReplay;
    reflection: ScenarioDebriefResponse;
    currentStateDocumentId: string;
    previousContext: PilotGardenContext;
  },
): Promise<GardenJournalWritten> {
  const content = renderCurrentStateDocument(input);
  return writeMarkdownDocument(connection, input.currentStateDocumentId, content, "Pilot current state");
}

async function writeMarkdownDocument(
  connection: GardenMcpConnection,
  documentId: string,
  content: string,
  title: string,
): Promise<GardenJournalWritten> {
  const result = await callGardenTool<GardenWriteResult>(connection, "write_document", {
    graphId: connection.graphId,
    documentId,
    content,
    format: "markdown",
    awaitDurable: true,
    comments: {},
  });
  return {
    enabled: true,
    status: "written",
    graphId: connection.graphId,
    documentId,
    title,
    source: connection.source,
    mcpUrl: connection.mcpUrl,
    ...(Array.isArray(result.blockIds) ? { blockIds: result.blockIds } : {}),
  };
}

function renderReflectionDocument(input: {
  sortieIndex: number;
  pilotId: string;
  replay: MatchReplay;
  reflection: ScenarioDebriefResponse;
  gardenContext: PilotGardenContext;
}): string {
  const grounding = buildDebriefGrounding(input.replay, { pilotId: input.pilotId });
  return [
    `# Pilot Reflection ${input.sortieIndex}`,
    "",
    `- Pilot: \`${input.pilotId}\``,
    `- Replay: \`${input.replay.id}\``,
    `- Prior state loaded: ${input.gardenContext.currentState ? "yes" : "no"}`,
    `- Reflection model: \`${input.reflection.model}\`${input.reflection.scripted ? " (scripted)" : ""}`,
    "",
    "## Pilot Reflection",
    "",
    input.reflection.reply,
    "",
    "## Evidence Used",
    "",
    debriefEvidenceBlock(grounding),
  ].join("\n");
}

function renderCurrentStateDocument(input: {
  sortieIndex: number;
  pilotId: string;
  descriptor: TrainingRunDescriptor;
  replay: MatchReplay;
  reflection: ScenarioDebriefResponse;
  currentStateDocumentId: string;
  previousContext: PilotGardenContext;
}): string {
  const grounding = buildDebriefGrounding(input.replay, { pilotId: input.pilotId });
  const outcome = input.reflection.grounding.outcome;
  const lines: string[] = [];
  lines.push(`# Flight Pilot Current State - ${input.pilotId}`);
  lines.push("");
  lines.push("## Current Lesson");
  lines.push("");
  lines.push(input.descriptor.lesson);
  lines.push("");
  lines.push(input.descriptor.briefingFocus);
  lines.push("");
  lines.push("## Latest Sortie");
  lines.push("");
  lines.push(`- Sortie index: ${input.sortieIndex}`);
  lines.push(`- Replay: \`${input.replay.id}\``);
  lines.push(`- Scenario: \`${input.descriptor.kind}\``);
  lines.push(`- Control mode: \`${input.descriptor.controlMode}\``);
  lines.push(`- Turns with truth: ${grounding.turnTruth.length}`);
  if (grounding.peakG) lines.push(`- Peak G: ${grounding.peakG.value.toFixed(1)} on turn ${grounding.peakG.turn}`);
  if (grounding.minAlt) lines.push(`- Minimum altitude: ${grounding.minAlt.value.toFixed(0)} m on turn ${grounding.minAlt.turn}`);
  if (grounding.overshootTurn !== undefined) lines.push(`- Overshoot turn: ${grounding.overshootTurn}`);
  if (outcome) {
    lines.push(`- Outcome: ${outcome.resolved ? "resolved" : "unresolved"} / ${outcome.reason}`);
  }
  lines.push("");
  lines.push("## Latest Pilot Reflection");
  lines.push("");
  lines.push(input.reflection.reply);
  lines.push("");
  lines.push("## Next Briefing Delta");
  lines.push("");
  lines.push(nextBriefingDelta(input.reflection.reply, grounding, input.descriptor));
  lines.push("");
  lines.push("## Previous State Excerpt");
  lines.push("");
  lines.push(input.previousContext.currentState?.content ? excerpt(input.previousContext.currentState.content, 1_500) : "(none)");
  lines.push("");
  lines.push("## Structured Evidence");
  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify(input.reflection.grounding, null, 2));
  lines.push("```");
  return lines.join("\n");
}

function reflectionPrompt(
  gardenContext: PilotGardenContext,
  sortieIndex: number,
  descriptor: TrainingRunDescriptor,
): string {
  const prior = gardenContext.currentState?.content
    ? `Your prior Garden current-state note before this sortie was:\n${excerpt(gardenContext.currentState.content, 2_000)}`
    : "You had no prior Garden current-state note before this sortie.";
  return [
    `Debrief sortie ${sortieIndex}.`,
    `Training lesson: ${descriptor.lesson}`,
    descriptor.reflectionFocus,
    prior,
    "Write the next journal entry in first person. Be specific about intent versus measured aircraft response.",
    "End with one concrete change you want carried into the next sortie briefing.",
  ].join("\n\n");
}

function nextBriefingDelta(
  reply: string,
  grounding: ReturnType<typeof buildDebriefGrounding>,
  descriptor: TrainingRunDescriptor,
): string {
  const lines = ["Use the latest reflection as hypothesis, but grade it against replay evidence."];
  if (descriptor.kind === "positive-aoa-load") {
    lines.push("For the next drill sortie, ignore heading/contact/weapons. Grade the first tape by measured positive AoA and load.");
    lines.push("Target: peak AoA >= +2 deg and peak G >= 2.0 without stall or large altitude loss.");
  }
  if (descriptor.kind === "prop-flight-camp") {
    lines.push("For the next prop camp sortie, ignore contact/weapons. Grade the tape by stable altitude, airspeed, AoA, G, and stall state.");
    lines.push("Target: altitude within about 150 m, speed roughly 45-80 m/s, unstalled, and smooth low-G controls.");
  }
  if (grounding.peakG) lines.push(`Remember measured peak G was ${grounding.peakG.value.toFixed(1)}.`);
  if (grounding.minAlt) lines.push(`Preserve altitude margin; last minimum was ${grounding.minAlt.value.toFixed(0)} m.`);
  if (grounding.overshootTurn !== undefined) lines.push(`Avoid repeating the overshoot from turn ${grounding.overshootTurn}.`);
  lines.push(`Pilot's proposed carry-forward note: ${excerpt(reply, 900)}`);
  return lines.join("\n");
}

function scenarioDescriptor(scenario: StudioScenarioConfig): TrainingRunDescriptor {
  return {
    kind: scenario.kind,
    label: scenario.kind,
    controlMode: scenario.controlMode,
    lesson: currentLessonForScenario(scenario.kind),
    briefingFocus: "Use replay-grounded Garden memory to revise the next control plan without ignoring live observation.",
    reflectionFocus: "Judge success against the scenario objective and the recorded aircraft response.",
    ...(inferScenarioTarget(scenario.kind) ? { targetId: inferScenarioTarget(scenario.kind) } : {}),
  };
}

function drillDescriptor(drill: NormalizedTrainingDrill): TrainingRunDescriptor {
  if (drill.kind === "positive-aoa-load") {
    return {
      kind: "positive-aoa-load",
      label: "positive AoA/load drill",
      controlMode: "motor-program",
      lesson: `Positive AoA/load drill (${drill.stage ?? "load-discovery"}): make direct motor tapes produce measured ownship AoA and load before reintroducing heading, target, radar, or weapons.`,
      briefingFocus:
        drill.stage === "pitch-ramp-throttle-step"
          ? "There is no target. Repeat the pitch ramp while stepping throttle at the shelf: throttle=0.10 for turns 1-3, 0.30 for turns 4-5, then 0.50; keep roll/yaw neutral."
          : drill.stage === "pitch-ramp-map"
          ? "There is no target. The start speed is 280 m/s; follow the pitch schedule 0.30, 0.50, 0.70, 0.90, then 1.00 while keeping throttle=0.10 and roll/yaw neutral."
          : drill.stage === "very-low-speed-pitch"
          ? "There is no target. The start speed is 280 m/s so full pitch=+1.0 can test whether lower entry speed breaks through the AoA shelf; keep throttle low and roll/yaw neutral."
          : drill.stage === "low-speed-pitch"
          ? "There is no target. The start speed is reduced so full pitch=+1.0 can produce measurable AoA; hold low throttle and map the lower-speed response."
          : drill.stage === "pitch-saturation"
          ? "There is no target. Hold full nose-up pitch=+1.0 long enough to map elevator authority; controls are clamped and values above +1.0 are impossible."
          : "There is no target. Treat the aircraft as the teacher: peak AoA, peak G, stall state, and altitude loss are the only success signals.",
      reflectionFocus:
        "Do not discuss missing contact as failure. Explain whether the tape actually produced positive AoA/load, and name the next tape change.",
    };
  }
  if (drill.kind === "prop-flight-camp") {
    return {
      kind: "prop-flight-camp",
      label: "propeller flight camp",
      controlMode: "motor-program",
      lesson: `Propeller flight camp (${drill.stage ?? "basic-stability"}): learn smooth prop-plane control before combat or navigation tasks.`,
      briefingFocus:
        drill.stage === "wings-level-recovery-template"
          ? "There is no target. Execute the literal recovery template: every sample has pitch=1.00, roll=0, yaw=0, throttle=0.55, trigger=false, and wait for the aircraft to arrest sink before turn work."
          : drill.stage === "generalization-recovery"
          ? "There is no target. This is a holdout recovery task, not a literal template: recover stable wings-level prop flight from the 55 m/s entry, and do not add bank until altitude trend is nonnegative."
          : drill.stage === "slow-bank-template"
          ? "There is no target. Execute the literal held-bank template: every sample has pitch=0.85, roll=0.20, yaw=0, throttle=0.40, trigger=false, with no roll neutralization."
          : drill.stage === "slow-bank-hold"
          ? "There is no target. Use one small positive roll pulse, neutralize it, and hold pitch/throttle steady enough to see whether bank can be introduced without another altitude collapse."
          : drill.stage === "slow-flight-pitch"
          ? "There is no target. The start speed is reduced so full-up pitch can produce positive AoA before the aircraft accelerates; map slow-flight elevator authority."
          : "There is no target. Treat altitude, airspeed, AoA, G, and stall state as the teacher. Make one small control experiment per turn.",
      reflectionFocus:
        "Do not discuss missing contact as failure. Explain whether the tape preserved stable prop flight, and name the next control experiment.",
    };
  }
  throw new Error(`unknown training drill kind: ${(drill as { kind: string }).kind}`);
}

function currentLessonForScenario(kind: ReturnType<typeof StudioScenarioConfigSchema.parse>["kind"]): string {
  if (kind === "bvr-intercept") {
    return "BVR GPS intercept: convert offboard tasking into measured heading convergence, then acquire radar contact before FOX-3.";
  }
  if (kind === "balloon" || kind === "balloon-hard") {
    return "Sensorimotor flying: stabilize bank, pull with measured G, and keep the target in the forward firing geometry.";
  }
  return "Air combat handling: compare intended maneuver against measured aircraft response and revise the next tape.";
}

function inferScenarioTarget(kind: ReturnType<typeof StudioScenarioConfigSchema.parse>["kind"]): string | undefined {
  if (kind === "bvr-intercept") return "prop-1";
  if (kind === "balloon" || kind === "balloon-hard") return "balloon";
  return undefined;
}

function reflectionDocumentId(pilotId: string, sortieIndex: number, replayId: string): string {
  const hash = createHash("sha1").update(`${pilotId}\n${sortieIndex}\n${replayId}`).digest("hex").slice(0, 10);
  return `flight-reflection-${slug(pilotId)}-${String(sortieIndex).padStart(3, "0")}-${hash}`;
}

function newChamberRunId(): string {
  return `run-${new Date().toISOString().replace(/[^0-9TZ]/g, "").toLowerCase()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

async function requireGardenConnection(
  env: Record<string, string | undefined> | undefined,
): Promise<GardenMcpConnection> {
  const resolution = await resolveGardenConnection(env);
  if (!resolution.enabled) throw new Error(`Garden connection required for training chamber: ${resolution.reason}`);
  return resolution.connection;
}

function extractGardenDocumentContent(response: GardenDocumentRead | string): string | undefined {
  if (typeof response === "string") return response;
  return response.markdown ?? response.content ?? response.text ?? response.document?.markdown ?? response.document?.content ?? response.document?.text;
}

function excerpt(content: string, maxChars: number): string {
  const trimmed = content.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars).trimEnd()}\n...`;
}

function clampSorties(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.min(100, Math.round(value)));
}

function clampTurns(value: number): number {
  if (!Number.isFinite(value)) return 6;
  return Math.max(1, Math.min(80, Math.round(value)));
}

function clampMs(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function slug(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 58);
  return cleaned || "pilot";
}

function safeSlug(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return cleaned || "pilot";
}
