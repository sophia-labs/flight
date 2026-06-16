import type { MatchReplay } from "../protocol/schema";
import type { MatchConfig } from "./config";
import { runMatch } from "./match";

export interface BatchJob<K> {
  key: K;
  config: MatchConfig;
}

export interface BatchResult<K> {
  key: K;
  replay?: MatchReplay;
  error?: string;
}

// Run many matches with a bounded concurrency pool. Each match is isolated — one failure becomes
// a recorded error, never killing the batch. Wall-clock ≈ ceil(jobs/concurrency) × match time,
// because each in-flight match overlaps the others' API latency.
export async function runBatch<K>(
  jobs: BatchJob<K>[],
  options: {
    concurrency: number;
    onResult?: (result: BatchResult<K>, done: number, total: number) => void;
  },
): Promise<BatchResult<K>[]> {
  const results: BatchResult<K>[] = new Array(jobs.length);
  let next = 0;
  let done = 0;

  async function worker(): Promise<void> {
    while (true) {
      const i = next;
      next += 1;
      if (i >= jobs.length) return;
      let result: BatchResult<K>;
      try {
        result = { key: jobs[i].key, replay: await runMatch(jobs[i].config) };
      } catch (err) {
        result = { key: jobs[i].key, error: err instanceof Error ? err.message : String(err) };
      }
      results[i] = result;
      done += 1;
      options.onResult?.(result, done, jobs.length);
    }
  }

  const poolSize = Math.max(1, Math.min(options.concurrency, jobs.length));
  await Promise.all(Array.from({ length: poolSize }, () => worker()));
  return results;
}
