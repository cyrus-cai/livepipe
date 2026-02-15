import { pipe } from "@screenpipe/js";
import { detectIntent } from "@/lib/intent-detector";
import {
  checkActionableDedup,
  checkNoteworthyDedup,
  recordAndNotify,
  recordNoteworthy,
  loadTasksFromFile,
  loadRawFromFile,
  loadMemoRawFromFile,
} from "@/lib/deduplication";
import { sendNotification } from "@/lib/notifier";
import { reviewIntent, type ReviewContext } from "@/lib/review";
import { createGeminiProvider } from "@/lib/providers/gemini";
import type { LlmProvider } from "@/lib/llm-provider";
import type { IntentResult } from "@/lib/schemas";
import { PipelineLogger, debugError, debugLog, type NotifyResult } from "@/lib/pipeline-logger";
import {
  type CaptureConfig,
  type FilterConfig,
  type PipeConfig,
  type ReviewConfig,
  PipeConfigValidationError,
  getEffectiveConfigSnapshot,
  getLastPipeConfigEvent,
  getPipeConfig,
  loadPipeConfigOrThrow,
  startPipeConfigWatcher,
} from "@/lib/pipe-config";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

let POLL_INTERVAL_MS = 0;
let LOOKBACK_MS = 0;
let TIMESTAMP_SKEW_TOLERANCE_MS = 0;

let isRunning = false;
let lastText = "";
let noDataCount = 0;
let pollSeq = 0;
let hotkeySeq = 0;

const LOG_DIR = join(process.cwd(), "logs");
const LOG_FILE = join(LOG_DIR, "screenpipe-raw.jsonl");
let captureConfig: CaptureConfig;
let filterConfig: FilterConfig;
let reviewConfig: ReviewConfig;
let outputLanguage = "zh-CN";
let allowedAppsLower = new Set<string>();
let blockedWindowsLower: string[] = [];

let reviewProvider: LlmProvider | null = null;
let configWatcherInitialized = false;

function logConfigValidationError(error: unknown): void {
  if (error instanceof PipeConfigValidationError) {
    console.error("[config] pipe.json 校验失败，请修复以下字段：");
    for (const issue of error.issues) {
      console.error(`[config] - ${issue}`);
    }
    return;
  }
  console.error("[config] failed to load pipe.json:", error);
}

function applyRuntimeConfig(config: PipeConfig, options?: { resetReviewProvider?: boolean }): void {
  captureConfig = config.capture;
  filterConfig = config.filter;
  reviewConfig = config.review;
  outputLanguage = config.outputLanguage;
  POLL_INTERVAL_MS = Math.max(captureConfig.pollIntervalMs, 1000);
  LOOKBACK_MS = Math.max(captureConfig.lookbackMs, POLL_INTERVAL_MS);
  TIMESTAMP_SKEW_TOLERANCE_MS = Math.max(captureConfig.timestampSkewToleranceMs, 0);
  allowedAppsLower = new Set(filterConfig.allowedApps.map((app) => app.toLowerCase()));
  blockedWindowsLower = filterConfig.blockedWindows.map((item) => item.toLowerCase());

  if (options?.resetReviewProvider) {
    reviewProvider = null;
  }
}

function logEffectiveConfig(): void {
  const snapshot = getEffectiveConfigSnapshot();
  console.log(
    `[config] 生效配置: review.enabled=${snapshot.reviewEnabled}, review.provider=${snapshot.provider || "(unset)"}, review.model=${snapshot.model || "(unset)"}, outputLanguage=${snapshot.outputLanguage}`
  );
}

function setupConfigWatcher(): void {
  if (configWatcherInitialized) {
    return;
  }
  configWatcherInitialized = true;

  startPipeConfigWatcher((event) => {
    if (event.type === "validation-error") {
      console.error(`[config] ${event.message}`);
      if (event.issues?.length) {
        for (const issue of event.issues) {
          console.error(`[config] - ${issue}`);
        }
      }
      return;
    }

    const nextConfig = getPipeConfig();
    const resetReviewProvider = event.changedFields.some((path) => path.startsWith("review."));
    applyRuntimeConfig(nextConfig, { resetReviewProvider });

    if (event.hotReloaded.length > 0) {
      console.log(`[config] 已热加载: ${event.hotReloaded.join(", ")}`);
      logEffectiveConfig();
    }
    if (event.restartRequired.length > 0) {
      console.warn(`[config] 配置变更需要重启后生效: ${event.restartRequired.join(", ")}`);
    }
  });
}

