import { createHash } from "node:crypto";
import { callGardenTool, resolveGardenConnection, type GardenMcpConnection } from "./client";
import { MatchReplaySchema, type MatchReplay } from "../protocol/schema";
import { buildDebriefGrounding, debriefEvidenceBlock } from "../server/debriefContext";

export interface GardenJournalOptions {
  pilotId?: string;
  targetId?: string;
  documentId?: string;
  connection?: GardenMcpConnection;
  env?: Record<string, string | undefined>;
}

export interface GardenJournalWritten {
  enabled: true;
  status: "written";
  graphId: string;
  documentId: string;
  title: string;
  source: GardenMcpConnection["source"];
  mcpUrl: string;
  blockIds?: string[];
}

export interface GardenJournalError {
  enabled: true;
  status: "error";
  error: string;
}

export interface GardenJournalDisabled {
  enabled: false;
  status: "disabled";
  reason: string;
}

export type GardenJournalResult = GardenJournalWritten | GardenJournalError | GardenJournalDisabled;

interface WriteDocumentResult {
  blockIds?: string[];
}

export async function maybeJournalScenarioReplay(
  replayInput: MatchReplay,
  options: GardenJournalOptions = {},
): Promise<GardenJournalResult> {
  try {
    return await journalScenarioReplay(replayInput, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("Garden journaling disabled:")) {
      return {
        enabled: false,
        status: "disabled",
        reason: message.replace(/^Garden journaling disabled:\s*/, ""),
      };
    }
    return { enabled: true, status: "error", error: message };
  }
}

export async function journalScenarioReplay(
  replayInput: MatchReplay,
  options: GardenJournalOptions = {},
): Promise<GardenJournalWritten> {
  const replay = MatchReplaySchema.parse(replayInput);
  const connection = options.connection ?? await requireGardenConnection(options.env);
  const pilotId = options.pilotId ?? "blue-1";
  const document = buildSortieJournalDocument(replay, {
    pilotId,
    targetId: options.targetId,
    documentId: options.documentId,
  });
  const result = await callGardenTool<WriteDocumentResult>(connection, "write_document", {
    graphId: connection.graphId,
    documentId: document.documentId,
    content: document.content,
    format: "markdown",
    awaitDurable: true,
    comments: {},
  });

  return {
    enabled: true,
    status: "written",
    graphId: connection.graphId,
    documentId: document.documentId,
    title: document.title,
    source: connection.source,
    mcpUrl: connection.mcpUrl,
    ...(Array.isArray(result.blockIds) ? { blockIds: result.blockIds } : {}),
  };
}

export function buildSortieJournalDocument(
  replay: MatchReplay,
  options: { pilotId?: string; targetId?: string; documentId?: string } = {},
): { documentId: string; title: string; content: string } {
  const pilotId = options.pilotId ?? "blue-1";
  const grounding = buildDebriefGrounding(replay, { pilotId, targetId: options.targetId });
  const agent = replay.agents?.find((candidate) => candidate.id === pilotId);
  const title = compactTitle(`Flight sortie ${shortId(replay.id)} - ${agent?.label ?? pilotId}`);
  const documentId = options.documentId ?? sortieDocumentId(replay.id, pilotId);
  const decisions = (replay.decisions ?? []).filter((decision) => decision.agentId === pilotId);
  const comms = replay.comms ?? [];
  const complete = replay.outcome
    ? `${replay.outcome.resolved ? "resolved" : "unresolved"} / ${replay.outcome.reason}`
    : "no outcome recorded";
  const usageCost = decisions.reduce((sum, decision) => sum + (decision.usage?.costUsd ?? 0), 0);

  const lines: string[] = [];
  lines.push(`# ${title}`);
  lines.push("");
  lines.push("## Sortie Metadata");
  lines.push("");
  lines.push(`- Replay: \`${replay.id}\``);
  lines.push(`- Pilot: \`${pilotId}\`${agent?.label ? ` (${agent.label})` : ""}`);
  if (grounding.targetId) lines.push(`- Target: \`${grounding.targetId}\``);
  lines.push(`- Duration: ${grounding.durationSeconds.toFixed(1)} s`);
  lines.push(`- Turns with truth: ${grounding.turnTruth.length}`);
  lines.push(`- Decisions: ${decisions.length}`);
  lines.push(`- Comms: ${comms.length}`);
  lines.push(`- Frames: ${replay.frames.length}`);
  lines.push(`- Outcome: ${complete}`);
  if (usageCost > 0) lines.push(`- Pilot decision cost: $${usageCost.toFixed(4)}`);
  lines.push("");
  lines.push("## Coach Evidence");
  lines.push("");
  lines.push(debriefEvidenceBlock(grounding));
  lines.push("");
  lines.push("## Reflection Prompt");
  lines.push("");
  lines.push("What did I intend, what did the aircraft actually do, and what will I change on the next sortie?");
  lines.push("");
  lines.push("## Structured Summary");
  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify(structuredSortieSummary(replay, pilotId, grounding), null, 2));
  lines.push("```");
  return { documentId, title, content: lines.join("\n") };
}

async function requireGardenConnection(
  env: Record<string, string | undefined> | undefined,
): Promise<GardenMcpConnection> {
  const resolution = await resolveGardenConnection(env);
  if (!resolution.enabled) {
    throw new Error(`Garden journaling disabled: ${resolution.reason}`);
  }
  return resolution.connection;
}

function structuredSortieSummary(
  replay: MatchReplay,
  pilotId: string,
  grounding: ReturnType<typeof buildDebriefGrounding>,
) {
  return {
    schemaVersion: 1,
    replayId: replay.id,
    pilotId,
    targetId: grounding.targetId,
    durationSeconds: grounding.durationSeconds,
    decisions: (replay.decisions ?? []).filter((decision) => decision.agentId === pilotId).length,
    phaseCounts: grounding.phaseCounts,
    peakG: grounding.peakG,
    minAlt: grounding.minAlt,
    overshootTurn: grounding.overshootTurn,
    outcome: grounding.outcome,
    turnTruth: grounding.turnTruth.map((turn) => ({
      turn: turn.turn,
      rangeStartM: round(turn.rangeStartM),
      rangeEndM: round(turn.rangeEndM),
      offNoseStartDeg: round(turn.offNoseStartDeg),
      offNoseEndDeg: round(turn.offNoseEndDeg),
      peakG: round(turn.peakG, 1),
      minAltM: round(turn.minAltM),
      peakAoADeg: round(turn.peakAoADeg, 1),
      overshot: turn.overshot,
    })),
  };
}

function sortieDocumentId(replayId: string, pilotId: string): string {
  const hash = createHash("sha1").update(`${replayId}\n${pilotId}`).digest("hex").slice(0, 10);
  return `flight-sortie-${slug(pilotId)}-${slug(shortId(replayId))}-${hash}`;
}

function shortId(id: string): string {
  const parts = id.split("|").filter(Boolean);
  return parts.length > 1 ? parts.slice(-3).join("-") : id;
}

function slug(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 58);
  return cleaned || "sortie";
}

function round(value: number, digits = 0): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function compactTitle(value: string): string {
  const max = 96;
  if (value.length <= max) return value;
  return `${value.slice(0, max - 11).trimEnd()}-${createHash("sha1").update(value).digest("hex").slice(0, 10)}`;
}
