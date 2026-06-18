import { mkdir, writeFile } from "node:fs/promises";
import { complete, getModels, type TextContent, type ToolCall } from "@earendil-works/pi-ai";
import { motorProgramSpec, type ActionSpec } from "../agent/actionSpec";
import type { Controller } from "../agent/controller";
import { buildPilotSystemPrompt } from "../agent/prompt";
import { perfectSensor, radarSensorModel, type SensorModel } from "../agent/observation";
import { pursuitFallback } from "../agent/controllers/scripted";
import { competenceEvaluator } from "../eval/outcome";
import type { AgentMessageProvider } from "../runtime/comms";
import type { MatchConfig } from "../runtime/config";
import { createMatchRoundStepper } from "../runtime/match";
import { waypointForAircraft, formatGps } from "../runtime/navigation";
import { createPhysicsCoachProvider } from "../runtime/physicsCoach";
import { bvrLevelPropController, createBvrInterceptAircraft, gentlePropController } from "../runtime/scenario";
import { aircraftArchetypes } from "../sim/aircraftCatalog";
import { length, sub } from "../sim/math";
import { selectRadarDevice } from "../sim/mountedSensor";
import type { AircraftState } from "../sim/types";
import type { Action, MatchReplay, MotorProgramAction, MotorProgramSample, Observation } from "../protocol/schema";

interface SortieSummary {
  index: number;
  model: string;
  replayId: string;
  replayPath: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  decisions: number;
  fallbacks: number;
  metrics: BvrMetrics;
}

interface BvrMetrics {
  initialRangeM: number;
  finalRangeM: number;
  minRangeM: number;
  finalAltitudeM: number;
  minAltitudeM: number;
  maxSpeedMps: number;
  maxG: number;
  maxAoADeg: number;
  finalHealth: number;
  firstRadarLockTurn?: number;
  firstRadarLockRangeM?: number;
  first25KmRadarLockTurn?: number;
  first25KmRadarLockRangeM?: number;
  firstShotTimeS?: number;
  hitCount: number;
}

const RUN_ID = process.env.BVR_DOCTRINE_RUN_ID ?? `bvr-doctrine-${Date.now().toString(36)}`;
const MODEL = process.env.BVR_DOCTRINE_MODEL ?? "deepseek-v4-pro";
const SORTIES = numberEnv("BVR_DOCTRINE_SORTIES", 1);
const TURNS = numberEnv("BVR_DOCTRINE_TURNS", 10);
const MAX_TOKENS = numberEnv("BVR_DOCTRINE_MAX_TOKENS", 1_800);
const BUDGET_USD = numberEnv("BVR_DOCTRINE_BUDGET_USD", 5);
const STARTING_SPEND_USD = numberEnv("BVR_DOCTRINE_STARTING_SPEND_USD", 0);
const DECISION_TIMEOUT_MS = numberEnv("BVR_DOCTRINE_DECISION_TIMEOUT_MS", 90_000);
const TARGET_MODE = process.env.BVR_DOCTRINE_TARGET_MODE ?? "level";
const TURN_DURATION_S = numberEnv("BVR_DOCTRINE_TURN_DURATION_S", 2.5);
const PROGRAM_MS = Math.round(TURN_DURATION_S * 1_000);
const MID_PROGRAM_MS = Math.round(PROGRAM_MS / 2);
const SAMPLE_DT_MS = 50;

