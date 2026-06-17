// "Talk to pilot" — the conversational completion of /api/scenario/inspect. Given a replay (+ optional
// focus time and pilot id) and a running conversation, reconstruct the per-turn flight truth (see
// debriefContext.ts), frame a grounded+honest system prompt, and call a chat model via pi-ai complete()
// so the pilot answers AS ITSELF about its own flight. A key-free scripted responder backs the same
// plumbing for offline tests, mirroring the scripted Body fallback used elsewhere in the sim.
import { complete, type TextContent } from "@earendil-works/pi-ai";
import { z } from "zod";
import { resolveOpenRouterModel } from "../agent/controllers/pi";
import { MatchReplaySchema, type MatchReplay } from "../protocol/schema";
import {
  buildDebriefGrounding,
  debriefEvidenceBlock,
  debriefSystemPrompt,
  type DebriefGrounding,
} from "./debriefContext";

// A thoughtful first-party DeepSeek planner, consistent with the repo's slow-loop default.
export const DEFAULT_DEBRIEF_MODEL = "deepseek-v4-pro";
const SCRIPTED_DEBRIEF_MODEL = "scripted-debrief";

const DebriefMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1).max(8_000),
});

export const ScenarioDebriefRequestSchema = z.object({
  replay: MatchReplaySchema,
  pilotId: z.string().default("blue-1"),
  targetId: z.string().optional(),
  time: z.number().optional(),
  model: z.string().min(1).max(120).default(DEFAULT_DEBRIEF_MODEL),
  // The running conversation. The final entry should be the user's newest message; if the last entry is
  // not a user turn (or the array is empty) the responder treats it as an opening debrief request.
  messages: z.array(DebriefMessageSchema).max(40).default([]),
  maxTokens: z.number().int().min(64).max(4_000).optional(),
});

export type ScenarioDebriefRequest = z.infer<typeof ScenarioDebriefRequestSchema>;
export type DebriefMessage = z.infer<typeof DebriefMessageSchema>;

export interface ScenarioDebriefResponse {
  schemaVersion: 1;
  replayId: string;
  pilotId: string;
  pilotLabel: string;
  time: number;
  model: string;
  scripted: boolean;
  reply: string;
  grounding: {
    targetId?: string;
    durationSeconds: number;
    phaseCounts: DebriefGrounding["phaseCounts"];
    turns: number;
    peakG?: DebriefGrounding["peakG"];
    minAlt?: DebriefGrounding["minAlt"];
    overshootTurn?: number;
    outcome?: DebriefGrounding["outcome"];
  };
  usage?: { inputTokens: number; outputTokens: number; costUsd: number };
}

export async function debriefScenarioApiRequest(input: unknown): Promise<ScenarioDebriefResponse> {
  const request = ScenarioDebriefRequestSchema.parse(input);
  return debriefScenarioReplay(request.replay, request);
}

