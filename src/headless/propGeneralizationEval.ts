import { mkdir, writeFile } from "node:fs/promises";
import { aircraftArchetypes } from "../sim/aircraftCatalog";
import { callGardenTool, resolveGardenConnection, type GardenMcpConnection } from "../garden/client";
import { runTrainingChamber } from "../training/chamber";
import type { MatchReplay } from "../protocol/schema";

interface GardenReadDocument {
  content?: string;
  markdown?: string;
  document?: {
    content?: string;
    markdown?: string;
    text?: string;
  };
  text?: string;
}

interface HoldoutResult {
  label: "no-garden" | "trained-garden";
  seed: number;
  pilotId: string;
  replayId: string;
  sortieDocumentId?: string;
  reflectionDocumentId: string;
  currentStateDocumentId: string;
  metrics: PropMetrics;
}

interface PropMetrics {
  startAltitudeM: number;
  finalAltitudeM: number;
  minAltitudeM: number;
  altitudeLossM: number;
  startSpeedMps: number;
  finalSpeedMps: number;
  maxSpeedMps: number;
  peakG: number;
  peakAoADeg: number;
  minAoADeg: number;
  firstNonDescendingTurn?: number;
  maxAbsRollCommand: number;
  fallbackTurns: number;
  decisionTurns: number;
}

const GRAPH_ID = process.env.FLIGHT_GARDEN_GRAPH_ID ?? "flight-training";
const RUN_ID = process.env.PROP_GENERALIZATION_RUN_ID ?? `prop-generalization-${Date.now().toString(36)}`;
const SEEDS = numberEnv("PROP_GENERALIZATION_SEEDS", 3);
const TURNS = numberEnv("PROP_GENERALIZATION_TURNS", 10);
const MODEL = process.env.PROP_GENERALIZATION_MODEL ?? "deepseek/deepseek-v4-flash";
const SOURCE_PILOT_ID = process.env.PROP_GENERALIZATION_SOURCE_PILOT_ID ?? "prop-flash-1";

async function main(): Promise<void> {
  const connection = await requireConnection();
  const sourceState = await readDocument(connection, currentStateDocumentId(SOURCE_PILOT_ID));
  const dayTripper = aircraftArchetypes.find((candidate) => candidate.id === "day-tripper");
  if (!dayTripper) throw new Error("missing day-tripper archetype");

  const results: HoldoutResult[] = [];
  for (let seed = 1; seed <= SEEDS; seed += 1) {
    const noGardenPilotId = `prop-holdout-nogarden-${RUN_ID}-${seed}`;
    results.push(await runOne({ connection, airframe: dayTripper.airframe, label: "no-garden", seed, pilotId: noGardenPilotId }));

    const trainedPilotId = `prop-holdout-trained-${RUN_ID}-${seed}`;
    await writeDocument(connection, currentStateDocumentId(trainedPilotId), sourceState);
    results.push(await runOne({ connection, airframe: dayTripper.airframe, label: "trained-garden", seed, pilotId: trainedPilotId }));
  }

  const out = {
    runId: RUN_ID,
    graphId: connection.graphId,
    model: MODEL,
    sourcePilotId: SOURCE_PILOT_ID,
    sourceCurrentStateDocumentId: currentStateDocumentId(SOURCE_PILOT_ID),
    stage: "generalization-recovery",
    turns: TURNS,
    results,
    aggregate: aggregate(results),
  };
  await mkdir("reports/coach", { recursive: true });
  const path = `reports/coach/prop-generalization-${RUN_ID}.json`;
  await writeFile(path, `${JSON.stringify(out, null, 2)}\n`);
  console.log(JSON.stringify({ path, ...out }, null, 2));
}

async function runOne(input: {
  connection: GardenMcpConnection;
  airframe: typeof aircraftArchetypes[number]["airframe"];
  label: HoldoutResult["label"];
  seed: number;
  pilotId: string;
}): Promise<HoldoutResult> {
  console.error(`prop-generalization ${input.label} seed=${input.seed} pilot=${input.pilotId}`);
  const result = await runTrainingChamber({
    airframe: input.airframe,
    connection: input.connection,
    sorties: 1,
    runId: `${RUN_ID}-${input.label}-s${input.seed}`,
    pilotId: input.pilotId,
    reflectionModel: MODEL,
    reflectionMaxTokens: 900,
    scenario: {
      schemaVersion: 1,
      kind: "duel",
      controlMode: "motor-program",
      pilotModel: MODEL,
      bodyModel: "scripted-fixed-wing-body",
      twitchBodyModel: "scripted-fixed-wing-body",
      turnCount: TURNS,
      motorProgramTurnMs: 2_500,
      motorProgramSampleMs: 50,
      twitchTimeScale: 0.35,
      cameraMode: "pilot-cinema",
    },
    drill: {
      kind: "prop-flight-camp",
      pilotModel: MODEL,
      stage: "generalization-recovery",
      turnCount: TURNS,
      decisionTimeoutMs: numberEnv("PROP_GENERALIZATION_DECISION_TIMEOUT_MS", 60_000),
    },
    onProgress(progress) {
      console.error(`prop-generalization ${input.label} s${input.seed} ${progress.phase}: ${progress.message}`);
    },
  });
  const sortie = result.sorties[0];
  if (!sortie) throw new Error(`missing sortie result for ${input.pilotId}`);
  return {
    label: input.label,
    seed: input.seed,
    pilotId: input.pilotId,
    replayId: sortie.replay.id,
    sortieDocumentId:
      sortie.sortieJournal.enabled && sortie.sortieJournal.status === "written"
        ? sortie.sortieJournal.documentId
        : undefined,
    reflectionDocumentId: sortie.reflectionJournal.documentId,
    currentStateDocumentId: sortie.currentStateJournal.documentId,
    metrics: summarizePropReplay(sortie.replay, input.pilotId),
  };
}