const BVR_DOCTRINE_RULES = `You are flying the Super Tomcat in a BVR intercept using raw motor-program tapes.

Mission: from the GCI datum, fly a clean intercept toward the slow prop target, acquire radar, and eventually arm FOX-3 only on a real radar_lock. The immediate research target is not a gun kill; it is a good Tomcat trace.

Hard lessons from prior deterministic research:
- Initial geometry: target starts about 89 km away and about 70 deg right of the nose. Radar sees nothing until your nose is inside the ~20 deg radar cone.
- Raw motor tape discipline: roll input is not bank-hold. Use a short roll impulse, then neutralize. Sustained roll keeps rolling and can spiral the aircraft.
- Q-limit discipline: 420 m/s is safe at 6000 m, but descending toward 3000 m at that speed starts over-q damage. Do not dive from 6000 m while fast.
- Good intercept shape: solve lateral geometry before vertical geometry. Stay high, shallow right intercept, preserve altitude above 5500 m early, keep speed roughly 300-420 m/s, and reduce bank as heading/bearing converges.
- Tactics: do not push the nose down to "get radar." The target starts far to the right, not hidden below the nose. Hold or gently climb while turning toward GCI; target altitude is not your intercept altitude.
- Energy: use low-to-moderate throttle while fast. Do not use burner/full throttle in the initial descending turn. Add power only if speed falls below about 300 m/s.
- Pitch/load: a banked turn needs positive pitch/load to bend the velocity vector, but huge pitch spikes G and dumps energy. Prefer smooth pitch about +0.10..+0.35 unless recovering.
- Radar terminal: once radar contact appears, center bearingRight near 0 while keeping bearingForward high. If contact.radarLock=true and range <= 25000 m, include weapons_free condition='radar_lock' rangeM=25000. Before that, do not include any weapons_free guard. This research sortie is not a gun kill. Keep sample trigger=false.
- Abort criteria: below 5500 m before radar contact, stop tightening the turn and recover altitude. Below 3000 m early, roll level, pitch up smoothly, reduce over-q, and climb before continuing.
- Token discipline: use exactly three samples at tMs 0, ${MID_PROGRAM_MS}, and ${PROGRAM_MS}; at most two heldActions; reason <= 12 words.

Output only a flyable ${PROGRAM_MS} ms motor program. Use sparse knots at 0, ${MID_PROGRAM_MS}, ${PROGRAM_MS} ms; the runtime resamples them.`;

async function main(): Promise<void> {
  const tomcat = aircraftArchetypes.find((candidate) => candidate.id === "variable-sweep-tomcat");
  if (!tomcat) throw new Error("missing variable-sweep-tomcat archetype");
  resolveModel(MODEL);

  const outDir = `reports/coach/bvr-doctrine-${RUN_ID}`;
  await mkdir(outDir, { recursive: true });
  const summaries: SortieSummary[] = [];
  let spend = STARTING_SPEND_USD;

  for (let index = 1; index <= SORTIES; index += 1) {
    if (spend >= BUDGET_USD) break;
    console.error(`bvr doctrine sortie ${index}/${SORTIES}: model=${MODEL} spend=$${spend.toFixed(4)} cap=$${BUDGET_USD.toFixed(2)}`);
    const replay = await runSortie(tomcat.airframe, index);
    const summary = summarizeSortie(replay, index, MODEL, outDir);
    spend += summary.costUsd;
    summaries.push(summary);
    await writeFile(summary.replayPath, `${JSON.stringify(replay, null, 2)}\n`);
    if (summary.costUsd <= 0 || !Number.isFinite(summary.costUsd)) {
      await writeReport(outDir, summaries, spend, "stopped-missing-cost");
      throw new Error(`sortie ${index} had no recorded provider cost; stopping to protect budget`);
    }
    await writeReport(outDir, summaries, spend, "checkpoint");
    if (spend >= BUDGET_USD * 0.9) break;
  }

  const reportPath = await writeReport(outDir, summaries, spend, "final");
  console.log(JSON.stringify({ reportPath, runId: RUN_ID, model: MODEL, spendUsd: spend, sorties: summaries }, null, 2));
}