export async function debriefScenarioReplay(
  replay: MatchReplay,
  options: {
    pilotId?: string;
    targetId?: string;
    time?: number;
    model?: string;
    messages?: DebriefMessage[];
    maxTokens?: number;
  } = {},
): Promise<ScenarioDebriefResponse> {
  const pilotId = options.pilotId ?? "blue-1";
  const model = options.model ?? DEFAULT_DEBRIEF_MODEL;
  const messages = options.messages ?? [];
  const grounding = buildDebriefGrounding(replay, {
    pilotId,
    time: options.time,
    targetId: options.targetId,
  });

  const groundingSummary: ScenarioDebriefResponse["grounding"] = {
    ...(grounding.targetId ? { targetId: grounding.targetId } : {}),
    durationSeconds: grounding.durationSeconds,
    phaseCounts: grounding.phaseCounts,
    turns: grounding.turnTruth.length,
    ...(grounding.peakG ? { peakG: grounding.peakG } : {}),
    ...(grounding.minAlt ? { minAlt: grounding.minAlt } : {}),
    ...(grounding.overshootTurn !== undefined ? { overshootTurn: grounding.overshootTurn } : {}),
    ...(grounding.outcome ? { outcome: grounding.outcome } : {}),
  };

  const base = {
    schemaVersion: 1 as const,
    replayId: grounding.replayId,
    pilotId,
    pilotLabel: grounding.pilotLabel,
    time: grounding.focusTime,
    grounding: groundingSummary,
  };

  // Offline / test path: deterministic, key-free, still strictly grounded in the same evidence.
  if (useScriptedDebrief(model)) {
    return {
      ...base,
      model: SCRIPTED_DEBRIEF_MODEL,
      scripted: true,
      reply: scriptedDebriefReply(grounding, messages),
    };
  }

  assertDebriefKey(model);
  const resolved = resolveOpenRouterModel(model);
  const systemPrompt = `${debriefSystemPrompt(grounding)}\n\n=== REPLAY EVIDENCE (your only source of truth) ===\n${debriefEvidenceBlock(grounding)}`;
  const transcript = renderConversation(messages);

  const response = await complete(
    resolved,
    {
      systemPrompt,
      messages: [{ role: "user", content: transcript, timestamp: Date.now() }],
    },
    { maxTokens: options.maxTokens ?? 1_200, maxRetries: 4 },
  );

  if (response.stopReason === "error" || response.content.length === 0) {
    throw new Error(
      response.errorMessage ?? `debrief model returned stopReason=${response.stopReason} with no content`,
    );
  }

  const reply = response.content
    .filter((b): b is TextContent => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  return {
    ...base,
    model,
    scripted: false,
    reply: reply || "(the pilot fell silent)",
    usage: {
      inputTokens: response.usage.input,
      outputTokens: response.usage.output,
      costUsd: response.usage.cost.total,
    },
  };
}

// Fold the running conversation into a single user message the model reads after the evidence. Prior
// assistant turns are labelled so the model keeps continuity without us hand-building AssistantMessages.
function renderConversation(messages: DebriefMessage[]): string {
  const latest = messages[messages.length - 1];
  const opening =
    !latest || latest.role !== "user"
      ? "Open the debrief: in two or three sentences, tell me honestly how that flight went, grounded in the trace."
      : undefined;
  const history = messages
    .map((m) => `${m.role === "user" ? "COACH" : "PILOT (you, earlier)"}: ${m.content}`)
    .join("\n\n");
  return [
    history || "(no prior exchange)",
    opening ? `COACH: ${opening}` : undefined,
    "\nReply as the pilot, grounded only in the replay evidence above.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function useScriptedDebrief(model: string): boolean {
  if (model === SCRIPTED_DEBRIEF_MODEL) return true;
  // Allow tests / offline use to force the stub regardless of slug.
  return process.env.SCENARIO_DEBRIEF_SCRIPTED === "1";
}

function isDirectDeepSeekSlug(modelSlug: string): boolean {
  return modelSlug.startsWith("deepseek-v");
}

function assertDebriefKey(model: string): void {
  if (isDirectDeepSeekSlug(model)) {
    if (!process.env.DEEPSEEK_API_KEY) {
      throw new Error(`DEEPSEEK_API_KEY is required for debrief model ${model}`);
    }
    return;
  }
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error(`OPENROUTER_API_KEY is required for debrief model ${model}`);
  }
}

// Deterministic, evidence-only responder. It never invents events: every claim is read straight off the
// grounding. Good enough to exercise the request/response plumbing and prove the grounding extraction in
// an offline test, while staying honest about being a stub.
function scriptedDebriefReply(g: DebriefGrounding, messages: DebriefMessage[]): string {
  const latest = messages[messages.length - 1];
  const lines: string[] = [];
  lines.push(`[scripted debrief — offline stub, ${g.pilotLabel}]`);
  if (latest && latest.role === "user") {
    lines.push(`You asked: "${latest.content.slice(0, 160)}".`);
  }
  if (g.turnTruth.length === 0) {
    lines.push("The trace doesn't show any per-turn flight decisions for me, so I can't speak to specific maneuvers.");
  } else {
    lines.push(`I flew ${g.turnTruth.length} recorded turn(s) over ${g.durationSeconds.toFixed(1)}s.`);
    if (g.peakG) lines.push(`I pulled a peak of ${g.peakG.value.toFixed(1)} G on turn ${g.peakG.turn}.`);
    if (g.minAlt) {
      lines.push(
        `My lowest altitude was ${g.minAlt.value.toFixed(0)} m on turn ${g.minAlt.turn}${g.minAlt.value < 120 ? " — uncomfortably near the 55 m floor" : ""}.`,
      );
    }
    if (g.overshootTurn !== undefined) {
      lines.push(`I overshot on turn ${g.overshootTurn} — the target slid behind my nose.`);
    } else {
      lines.push("The trace doesn't show an overshoot.");
    }
  }
  if (g.outcome) {
    lines.push(
      `Outcome: ${g.outcome.reason}; I ${g.outcome.survived ? "survived" : "did not survive"} (shots ${g.shots}, hits ${g.hits}).`,
    );
  }
  lines.push("I'm only reporting what the replay shows; ask me about a specific turn for more.");
  return lines.join(" ");
}
