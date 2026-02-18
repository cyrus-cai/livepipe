import { detectIntent } from "@/lib/intent-detector";
import { getPipeConfig } from "@/lib/pipe-config";
import { PipelineLogger, debugError, debugLog } from "@/lib/pipeline-logger";
import type { ReviewContext } from "@/lib/review";
import type { IntentResult } from "@/lib/schemas";

export type ProcessIntentHandler = (
  intent: IntentResult,
  logger: PipelineLogger,
  context?: ReviewContext,
) => Promise<void>;

interface ClipboardMonitorOptions {
  processIntent: ProcessIntentHandler;
}

const CLIPBOARD_APP = "clipboard";
const MIN_POLL_INTERVAL_MS = 1000;

let running = false;
let stopRequested = false;
let loopPromise: Promise<void> | null = null;
let sequence = 0;
let lastClipboardText = "";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildTextSnippet(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) return "";
  return compact.length > 120 ? `${compact.slice(0, 120)}...` : compact;
}

async function readClipboard(): Promise<string> {
  try {
    const process = Bun.spawn(["pbpaste"], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      process.stdout ? new Response(process.stdout).text() : Promise.resolve(""),
      process.stderr ? new Response(process.stderr).text() : Promise.resolve(""),
      process.exited,
    ]);

    if (exitCode !== 0) {
      debugError(
        `[clipboard] pbpaste exited with code ${exitCode}: ${stderr.trim() || "(no stderr output)"}`
      );
      return "";
    }

    return stdout.replace(/\r\n/g, "\n").trim();
  } catch (error) {
    debugError("[clipboard] failed to read clipboard:", error);
    return "";
  }
}

async function runClipboardLoop(options: ClipboardMonitorOptions): Promise<void> {
  running = true;
  stopRequested = false;
  console.log("[clipboard] monitor started");

  try {
    while (!stopRequested) {
      const clipboardConfig = getPipeConfig().clipboard;
      const pollIntervalMs = Math.max(clipboardConfig.pollIntervalMs, MIN_POLL_INTERVAL_MS);
      const minTextLength = Math.max(clipboardConfig.minTextLength, 1);

      const text = await readClipboard();
      if (!text || text.length < minTextLength) {
        await sleep(pollIntervalMs);
        continue;
      }

      if (text === lastClipboardText) {
        await sleep(pollIntervalMs);
        continue;
      }

      lastClipboardText = text;

      const logger = new PipelineLogger("poll", ++sequence, "clipboard");
      try {
        logger.fetch({
          totalItems: 1,
          keptItems: 1,
          apps: [CLIPBOARD_APP],
          chars: text.length,
          skippedApp: 0,
          skippedWindow: 0,
          skippedShort: 0,
          skippedDedup: 0,
        });

        const batch = {
          texts: [text],
          apps: new Set([CLIPBOARD_APP]),
          startTime: Date.now(),
          endTime: Date.now(),
        };

        logger.info("② INTENT  正在识别");
        const intent = await detectIntent(batch);
        if (!intent) {
          logger.intentSkip("detector failed");
          logger.flush();
          await sleep(pollIntervalMs);
          continue;
        }

        logger.intent({
          actionable: intent.actionable,
          noteworthy: intent.noteworthy,
          urgent: intent.urgent,
          content: intent.content,
          dueTime: intent.due_time,
          latencyMs: intent.latencyMs,
        });
        logger.info("② INTENT  已完成");

        if (intent.actionable || intent.noteworthy) {
          const reviewCtx: ReviewContext = {
            sourceApp: CLIPBOARD_APP,
            trigger: "clipboard",
            textSnippet: buildTextSnippet(text),
            language: getPipeConfig().outputLanguage,
          };
          await options.processIntent(intent, logger, reviewCtx);
        } else {
          logger.intentSkip("neither actionable nor noteworthy");
        }

        logger.flush();
      } catch (error) {
        logger.info(`error: ${getErrorMessage(error)}`);
        logger.flush();
        debugError("[clipboard] pipeline error:", error);
      }

      await sleep(pollIntervalMs);
    }
  } finally {
    running = false;
    loopPromise = null;
    console.log("[clipboard] monitor stopped");
  }
}

export function startClipboardMonitor(options: ClipboardMonitorOptions): void {
  if (running || loopPromise) {
    stopRequested = false;
    return;
  }

  debugLog("[clipboard] start requested");
  loopPromise = runClipboardLoop(options).catch((error) => {
    running = false;
    loopPromise = null;
    debugError("[clipboard] loop crashed:", error);
    console.error("[clipboard] monitor crashed:", getErrorMessage(error));
  });
}

export function stopClipboardMonitor(): void {
  stopRequested = true;
}

export function isClipboardMonitorRunning(): boolean {
  return running;
}