async function runSortie(airframe: NonNullable<(typeof aircraftArchetypes)[number]["airframe"]>, sortieIndex: number): Promise<MatchReplay> {
  const initialAircraft = createBvrInterceptAircraft(airframe);
  if (TARGET_MODE === "static") {
    const target = initialAircraft.find((ship) => ship.id === "prop-1");
    if (target) {
      target.static = true;
      target.velocity = { x: 0, y: 0, z: 0 };
      target.metrics = { ...target.metrics, airspeed: 0 };
    }
  }
  const blue = initialAircraft.find((ship) => ship.id === "blue-1");
  if (!blue) throw new Error("missing blue-1");
  const radar = selectRadarDevice(blue.devices);
  const radarSensor: SensorModel = radar ? radarSensorModel(radar) : { detect: () => [] };
  const config: MatchConfig = {
    id: `tomcat-bvr-doctrine|${RUN_ID}|${safeSlug(MODEL)}|s${sortieIndex}`,
    turnDuration: TURN_DURATION_S,
    frameDt: 0.05,
    maxTurns: TURNS,
    decisionTimeoutMs: DECISION_TIMEOUT_MS,
    initialAircraft,
    sensor: { detect: () => [] },
    evaluator: competenceEvaluator,
    fallback: safeFallback,
    comms: {
      providers: [
        bvrGciProvider(),
        createPhysicsCoachProvider({ agentId: "blue-1", targetId: "prop-1" }),
      ],
    },
    agents: {
      "blue-1": {
        meta: {
          id: "blue-1",
          kind: "llm",
          label: `${MODEL}/bvr-doctrine-motor-program`,
          config: { controlMode: "motor-program", targetMode: TARGET_MODE, turnDurationS: TURN_DURATION_S },
        },
        controller: doctrineController(MODEL),
        sensor: radarSensor,
      },
      "prop-1": {
        meta: { id: "prop-1", kind: "scripted", label: targetLabel() },
        controller: TARGET_MODE === "static"
          ? async () => ({
            action: { kind: "raw-stick", pitch: 0, roll: 0, yaw: 0, throttle: 0, trigger: false },
            rationale: "static target",
          })
          : TARGET_MODE === "stock"
            ? gentlePropController
            : bvrLevelPropController,
      },
    },
  };
  const stepper = createMatchRoundStepper(config);
  while (!stepper.complete) {
    await stepper.nextRound();
    const replay = stepper.replay();
    if (replay.decisions?.some((decision) =>
      decision.agentId === "blue-1" &&
      decision.observation.contacts.some((contact) => contact.radarLock === true && contact.range <= 25_000)
    )) {
      break;
    }
  }
  return stepper.replay();
}

function targetLabel(): string {
  if (TARGET_MODE === "static") return "Day Tripper (static)";
  if (TARGET_MODE === "stock") return "Day Tripper (stock sightseeing)";
  return "Day Tripper (level BVR target)";
}

function doctrineController(modelSlug: string): Controller {
  const model = resolveModel(modelSlug);
  const spec = bvrDoctrineMotorProgramSpec();
  const systemPrompt = buildPilotSystemPrompt({ roleRules: BVR_DOCTRINE_RULES, actionSpec: spec });

  return async (observation, context) => {
    const response = await complete(
      model,
      {
        systemPrompt,
        messages: [{ role: "user", content: JSON.stringify(observation), timestamp: Date.now() }],
        tools: [{ name: spec.name, description: spec.description, parameters: spec.toolSchema }],
      },
      { maxTokens: MAX_TOKENS, signal: context.signal, maxRetries: 1 },
    );
    if (response.stopReason === "error" || response.content.length === 0) {
      throw new Error(response.errorMessage ?? `model returned ${response.stopReason}`);
    }
    const toolCall = response.content.find((block): block is ToolCall => block.type === "toolCall");
    const args = toolCall
      ? toolCall.arguments
      : extractJsonObject(response.content.filter((block): block is TextContent => block.type === "text").map((block) => block.text).join("\n"));
    const action = filterBvrAction(spec.toAction(args), observation);
    return {
      action,
      rationale: typeof args.reason === "string" ? args.reason : undefined,
      usage: {
        inputTokens: response.usage.input,
        outputTokens: response.usage.output,
        costUsd: response.usage.cost.total,
      },
      raw: { model: response.model, stopReason: response.stopReason },
    };
  };
}

function bvrDoctrineMotorProgramSpec(): ActionSpec {
  return {
    ...motorProgramSpec,
    rules: [
      `ACTION (set_motor_program): call the tool with a flyable ${PROGRAM_MS} ms raw control tape.`,
      `Use durationMs=${PROGRAM_MS}, sampleDtMs=${SAMPLE_DT_MS}, and exactly three sparse samples at tMs 0, ${MID_PROGRAM_MS}, ${PROGRAM_MS}; the runtime resamples them.`,
      "Controls are raw actuator desires, not autopilot commands. Roll input keeps rolling until neutralized; use a short roll impulse, then roll near 0. Avoid sign flips unless passing through neutral.",
      "Keep trigger=false. Before radar terminal range, heldActions should contain only abort_if/recover_if guards.",
      "Only include weapons_free if observation.contacts contains contact.radarLock=true and contact.range <= 25000. Then use condition='radar_lock', coneDeg=30, rangeM=25000.",
      "Use at most two heldActions and keep reason <= 12 words.",
    ].join("\n"),
    toAction: (args) => {
      const action = motorProgramSpec.toAction({ ...args, durationMs: PROGRAM_MS, sampleDtMs: SAMPLE_DT_MS });
      if (action.kind !== "motor-program") return action;
      return {
        ...action,
        heldActions: action.heldActions.filter((held) =>
          held.kind !== "weapons_free" ||
          (held.condition === "radar_lock" && (held.rangeM ?? 0) <= 25_000)
        ),
      };
    },
  };
}

