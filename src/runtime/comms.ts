import {
  AgentMessageSchema,
  type AgentMessage,
  type AgentMessageChannel,
  type AgentMessagePriority,
  type AgentNavigationFix,
  type ContactPercept,
  type Observation,
  type ReplayFrame,
  type TurnDecision,
} from "../protocol/schema";
import type { AircraftState } from "../sim/types";

export type AgentMessageRepeat = "once" | "each-turn";

export interface AgentMessageDraft {
  id?: string;
  to: string | "all";
  from?: string;
  channel?: AgentMessageChannel;
  priority?: AgentMessagePriority;
  content: string;
  turn?: number;
  startTurn?: number;
  endTurn?: number;
  repeat?: AgentMessageRepeat;
  includeNavigation?: boolean;
  navigation?: AgentNavigationFix;
}

export interface AgentMessageContext {
  turn: number;
  time: number;
  agentId: string;
  allAgentIds: string[];
  self: AircraftState;
  world: AircraftState[];
  observation: Observation;
  contacts: ContactPercept[];
  navigation: AgentNavigationFix;
  history?: {
    frames: readonly ReplayFrame[];
    decisions: readonly TurnDecision[];
    comms: readonly AgentMessage[];
  };
}

export type AgentMessageProvider = (
  context: AgentMessageContext,
) => AgentMessageDraft[] | Promise<AgentMessageDraft[]>;

export interface AgentMessageBus {
  send(message: AgentMessageDraft): void;
  drain(context: AgentMessageContext): AgentMessageDraft[];
}

export interface AgentComms {
  messages?: AgentMessageDraft[];
  providers?: AgentMessageProvider[];
  buses?: AgentMessageBus[];
  preDecisionWindowMs?: number;
  onDispatch?: (message: AgentMessage, context: AgentMessageContext) => void;
}

interface QueuedMessage {
  draft: AgentMessageDraft;
  deliveredTo: Set<string>;
}

export function createAgentMessageBus(initialMessages: AgentMessageDraft[] = []): AgentMessageBus {
  const queue: QueuedMessage[] = initialMessages.map((draft) => ({ draft, deliveredTo: new Set() }));
  return {
    send(message) {
      queue.push({ draft: message, deliveredTo: new Set() });
    },
    drain(context) {
      const delivered: AgentMessageDraft[] = [];
      const remaining: QueuedMessage[] = [];
      for (const item of queue) {
        if (item.deliveredTo.has(context.agentId)) {
          remaining.push(item);
          continue;
        }
        if (!draftActiveForContext(item.draft, context)) {
          remaining.push(item);
          continue;
        }
        delivered.push(item.draft);
        item.deliveredTo.add(context.agentId);
        if (item.draft.repeat === "each-turn") {
          remaining.push(item);
        } else if (item.draft.to === "all" && item.deliveredTo.size < context.allAgentIds.length) {
          // A one-shot broadcast is useful for queued operator input, but the bus does not know the
          // current agent roster until drain-time. Keep it until every active agent has received it.
          remaining.push(item);
        }
      }
      queue.splice(0, queue.length, ...remaining);
      return delivered;
    },
  };
}

export function mergeAgentComms(...sources: Array<AgentComms | undefined>): AgentComms | undefined {
  const messages = sources.flatMap((source) => source?.messages ?? []);
  const providers = sources.flatMap((source) => source?.providers ?? []);
  const buses = sources.flatMap((source) => source?.buses ?? []);
  const dispatchers = sources
    .map((source) => source?.onDispatch)
    .filter((dispatcher): dispatcher is NonNullable<AgentComms["onDispatch"]> => Boolean(dispatcher));
  const preDecisionWindowMs = sources.reduce<number | undefined>(
    (current, source) => source?.preDecisionWindowMs ?? current,
    undefined,
  );
  if (messages.length === 0 && providers.length === 0 && buses.length === 0 && dispatchers.length === 0) {
    return preDecisionWindowMs === undefined ? undefined : { preDecisionWindowMs };
  }
  return {
    ...(messages.length > 0 ? { messages } : {}),
    ...(providers.length > 0 ? { providers } : {}),
    ...(buses.length > 0 ? { buses } : {}),
    ...(preDecisionWindowMs !== undefined ? { preDecisionWindowMs } : {}),
    ...(dispatchers.length > 0
      ? {
          onDispatch(message, context) {
            for (const dispatch of dispatchers) dispatch(message, context);
          },
        }
      : {}),
  };
}

export async function collectAgentMessages(
  comms: AgentComms | undefined,
  context: AgentMessageContext,
): Promise<AgentMessage[]> {
  if (!comms) return [];
  if (comms.preDecisionWindowMs && comms.preDecisionWindowMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, comms.preDecisionWindowMs));
  }

  const drafts: AgentMessageDraft[] = [];
  drafts.push(...(comms.messages ?? []));
  for (const bus of comms.buses ?? []) drafts.push(...bus.drain(context));
  for (const provider of comms.providers ?? []) drafts.push(...(await provider(context)));

  const messages = drafts
    .filter((draft) => draftActiveForContext(draft, context))
    .map((draft, index) => materializeMessage(draft, context, index));

  for (const message of messages) comms.onDispatch?.(message, context);
  return messages;
}

function materializeMessage(draft: AgentMessageDraft, context: AgentMessageContext, index: number): AgentMessage {
  const to = draft.to === "all" ? context.agentId : draft.to;
  const repeat = draft.repeat ?? "once";
  const baseId = draft.id ?? `${draft.channel ?? "operator"}-${slug(draft.content).slice(0, 36) || "message"}`;
  const id = repeat === "each-turn" ? `${baseId}|t${context.turn}|to:${to}` : `${baseId}|to:${to}|${index}`;
  return AgentMessageSchema.parse({
    id,
    to,
    ...(draft.from ? { from: draft.from } : {}),
    channel: draft.channel ?? "operator",
    ...(draft.priority ? { priority: draft.priority } : {}),
    turn: context.turn,
    time: context.time,
    content: draft.content,
    ...(draft.navigation ?? draft.includeNavigation ? { navigation: draft.navigation ?? context.navigation } : {}),
  });
}

function draftActiveForContext(draft: AgentMessageDraft, context: AgentMessageContext): boolean {
  if (draft.to !== "all" && draft.to !== context.agentId) return false;
  if (draft.turn !== undefined) return draft.turn === context.turn;
  const start = draft.startTurn ?? 1;
  const end = draft.endTurn ?? Number.POSITIVE_INFINITY;
  if (context.turn < start || context.turn > end) return false;
  if ((draft.repeat ?? "once") === "once" && draft.startTurn !== undefined) {
    return context.turn === draft.startTurn;
  }
  return true;
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
