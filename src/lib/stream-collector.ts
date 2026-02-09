import { pipe } from "@screenpipe/js";

const POLL_INTERVAL_MS = 5000; // poll every 5 seconds
const LOOKBACK_MS = 60_000; // look back 60 seconds each poll

export interface VisionEvent {
  text: string;
  app_name: string;
  timestamp: number;
}

let lastText = "";
let lastPollEnd = 0; // track last poll time to avoid re-processing

function detectChange(newText: string): string | null {
  const trimmed = newText.trim();
  if (!trimmed) return null;
  if (trimmed === lastText) return null;
  lastText = trimmed;
  return trimmed;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll screenpipe REST API for recent OCR content.
 * Yields when text changes are detected.
 */
export async function* collectVisionStream(): AsyncGenerator<VisionEvent> {
  console.log("[stream-collector] starting polling mode (every 5s, 30s lookback)...");

  while (true) {
    try {
      const now = Date.now();
      // Use the later of: 30s ago or last poll time
      const lookbackFrom = lastPollEnd > 0
        ? Math.max(lastPollEnd - 2000, now - LOOKBACK_MS) // 2s overlap to avoid gaps
        : now - LOOKBACK_MS;

      const startTime = new Date(lookbackFrom).toISOString();
      const endTime = new Date(now).toISOString();
      lastPollEnd = now;

      const result = await pipe.queryScreenpipe({
        contentType: "ocr",
        limit: 10,
        startTime,
        endTime,
      });

      if (result && result.data && result.data.length > 0) {
        for (const item of result.data) {
          if (item.type !== "OCR") continue;
          const content = item.content;
          const text = content.text;
          const appName = content.appName ?? "unknown";

          if (!text) continue;

          const changed = detectChange(text);
          if (!changed) continue;

          console.log(
            `[stream-collector] change from "${appName}" (${changed.length} chars)`
          );

          yield {
            text: changed,
            app_name: appName,
            timestamp: Date.now(),
          };
        }
      }
    } catch (error) {
      console.error("[stream-collector] poll error:", error);
    }

    console.log("[stream-collector] waiting 5s for next poll...");
    await sleep(POLL_INTERVAL_MS);
  }
}
