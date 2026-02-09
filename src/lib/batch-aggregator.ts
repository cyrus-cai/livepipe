import type { VisionEvent } from "./stream-collector";

const BATCH_INTERVAL_MS = 5000; // 5 seconds
const MAX_TEXT_LENGTH = 2000; // limit tokens sent to model

export interface Batch {
  texts: string[];
  apps: Set<string>;
  startTime: number;
  endTime: number;
}

/**
 * Aggregate vision events into batches of ~5 seconds.
 * Yields a batch when the time window expires and there's content.
 */
export async function* aggregateBatches(
  events: AsyncGenerator<VisionEvent>
): AsyncGenerator<Batch> {
  let currentBatch: Batch = {
    texts: [],
    apps: new Set(),
    startTime: Date.now(),
    endTime: Date.now(),
  };

  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let resolveFlush: (() => void) | null = null;

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      resolveFlush?.();
    }, BATCH_INTERVAL_MS);
  }

  // We use a two-track approach: consume events eagerly, flush on timer
  const pendingBatches: Batch[] = [];

  function flushCurrentBatch() {
    if (currentBatch.texts.length === 0) return;

    // Truncate combined text if too long
    const combinedLength = currentBatch.texts.reduce(
      (sum, t) => sum + t.length,
      0
    );
    if (combinedLength > MAX_TEXT_LENGTH) {
      let remaining = MAX_TEXT_LENGTH;
      const truncated: string[] = [];
      for (const t of currentBatch.texts) {
        if (remaining <= 0) break;
        truncated.push(t.slice(0, remaining));
        remaining -= t.length;
      }
      currentBatch.texts = truncated;
    }

    pendingBatches.push(currentBatch);
    currentBatch = {
      texts: [],
      apps: new Set(),
      startTime: Date.now(),
      endTime: Date.now(),
    };
  }

  // Simple loop: collect events, yield batches on timer
  const eventIterator = events[Symbol.asyncIterator]();

  while (true) {
    // Race between next event and flush timer
    const flushPromise = new Promise<"flush">((resolve) => {
      resolveFlush = () => resolve("flush");
      scheduleFlush();
    });

    const eventPromise = eventIterator.next().then((result) => ({
      type: "event" as const,
      result,
    }));

    const winner = await Promise.race([flushPromise, eventPromise]);

    if (winner === "flush") {
      flushCurrentBatch();
      // Yield any pending batches
      while (pendingBatches.length > 0) {
        const batch = pendingBatches.shift()!;
        console.log(
          `[batch-aggregator] yielding batch: ${batch.texts.length} texts from [${[...batch.apps].join(", ")}]`
        );
        yield batch;
      }
    } else {
      if (winner.result.done) break;
      const event = winner.result.value;
      currentBatch.texts.push(event.text);
      currentBatch.apps.add(event.app_name);
      currentBatch.endTime = event.timestamp;
    }
  }

  // Flush remaining
  flushCurrentBatch();
  for (const batch of pendingBatches) {
    yield batch;
  }
}