function filterBvrAction(action: Action, observation: Observation): Action {
  if (action.kind !== "motor-program") return action;
  const hasTerminalRadarLock = observation.contacts.some((contact) =>
    contact.radarLock === true && contact.range <= 25_000
  );
  return {
    ...action,
    heldActions: action.heldActions.filter((held) =>
      held.kind !== "weapons_free" ||
      (hasTerminalRadarLock && held.condition === "radar_lock" && (held.rangeM ?? 0) <= 25_000)
    ),
  };
}

function bvrGciProvider(): AgentMessageProvider {
  return (context) => {
    if (context.agentId !== "blue-1") return [];
    const target = context.world.find((ship) => ship.id === "prop-1");
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
          `GCI: target datum ${formatGps(waypoint.gps)}, alt ${Math.round((waypoint.altitudeM ?? 0) / 100) * 100} m. ` +
          `Steer ${Math.round(waypoint.bearingDeg ?? 0).toString().padStart(3, "0")} ${waypoint.compass ?? ""}, ` +
          `${Math.round((waypoint.rangeM ?? 0) / 1000)} km. Preserve altitude and avoid over-q descent.`,
        repeat: "each-turn",
        navigation: { ...context.navigation, waypoints: [waypoint] },
      },
    ];
  };
}

function summarizeSortie(replay: MatchReplay, index: number, model: string, outDir: string): SortieSummary {
  const decisions = replay.decisions?.filter((decision) => decision.agentId === "blue-1") ?? [];
  const costUsd = decisions.reduce((sum, decision) => sum + (decision.usage?.costUsd ?? 0), 0);
  const inputTokens = decisions.reduce((sum, decision) => sum + (decision.usage?.inputTokens ?? 0), 0);
  const outputTokens = decisions.reduce((sum, decision) => sum + (decision.usage?.outputTokens ?? 0), 0);
  return {
    index,
    model,
    replayId: replay.id,
    replayPath: `${outDir}/sortie-${index}-${safeSlug(model)}.json`,
    costUsd,
    inputTokens,
    outputTokens,
    decisions: decisions.length,
    fallbacks: decisions.filter((decision) => decision.source === "fallback").length,
    metrics: summarizeBvr(replay),
  };
}

function summarizeBvr(replay: MatchReplay): BvrMetrics {
  const rows = replay.frames.map((frame) => {
    const blue = frame.aircraft.find((ship) => ship.id === "blue-1");
    const prop = frame.aircraft.find((ship) => ship.id === "prop-1");
    if (!blue || !prop) throw new Error("missing BVR aircraft snapshots");
    return { frame, blue, prop, range: length(sub(prop.position, blue.position)) };
  });
  const decisions = replay.decisions?.filter((decision) => decision.agentId === "blue-1") ?? [];
  const firstRadarLock = decisions.find((decision) =>
    decision.observation.contacts.some((contact) => contact.radarLock === true),
  );
  const first25 = decisions.find((decision) =>
    decision.observation.contacts.some((contact) => contact.radarLock === true && contact.range <= 25_000),
  );
  const firstRadarLockContact = firstRadarLock?.observation.contacts.find((contact) => contact.radarLock === true);
  const first25Contact = first25?.observation.contacts.find((contact) => contact.radarLock === true && contact.range <= 25_000);
  const shotEvents = replay.frames
    .flatMap((frame) => frame.events.map((event) => ({ frame, event })))
    .filter(({ event }) => event.type === "shot");
  const hitCount = replay.frames.flatMap((frame) => frame.events).filter((event) => event.type === "hit").length;
  const final = rows.at(-1);
  if (!final) throw new Error("empty replay");
  return {
    initialRangeM: rows[0].range,
    finalRangeM: final.range,
    minRangeM: Math.min(...rows.map((row) => row.range)),
    finalAltitudeM: final.blue.altitude,
    minAltitudeM: Math.min(...rows.map((row) => row.blue.altitude)),
    maxSpeedMps: Math.max(...rows.map((row) => row.blue.airspeed)),
    maxG: Math.max(...rows.map((row) => row.blue.gLoad)),
    maxAoADeg: Math.max(...rows.map((row) => row.blue.aoaDeg)),
    finalHealth: final.blue.health,
    ...(firstRadarLock && firstRadarLockContact
      ? { firstRadarLockTurn: firstRadarLock.turn, firstRadarLockRangeM: firstRadarLockContact.range }
      : {}),
    ...(first25 && first25Contact
      ? { first25KmRadarLockTurn: first25.turn, first25KmRadarLockRangeM: first25Contact.range }
      : {}),
    ...(shotEvents[0] ? { firstShotTimeS: shotEvents[0].frame.time } : {}),
    hitCount,
  };
}