function summarizePropReplay(replay: MatchReplay, pilotId: string): PropMetrics {
  const snaps = replay.frames
    .map((frame) => frame.aircraft.find((ship) => ship.id === pilotId))
    .filter((ship): ship is NonNullable<typeof ship> => Boolean(ship));
  if (snaps.length === 0) throw new Error(`no snapshots for ${pilotId}`);
  const first = snaps[0]!;
  const last = snaps[snaps.length - 1]!;
  const byTurn = new Map<number, typeof snaps>();
  for (const frame of replay.frames) {
    const ship = frame.aircraft.find((candidate) => candidate.id === pilotId);
    if (!ship) continue;
    const list = byTurn.get(frame.turn) ?? [];
    list.push(ship);
    byTurn.set(frame.turn, list);
  }
  let firstNonDescendingTurn: number | undefined;
  for (const [turn, turnSnaps] of [...byTurn.entries()].sort((a, b) => a[0] - b[0])) {
    if (turn < 1 || turnSnaps.length < 2) continue;
    if (turnSnaps.at(-1)!.altitude >= turnSnaps[0]!.altitude) {
      firstNonDescendingTurn = turn;
      break;
    }
  }
  const actions = replay.decisions?.filter((decision) => decision.agentId === pilotId) ?? [];
  const rollCommands = actions.flatMap((decision) =>
    decision.action.kind === "motor-program" ? decision.action.samples.map((sample) => Math.abs(sample.roll)) : [],
  );
  return {
    startAltitudeM: first.altitude,
    finalAltitudeM: last.altitude,
    minAltitudeM: Math.min(...snaps.map((snap) => snap.altitude)),
    altitudeLossM: first.altitude - Math.min(...snaps.map((snap) => snap.altitude)),
    startSpeedMps: first.airspeed,
    finalSpeedMps: last.airspeed,
    maxSpeedMps: Math.max(...snaps.map((snap) => snap.airspeed)),
    peakG: Math.max(...snaps.map((snap) => snap.gLoad)),
    peakAoADeg: Math.max(...snaps.map((snap) => snap.aoaDeg)),
    minAoADeg: Math.min(...snaps.map((snap) => snap.aoaDeg)),
    ...(firstNonDescendingTurn !== undefined ? { firstNonDescendingTurn } : {}),
    maxAbsRollCommand: rollCommands.length > 0 ? Math.max(...rollCommands) : 0,
    fallbackTurns: actions.filter((decision) => decision.source === "fallback").length,
    decisionTurns: actions.length,
  };
}

function aggregate(results: HoldoutResult[]) {
  const labels: HoldoutResult["label"][] = ["no-garden", "trained-garden"];
  return Object.fromEntries(
    labels.map((label) => {
      const rows = results.filter((result) => result.label === label);
      return [
        label,
        {
          count: rows.length,
          altitudeLossM: mean(rows.map((row) => row.metrics.altitudeLossM)),
          finalAltitudeM: mean(rows.map((row) => row.metrics.finalAltitudeM)),
          maxSpeedMps: mean(rows.map((row) => row.metrics.maxSpeedMps)),
          peakG: mean(rows.map((row) => row.metrics.peakG)),
          firstNonDescendingTurn: mean(rows.map((row) => row.metrics.firstNonDescendingTurn ?? TURNS + 1)),
          maxAbsRollCommand: mean(rows.map((row) => row.metrics.maxAbsRollCommand)),
          fallbackTurns: rows.reduce((sum, row) => sum + row.metrics.fallbackTurns, 0),
        },
      ];
    }),
  );
}

async function requireConnection(): Promise<GardenMcpConnection> {
  const resolution = await resolveGardenConnection({ ...process.env, FLIGHT_GARDEN_GRAPH_ID: GRAPH_ID });
  if (!resolution.enabled) throw new Error(`Garden connection required: ${resolution.reason}`);
  return resolution.connection;
}

async function readDocument(connection: GardenMcpConnection, documentId: string): Promise<string> {
  const response = await callGardenTool<GardenReadDocument | string>(connection, "read_document", {
    graphId: connection.graphId,
    documentId,
    format: "markdown",
  });
  const content =
    typeof response === "string"
      ? response
      : response.markdown ?? response.content ?? response.text ?? response.document?.markdown ?? response.document?.content ?? response.document?.text;
  if (!content) throw new Error(`empty Garden document ${documentId}`);
  return content;
}

async function writeDocument(connection: GardenMcpConnection, documentId: string, content: string): Promise<void> {
  await callGardenTool(connection, "write_document", {
    graphId: connection.graphId,
    documentId,
    content,
    format: "markdown",
    awaitDurable: true,
    comments: {},
  });
}

function currentStateDocumentId(pilotId: string): string {
  const slug = pilotId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 58);
  return `flight-pilot-${slug || "pilot"}-current-state`;
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
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
