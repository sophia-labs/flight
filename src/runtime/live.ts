import type { MatchReplay } from "../protocol/schema";
import { createAgentMessageBus, mergeAgentComms, type AgentMessageDraft } from "./comms";
import type { MatchConfig, MatchProgress } from "./config";
import { runMatch } from "./match";

export interface LiveMatchSession {
  progress: AsyncIterable<MatchProgress>;
  done: Promise<MatchReplay>;
  sendMessage(message: AgentMessageDraft): void;
}

export interface LiveMatchOptions {
  preDecisionMessageWindowMs?: number;
}

export function startLiveMatch(config: MatchConfig, options: LiveMatchOptions = {}): LiveMatchSession {
  const bus = createAgentMessageBus();
  const progress = createProgressQueue();
  const done = runMatch({
    ...config,
    comms: mergeAgentComms(config.comms, {
      buses: [bus],
      ...(options.preDecisionMessageWindowMs !== undefined
        ? { preDecisionWindowMs: options.preDecisionMessageWindowMs }
        : {}),
    }),
    onProgress(event) {
      config.onProgress?.(event);
      progress.push(event);
    },
  })
    .then((replay) => {
      progress.close();
      return replay;
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      progress.push({
        phase: "error",
        turn: 0,
        maxTurns: config.maxTurns,
        time: 0,
        error: message,
      });
      progress.close();
      throw error;
    });

  return {
    progress,
    done,
    sendMessage(message) {
      bus.send(message);
    },
  };
}

function createProgressQueue(): AsyncIterable<MatchProgress> & {
  push(event: MatchProgress): void;
  close(): void;
} {
  const events: MatchProgress[] = [];
  const waiters: Array<(value: IteratorResult<MatchProgress>) => void> = [];
  let closed = false;

  return {
    push(event) {
      if (closed) return;
      const waiter = waiters.shift();
      if (waiter) waiter({ value: event, done: false });
      else events.push(event);
    },
    close() {
      if (closed) return;
      closed = true;
      while (waiters.length > 0) waiters.shift()?.({ value: undefined, done: true });
    },
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<MatchProgress>> {
          const event = events.shift();
          if (event) return Promise.resolve({ value: event, done: false });
          if (closed) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve) => waiters.push(resolve));
        },
      };
    },
  };
}