function safeFallback(observation: Observation): Action {
  const radarContact = observation.contacts.find((contact) => contact.radarLock === true);
  if (radarContact) {
    return radarSafeTape(radarContact.range <= 25_000);
  }
  return observation.contacts.length > 0 ? pursuitFallback(observation) : radarSafeTape(false);
}

function radarSafeTape(armRadar: boolean): MotorProgramAction {
  const samples: MotorProgramSample[] = [
    { tMs: 0, pitch: 0.16, roll: 0, yaw: 0, throttle: 0.08, trigger: false },
    { tMs: MID_PROGRAM_MS, pitch: 0.22, roll: 0, yaw: 0, throttle: 0.08, trigger: false },
    { tMs: PROGRAM_MS, pitch: 0.18, roll: 0, yaw: 0, throttle: 0.08, trigger: false },
  ];
  return {
    kind: "motor-program",
    durationMs: PROGRAM_MS,
    sampleDtMs: SAMPLE_DT_MS,
    samples,
    heldActions: armRadar
      ? [{ kind: "weapons_free", condition: "radar_lock", coneDeg: 30, rangeM: 25_000, note: "fallback radar guard" }]
      : [],
  };
}

async function writeReport(outDir: string, sorties: SortieSummary[], spendUsd: number, status: string): Promise<string> {
  const path = `${outDir}/report.json`;
  const aggregate = {
    sorties: sorties.length,
    spendUsd,
    decisions: sorties.reduce((sum, sortie) => sum + sortie.decisions, 0),
    fallbacks: sorties.reduce((sum, sortie) => sum + sortie.fallbacks, 0),
    radarLocks: sorties.filter((sortie) => sortie.metrics.firstRadarLockTurn !== undefined).length,
    shots: sorties.filter((sortie) => sortie.metrics.firstShotTimeS !== undefined).length,
    minAltitudeM: sorties.length ? Math.min(...sorties.map((sortie) => sortie.metrics.minAltitudeM)) : null,
    maxCostUsd: sorties.length ? Math.max(...sorties.map((sortie) => sortie.costUsd)) : null,
  };
  await writeFile(
    path,
    `${JSON.stringify({ runId: RUN_ID, status, model: MODEL, targetMode: TARGET_MODE, turns: TURNS, turnDurationS: TURN_DURATION_S, programMs: PROGRAM_MS, maxTokens: MAX_TOKENS, budgetUsd: BUDGET_USD, aggregate, sorties }, null, 2)}\n`,
  );
  return path;
}

function resolveModel(slug: string) {
  if (process.env.DEEPSEEK_API_KEY) {
    const direct = getModels("deepseek").find((model) => model.id === slug);
    if (direct) return direct;
  }
  const openrouter = getModels("openrouter").find((model) => model.id === slug);
  if (!openrouter) throw new Error(`model not found in pi-ai registry: ${slug}`);
  return openrouter;
}

function extractJsonObject(text: string): Record<string, unknown> {
  const cleaned = text.replace(/```(?:json)?/gi, "");
  const start = cleaned.indexOf("{");
  if (start === -1) throw new Error("no JSON object in model output");
  let depth = 0;
  for (let index = start; index < cleaned.length; index += 1) {
    if (cleaned[index] === "{") depth += 1;
    if (cleaned[index] === "}") {
      depth -= 1;
      if (depth === 0) return JSON.parse(cleaned.slice(start, index + 1)) as Record<string, unknown>;
    }
  }
  throw new Error("unbalanced JSON object in model output");
}

function safeSlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "model";
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