try {
  applyRuntimeConfig(loadPipeConfigOrThrow(), { resetReviewProvider: true });
} catch (error) {
  logConfigValidationError(error);
  throw error;
}

function getReviewProvider(): LlmProvider | null {
  if (!reviewConfig.enabled || !reviewConfig.apiKey) return null;
  if (!reviewConfig.provider || !reviewConfig.model) {
    console.error("[review] review.provider and review.model must be configured in pipe.json");
    return null;
  }
  if (!reviewProvider) {
    if (reviewConfig.provider === "gemini") {
      reviewProvider = createGeminiProvider({
        apiKey: reviewConfig.apiKey,
        model: reviewConfig.model,
      });
    } else {
      console.error(`[review] unknown provider: ${reviewConfig.provider}`);
      return null;
    }
  }
  return reviewProvider;
}

/**
 * Process intent through dual-path pipeline.
 * actionable=true: dedup → review(optional) → reminders+notify
 * noteworthy=true: dedup → review(optional) → apple notes
 */
function mergeNotifySummary(target: NotifyResult, extra: NotifyResult): void {
  target.desktop = target.desktop || extra.desktop;

  for (const webhook of extra.webhooks) {
    if (!target.webhooks.includes(webhook)) {
      target.webhooks.push(webhook);
    }
  }

  target.remindersSynced = target.remindersSynced || extra.remindersSynced;
  target.notesSynced = target.notesSynced || extra.notesSynced;

  for (const err of extra.errors) {
    target.errors.push(err);
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function processIntent(
  intent: IntentResult,
  logger: PipelineLogger,
  context?: ReviewContext,
): Promise<void> {
  if (!intent.actionable && !intent.noteworthy) {
    logger.intentSkip("neither actionable nor noteworthy");
    return;
  }

  const sourceApp = context?.sourceApp || "unknown";
  const provider = getReviewProvider();
  const notifySummary: NotifyResult = {
    desktop: false,
    webhooks: [],
    errors: [],
  };

  logger.info("③ DEDUP   正在进行");
  const actionableDedup = intent.actionable ? checkActionableDedup(intent) : null;
  const noteworthyDedup = intent.noteworthy ? checkNoteworthyDedup(intent) : null;

  const primaryDedup = actionableDedup?.passed
    ? actionableDedup
    : noteworthyDedup?.passed
      ? noteworthyDedup
      : actionableDedup ?? noteworthyDedup;
  if (primaryDedup) {
    logger.dedup(primaryDedup);
  }

  if (actionableDedup && noteworthyDedup) {
    const secondaryLabel = primaryDedup === actionableDedup ? "noteworthy" : "actionable";
    const secondary = primaryDedup === actionableDedup ? noteworthyDedup : actionableDedup;
    const secondaryStatus = secondary.passed
      ? `✓ passed (${secondary.cacheSize ?? "?"} entries)`
      : `✗ duplicate (${secondary.similarity != null ? `${(secondary.similarity * 100).toFixed(0)}% match` : secondary.reason})`;
    logger.info(`③ DEDUP   ${secondaryLabel} ${secondaryStatus}`);
  }

  const actionableCandidate = actionableDedup?.passed ?? false;
  const noteworthyCandidate = noteworthyDedup?.passed ?? false;
  logger.info("③ DEDUP   已完成");

  if (!actionableCandidate && !noteworthyCandidate) {
    return;
  }

  if (!provider) {
    logger.reviewSkipped();

    if (actionableCandidate) {
      logger.info("⑤ EXECUTE actionable 正在进行");
      const record = await recordAndNotify(intent);
      notifySummary.remindersSynced = record.remindersSynced;
      if (record.reminderError) {
        notifySummary.errors.push(`reminders: ${record.reminderError}`);
      }
      const delivery = await sendNotification(intent);
      mergeNotifySummary(notifySummary, delivery);
      logger.info("⑤ EXECUTE actionable 已完成");
    }

    if (noteworthyCandidate) {
      logger.info("⑤ EXECUTE noteworthy 正在进行");
      const note = await recordNoteworthy(intent, sourceApp);
      notifySummary.notesSynced = note.notesSynced;
      if (note.notesError) {
        notifySummary.errors.push(`notes: ${note.notesError}`);
      }
      logger.info("⑤ EXECUTE noteworthy 已完成");
    }

    logger.notify(notifySummary);
    return;
  }

  const reviewInput: IntentResult = {
    ...intent,
    actionable: actionableCandidate,
    noteworthy: noteworthyCandidate,
  };

  try {
    logger.info("④ REVIEW  正在进行");
    const reviewedOutcome = await reviewIntent(provider, reviewInput, context);
    reviewedOutcome.review.source = `external:${reviewConfig.provider ?? "model"}${reviewConfig.model ? `/${reviewConfig.model}` : ""}`;
    logger.review(reviewedOutcome.review);
    logger.info("④ REVIEW  已完成");

    const reviewed = reviewedOutcome.intent;
    if (!reviewed || (!reviewed.actionable && !reviewed.noteworthy)) {
      return;
    }

    if (reviewed.actionable) {
      logger.info("⑤ EXECUTE actionable 正在进行");
      const record = await recordAndNotify(reviewed);
      notifySummary.remindersSynced = record.remindersSynced;
      if (record.reminderError) {
        notifySummary.errors.push(`reminders: ${record.reminderError}`);
      }
      const delivery = await sendNotification(reviewed);
      mergeNotifySummary(notifySummary, delivery);
      logger.info("⑤ EXECUTE actionable 已完成");
    }

    if (reviewed.noteworthy) {
      logger.info("⑤ EXECUTE noteworthy 正在进行");
      const note = await recordNoteworthy(reviewed, sourceApp);
      notifySummary.notesSynced = note.notesSynced;
      if (note.notesError) {
        notifySummary.errors.push(`notes: ${note.notesError}`);
      }
      logger.info("⑤ EXECUTE noteworthy 已完成");
    }

    logger.notify(notifySummary);
  } catch (error) {
    const message = getErrorMessage(error);
    debugError("[poll] review error:", error);
    logger.info(`④ REVIEW  error: ${message}`);

    if (!reviewConfig.failOpen) {
      return;
    }

    logger.info("④ REVIEW  failOpen: pass-through");

    if (reviewInput.actionable) {
      logger.info("⑤ EXECUTE actionable 正在进行");
      const record = await recordAndNotify(reviewInput);
      notifySummary.remindersSynced = record.remindersSynced;
      if (record.reminderError) {
        notifySummary.errors.push(`reminders: ${record.reminderError}`);
      }
      const delivery = await sendNotification(reviewInput);
      mergeNotifySummary(notifySummary, delivery);
      logger.info("⑤ EXECUTE actionable 已完成");
    }

    if (reviewInput.noteworthy) {
      logger.info("⑤ EXECUTE noteworthy 正在进行");
      const note = await recordNoteworthy(reviewInput, sourceApp);
      notifySummary.notesSynced = note.notesSynced;
      if (note.notesError) {
        notifySummary.errors.push(`notes: ${note.notesError}`);
      }
      logger.info("⑤ EXECUTE noteworthy 已完成");
    }

    logger.notify(notifySummary);
  }
}

function isAppAllowed(appName: string): boolean {
  if (allowedAppsLower.size === 0) return true; // no whitelist = allow all
  if (!appName || appName.toLowerCase() === "unknown") return true; // unknown app = allow
  return allowedAppsLower.has(appName.toLowerCase());
}

function isWindowBlocked(windowName: string): boolean {
  const lower = (windowName || "").toLowerCase();
  return blockedWindowsLower.some(b => lower.includes(b));
}

function deduplicateTexts(entries: { text: string; app: string }[]): { text: string; app: string }[] {
  const seen: string[] = [];
  const result: { text: string; app: string }[] = [];
  for (const entry of entries) {
    // Simple dedup: skip if >80% overlap with any already-seen text
    const dominated = seen.some(prev => {
      const shorter = Math.min(prev.length, entry.text.length);
      const longer = Math.max(prev.length, entry.text.length);
      if (shorter / longer < 0.5) return false; // very different lengths
      // Check prefix overlap as a fast heuristic
      let common = 0;
      for (let i = 0; i < shorter; i++) {
        if (prev[i] === entry.text[i]) common++;
      }
      return common / longer > 0.8;
    });
    if (!dominated) {
      seen.push(entry.text);
      result.push(entry);
    }
  }
  return result;
}

function appendLog(entry: object) {
  try {
    if (!existsSync(LOG_DIR)) {
      mkdirSync(LOG_DIR, { recursive: true });
    }
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n";
    writeFileSync(LOG_FILE, line, { flag: "a" });
  } catch (e) {
    console.error("[log] write error:", e);
  }
}

/**
 * Extract a short snippet (~120 chars) from raw OCR texts that is most relevant
 * to the intent content. Searches for overlapping keywords, returns surrounding context.
 */
function extractSnippet(texts: string[], contentHint: string): string {
  const combined = texts.join(" ").replace(/\s+/g, " ");
  if (combined.length <= 120) return combined;

  // Extract keywords (>=2 chars) from the intent content to locate relevant region
  const keywords = contentHint.match(/[\u4e00-\u9fff]{2,}|[a-zA-Z]{3,}|\d{2,}/g) || [];

  let bestPos = 0;
  let bestScore = 0;
  for (let i = 0; i < combined.length - 60; i += 20) {
    const window = combined.substring(i, i + 120);
    let score = 0;
    for (const kw of keywords) {
      if (window.includes(kw)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      bestPos = i;
    }
  }

  const start = Math.max(0, bestPos);
  const snippet = combined.substring(start, start + 120).trim();
  return snippet + (start + 120 < combined.length ? "..." : "");
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function changeRatio(a: string, b: string): number {
  if (a === b) return 0;
  if (!a || !b) return 1;
  const linesA = new Set(a.split(/\n/).map((l) => l.trim()).filter(Boolean));
  const linesB = new Set(b.split(/\n/).map((l) => l.trim()).filter(Boolean));
  let same = 0;
  for (const line of linesA) {
    if (linesB.has(line)) same++;
  }
  const total = Math.max(linesA.size, linesB.size, 1);
  return 1 - same / total;
}

const MIN_CHANGE_RATIO = 0.15;

type ChangeDecision = {
  changedText: string | null;
  ratio: number;
  reason: "empty" | "same" | "below-threshold" | "changed";
};

function detectChange(newText: string): ChangeDecision {
  const trimmed = newText.trim();
  if (!trimmed) {
    return { changedText: null, ratio: 0, reason: "empty" };
  }
  if (trimmed === lastText) {
    return { changedText: null, ratio: 0, reason: "same" };
  }

  const ratio = changeRatio(lastText, trimmed);
  if (ratio < MIN_CHANGE_RATIO) {
    lastText = trimmed;
    return { changedText: null, ratio, reason: "below-threshold" };
  }

  lastText = trimmed;
  return { changedText: trimmed, ratio, reason: "changed" };
}

/**
 * Fetch OCR data, filter, and return texts+apps. Shared by polling loop and triggerOnce.
 */
type FetchAndFilterResult = {
  texts: string[];
  apps: Set<string>;
  totalItems: number;
  skippedApp: number;
  skippedWindow: number;
  skippedShort: number;
  skippedDedup: number;
  skippedTime: number;
  chars: number;
};

async function fetchAndFilter(lookbackMs: number): Promise<FetchAndFilterResult> {
  const now = Date.now();
  const startMs = now - lookbackMs;
  const endMs = now;
  const startTime = new Date(now - lookbackMs).toISOString();
  const endTime = new Date(now).toISOString();

  const query = {
    contentType: "ocr" as const,
    limit: 10,
    startTime,
    endTime,
  };
  debugLog(`[query] pipe.queryScreenpipe(${JSON.stringify(query)})`);

  const result = await pipe.queryScreenpipe(query);

  debugLog(`[query] response: ${result?.data?.length ?? 0} items, pagination=${JSON.stringify(result?.pagination)}`);

  appendLog({ query, response: result });

  const totalItems = result?.data?.length ?? 0;

  const candidates: { text: string; app: string }[] = [];
  let skippedApp = 0, skippedWindow = 0, skippedShort = 0, skippedTime = 0;

  for (const item of result?.data ?? []) {
    if (item.type !== "OCR") continue;
    const text = item.content.text;
    const app = item.content.appName ?? "unknown";
    const windowName = item.content.windowName ?? "";
    const rawTs = item.content.timestamp;

    if (!text) continue;
    if (rawTs) {
      const ts = new Date(rawTs).getTime();
      if (
        Number.isFinite(ts)
        && (ts < startMs - TIMESTAMP_SKEW_TOLERANCE_MS || ts > endMs + TIMESTAMP_SKEW_TOLERANCE_MS)
      ) {
        skippedTime++;
        continue;
      }
    }

    if (!isAppAllowed(app)) { skippedApp++; continue; }
    if (isWindowBlocked(windowName)) { skippedWindow++; continue; }
    if (text.length < filterConfig.minTextLength) { skippedShort++; continue; }

    candidates.push({ text, app });
  }

  const unique = deduplicateTexts(candidates);
  const texts = unique.map(e => e.text);
  const apps = new Set(unique.map(e => e.app));
  const skippedDedup = candidates.length - unique.length;
  const chars = texts.reduce((sum, text) => sum + text.length, 0);

  return {
    texts,
    apps,
    totalItems,
    skippedApp,
    skippedWindow,
    skippedShort,
    skippedDedup,
    skippedTime,
    chars,
  };
}

/**
 * One-shot capture + intent detection, called by /api/trigger (hotkey mode).
 * Grabs the latest Screenpipe OCR frame directly — no time window needed.
 */
export async function triggerOnce(): Promise<{ triggered: boolean; intent?: any }> {
  const logger = new PipelineLogger("hotkey", ++hotkeySeq);
  debugLog("[trigger] hotkey-triggered capture starting...");

  try {
    // Grab the most recent OCR data — Screenpipe runs at 0.5 FPS so there's always a recent frame
    const query = {
      contentType: "ocr" as const,
      limit: 5,
      startTime: new Date(Date.now() - 300_000).toISOString(), // last 5 min as safety net
      endTime: new Date().toISOString(),
    };
    debugLog("[trigger] querying latest OCR frames...");
    const result = await pipe.queryScreenpipe(query);

    if (!result?.data?.length) {
      logger.skip("no data");
      return { triggered: false };
    }

    // Filter and deduplicate
    const candidates: { text: string; app: string }[] = [];
    let skippedApp = 0;
    let skippedWindow = 0;
    let skippedShort = 0;

    for (const item of result.data) {
      if (item.type !== "OCR") continue;
      const text = item.content.text;
      const app = item.content.appName ?? "unknown";
      const windowName = item.content.windowName ?? "";
      if (!text || text.length < filterConfig.minTextLength) {
        skippedShort++;
        continue;
      }
      if (!isAppAllowed(app)) {
        skippedApp++;
        continue;
      }
      if (isWindowBlocked(windowName)) {
        skippedWindow++;
        continue;
      }
      candidates.push({ text, app });
    }

    const unique = deduplicateTexts(candidates);
    const texts = unique.map(e => e.text);
    const apps = new Set(unique.map(e => e.app));
    const chars = texts.reduce((sum, text) => sum + text.length, 0);

    logger.fetch({
      totalItems: result.data.length,
      keptItems: texts.length,
      apps: [...apps],
      chars,
      skippedApp,
      skippedWindow,
      skippedShort,
      skippedDedup: candidates.length - unique.length,
    });

    if (unique.length === 0) {
      logger.info("② FETCH   all items filtered — skipped");
      logger.flush();
      return { triggered: false };
    }

    const batch = {
      texts,
      apps,
      startTime: Date.now(),
      endTime: Date.now(),
    };

    logger.info("② INTENT  正在识别");
    const intent = await detectIntent(batch, { hotkeyTriggered: true });

    if (!intent) {
      logger.intentSkip("detector failed");
      logger.flush();
      return { triggered: true };
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
        sourceApp: [...apps].join(", "),
        trigger: "hotkey",
        textSnippet: extractSnippet(texts, intent.content),
        language: outputLanguage,
      };
      await processIntent(intent, logger, reviewCtx);
    } else {
      logger.intentSkip("neither actionable nor noteworthy");
    }

    logger.flush();
    return { triggered: true, intent };
  } catch (error) {
    logger.info(`error: ${getErrorMessage(error)}`);
    logger.flush();
    debugError("[trigger] error:", error);
    return { triggered: false };
  }
}

async function runPipeline() {
  if (isRunning) {
    console.log("[pipeline] already running, skipping");
    return;
  }

  isRunning = true;

  console.log(`[pipeline] capture mode: ${captureConfig.mode}`);

  // In hotkey-only mode, don't start the polling loop
  if (captureConfig.mode === "hotkey") {
    console.log("[pipeline] hotkey-only mode — polling disabled, waiting for /api/trigger");
    // Keep isRunning true so the pipeline is considered "active"
    return;
  }

  console.log(
    `[pipeline] started — poll every ${(POLL_INTERVAL_MS / 1000).toFixed(1)}s, lookback ${(LOOKBACK_MS / 1000).toFixed(1)}s`
  );
  console.log(`[pipeline] timestamp skew tolerance ${(TIMESTAMP_SKEW_TOLERANCE_MS / 1000).toFixed(1)}s`);
  console.log(`[pipeline] filter: ${allowedAppsLower.size} allowed apps, minText=${filterConfig.minTextLength}, blockedWindows=[${filterConfig.blockedWindows.join(", ")}]`);

  try {
    while (true) {
      const logger = new PipelineLogger("poll", ++pollSeq);

      try {
        const data = await fetchAndFilter(LOOKBACK_MS);

        if (data.totalItems === 0) {
          noDataCount++;
          logger.skip(`no data (×${noDataCount})`);
          await sleep(POLL_INTERVAL_MS);
          continue;
        }

        noDataCount = 0;
        logger.fetch({
          totalItems: data.totalItems,
          keptItems: data.texts.length,
          apps: [...data.apps],
          chars: data.chars,
          skippedApp: data.skippedApp,
          skippedWindow: data.skippedWindow,
          skippedShort: data.skippedShort,
          skippedDedup: data.skippedDedup,
          skippedTime: data.skippedTime,
        });

        if (data.texts.length === 0) {
          logger.info("② FETCH   all items filtered — skipped");
          logger.flush();
          await sleep(POLL_INTERVAL_MS);
          continue;
        }

        const combined = data.texts.join("\n");

        const change = detectChange(combined);
        if (!change.changedText) {
          if (change.reason === "below-threshold") {
            logger.noChange(change.ratio);
            logger.flush();
          } else if (change.reason === "same") {
            logger.skip("no change");
          } else {
            logger.skip("empty text");
          }
          await sleep(POLL_INTERVAL_MS);
          continue;
        }

        const batch = {
          texts: data.texts,
          apps: data.apps,
          startTime: Date.now(),
          endTime: Date.now(),
        };

        logger.info("② INTENT  正在识别");
        const intent = await detectIntent(batch);

        if (!intent) {
          logger.intentSkip("detector failed");
          logger.flush();
        } else {
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
              sourceApp: [...data.apps].join(", "),
              trigger: "poll",
              textSnippet: extractSnippet(data.texts, intent.content),
              language: outputLanguage,
            };
            await processIntent(intent, logger, reviewCtx);
          } else {
            logger.intentSkip("neither actionable nor noteworthy");
          }
          logger.flush();
        }
      } catch (error) {
        logger.info(`error: ${getErrorMessage(error)}`);
        logger.flush();
        debugError("[poll] error:", error);
      }

      await sleep(POLL_INTERVAL_MS);
    }
  } finally {
    isRunning = false;
    console.log("[pipeline] stopped");
  }
}

export function startPipeline() {
  if (isRunning) {
    console.log("[pipeline] already running");
    return;
  }
  setupConfigWatcher();
  console.log("[auto-start] Starting pipeline...");
  loadRawFromFile();
  loadMemoRawFromFile();
  loadTasksFromFile();
  logEffectiveConfig();
  if (reviewConfig.enabled && reviewConfig.apiKey) {
    console.log(`[pipeline] review enabled: provider=${reviewConfig.provider}, model=${reviewConfig.model}`);
  } else {
    console.log("[pipeline] review disabled");
  }
  runPipeline().catch((err) =>
    console.error("[pipeline] unhandled error:", err)
  );
}

export function isPipelineRunning() {
  return isRunning;
}

export function getPipelineStatusSnapshot() {
  return {
    running: isRunning,
    message: isRunning
      ? "Pipeline is running (managed by dev script)"
      : "Pipeline is not running — start with `bun run dev`",
    effectiveConfig: getEffectiveConfigSnapshot(),
    configUpdate: getLastPipeConfigEvent(),
  };
}
