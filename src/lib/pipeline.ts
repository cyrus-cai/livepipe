import { pipe } from "@screenpipe/js";
import { detectIntent } from "@/lib/intent-detector";
import { shouldNotify, shouldProcess, recordAndNotify, loadTasksFromFile, loadRawFromFile } from "@/lib/deduplication";
import { sendNotification } from "@/lib/notifier";
import { reviewIntent, type ReviewContext } from "@/lib/review";
import { createGeminiProvider } from "@/lib/providers/gemini";
import type { LlmProvider } from "@/lib/llm-provider";
import type { IntentResult } from "@/lib/schemas";
import { writeFileSync, readFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

let POLL_INTERVAL_MS = 35_000;
let LOOKBACK_MS = 60_000;

let isRunning = false;
let lastText = "";
let noDataCount = 0;
let isFirstPoll = true;

const LOG_DIR = join(process.cwd(), "logs");
const LOG_FILE = join(LOG_DIR, "screenpipe-raw.jsonl");
const CONFIG_FILE = join(process.cwd(), "pipe.json");

export type CaptureMode = "always" | "hotkey" | "both";

interface FilterConfig {
  allowedApps: string[];
  blockedWindows: string[];
  minTextLength: number;
}

interface CaptureConfig {
  mode: CaptureMode;
  hotkeyHoldMs: number;
}

function loadFilterConfig(): FilterConfig {
  const defaults: FilterConfig = {
    allowedApps: [],
    blockedWindows: ["livepipe", "opencode", "screenpipe"],
    minTextLength: 20,
  };
  try {
    const raw = readFileSync(CONFIG_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    return { ...defaults, ...parsed.filter };
  } catch {
    console.log("[config] no pipe.json found or missing filter section, using defaults (no app filter)");
    return defaults;
  }
}

function loadCaptureConfig(): CaptureConfig {
  const defaults: CaptureConfig = { mode: "always", hotkeyHoldMs: 500 };
  try {
    const raw = readFileSync(CONFIG_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    return { ...defaults, ...parsed.capture };
  } catch {
    return defaults;
  }
}

interface ReviewConfig {
  enabled: boolean;
  provider: string;
  model: string;
  apiKey: string;
  failOpen: boolean;
}

function loadReviewConfig(): ReviewConfig {
  const defaults: ReviewConfig = {
    enabled: false,
    provider: "",
    model: "",
    apiKey: "",
    failOpen: true,
  };
  try {
    const raw = readFileSync(CONFIG_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    return { ...defaults, ...parsed.review };
  } catch {
    return defaults;
  }
}

function loadOutputLanguage(): string {
  try {
    const raw = readFileSync(CONFIG_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    return parsed.outputLanguage || "zh-CN";
  } catch {
    return "zh-CN";
  }
}

const captureConfig = loadCaptureConfig();
const filterConfig = loadFilterConfig();
const reviewConfig = loadReviewConfig();
const outputLanguage = loadOutputLanguage();

let reviewProvider: LlmProvider | null = null;

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
 * Process an actionable intent through the review pipeline.
 * When review is enabled: shouldProcess (dedup) → Gemini review → recordAndNotify → notify
 * When review is disabled: shouldNotify (dedup + record) → notify
 */
async function processIntent(intent: IntentResult, context?: ReviewContext): Promise<void> {
  if (!intent.actionable) {
    console.log("[poll] not actionable");
    return;
  }

  const provider = getReviewProvider();

  if (!provider) {
    // Review not enabled — use legacy path (dedup + record combined)
    if (shouldNotify(intent)) {
      console.log(`[poll] ACTIONABLE: type=${intent.type}, content="${intent.content}", due=${intent.due_time}`);
      await sendNotification(intent);
    } else {
      console.log("[poll] duplicate, skipped");
    }
    return;
  }

  // Review enabled — two-layer flow
  if (!shouldProcess(intent)) {
    console.log("[poll] duplicate (raw), skipped review");
    return;
  }

  try {
    const reviewed = await reviewIntent(provider, intent, context);
    if (!reviewed || !reviewed.actionable) {
      console.log("[poll] review rejected");
      return;
    }

    recordAndNotify(reviewed);
    console.log(`[poll] REVIEWED & ACTIONABLE: type=${reviewed.type}, content="${reviewed.content}", due=${reviewed.due_time}`);
    await sendNotification(reviewed);
  } catch (err) {
    console.error("[poll] review error:", err);
    if (reviewConfig.failOpen) {
      console.log("[poll] failOpen: passing through without review");
      recordAndNotify(intent);
      await sendNotification(intent);
    }
  }
}

// Lowercase sets for case-insensitive matching
const allowedAppsLower = new Set(filterConfig.allowedApps.map(a => a.toLowerCase()));
const blockedWindowsLower = filterConfig.blockedWindows.map(w => w.toLowerCase());

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

function detectChange(newText: string): string | null {
  const trimmed = newText.trim();
  if (!trimmed) return null;
  if (trimmed === lastText) return null;

  const ratio = changeRatio(lastText, trimmed);
  if (ratio < MIN_CHANGE_RATIO) {
    console.log(`[poll] change ${(ratio * 100).toFixed(0)}% < ${MIN_CHANGE_RATIO * 100}% threshold, skip`);
    lastText = trimmed;
    return null;
  }

  console.log(`[poll] change ${(ratio * 100).toFixed(0)}%, ${trimmed.length} chars`);
  lastText = trimmed;
  return trimmed;
}

async function detectScreenpipeInterval(): Promise<number> {
  try {
    console.log("[detect] Analyzing Screenpipe OCR interval...");

    const result = await pipe.queryScreenpipe({
      contentType: "ocr",
      limit: 100,
      startTime: new Date(Date.now() - 300_000).toISOString(),
      endTime: new Date().toISOString(),
    });

    if (!result?.data || result.data.length < 3) {
      console.log("[detect] Not enough data, using default 30s interval");
      return 30_000;
    }

    const timestamps: number[] = [];
    for (const item of result.data) {
      if (item.type === "OCR" && item.content.timestamp) {
        timestamps.push(new Date(item.content.timestamp).getTime());
      }
    }

    if (timestamps.length < 3) {
      console.log("[detect] Not enough timestamps, using default 30s interval");
      return 30_000;
    }

    timestamps.sort((a, b) => a - b);

    const intervals: number[] = [];
    for (let i = 1; i < timestamps.length; i++) {
      const interval = timestamps[i] - timestamps[i - 1];
      if (interval > 1000 && interval < 120_000) {
        intervals.push(interval);
      }
    }

    if (intervals.length === 0) {
      console.log("[detect] No valid intervals, using default 30s");
      return 30_000;
    }

    intervals.sort((a, b) => a - b);
    const median = intervals[Math.floor(intervals.length / 2)];

    console.log(`[detect] Screenpipe captures every ~${(median / 1000).toFixed(0)}s`);
    return median;
  } catch (error) {
    console.error("[detect] Error detecting interval:", error);
    return 30_000;
  }
}

/**
 * Fetch OCR data, filter, and return texts+apps. Shared by polling loop and triggerOnce.
 */
async function fetchAndFilter(lookbackMs: number): Promise<{ texts: string[]; apps: Set<string> } | null> {
  const now = Date.now();
  const startTime = new Date(now - lookbackMs).toISOString();
  const endTime = new Date(now).toISOString();

  const query = {
    contentType: "ocr" as const,
    limit: 10,
    startTime,
    endTime,
  };
  console.log(`[query] pipe.queryScreenpipe(${JSON.stringify(query, null, 2)})`);

  const result = await pipe.queryScreenpipe(query);

  console.log(`[query] response: ${result?.data?.length ?? 0} items, pagination=${JSON.stringify(result?.pagination)}`);

  appendLog({ query, response: result });

  if (!result?.data?.length) {
    return null;
  }

  const candidates: { text: string; app: string }[] = [];
  let skippedApp = 0, skippedWindow = 0, skippedShort = 0;

  for (const item of result.data) {
    if (item.type !== "OCR") continue;
    const text = item.content.text;
    const app = item.content.appName ?? "unknown";
    const windowName = item.content.windowName ?? "";

    if (!text) continue;

    if (!isAppAllowed(app)) { skippedApp++; continue; }
    if (isWindowBlocked(windowName)) { skippedWindow++; continue; }
    if (text.length < filterConfig.minTextLength) { skippedShort++; continue; }

    candidates.push({ text, app });
  }

  const unique = deduplicateTexts(candidates);
  const texts = unique.map(e => e.text);
  const apps = new Set(unique.map(e => e.app));

  console.log(`[poll] fetched ${result.data.length} items → ${texts.length} kept (app:−${skippedApp} window:−${skippedWindow} short:−${skippedShort} dedup:−${candidates.length - unique.length}), apps=[${[...apps].join(", ")}]`);

  if (texts.length === 0) return null;
  return { texts, apps };
}

/**
 * One-shot capture + intent detection, called by /api/trigger (hotkey mode).
 * Grabs the latest Screenpipe OCR frame directly — no time window needed.
 */
export async function triggerOnce(): Promise<{ triggered: boolean; intent?: any }> {
  console.log("[trigger] hotkey-triggered capture starting...");

  try {
    // Grab the most recent OCR data — Screenpipe runs at 0.5 FPS so there's always a recent frame
    const query = {
      contentType: "ocr" as const,
      limit: 5,
      startTime: new Date(Date.now() - 300_000).toISOString(), // last 5 min as safety net
      endTime: new Date().toISOString(),
    };
    console.log(`[trigger] querying latest OCR frames...`);
    const result = await pipe.queryScreenpipe(query);

    if (!result?.data?.length) {
      console.log("[trigger] no OCR data available from Screenpipe");
      return { triggered: false };
    }

    // Filter and deduplicate
    const candidates: { text: string; app: string }[] = [];
    for (const item of result.data) {
      if (item.type !== "OCR") continue;
      const text = item.content.text;
      const app = item.content.appName ?? "unknown";
      const windowName = item.content.windowName ?? "";
      if (!text || text.length < filterConfig.minTextLength) continue;
      if (!isAppAllowed(app)) continue;
      if (isWindowBlocked(windowName)) continue;
      candidates.push({ text, app });
    }

    const unique = deduplicateTexts(candidates);
    if (unique.length === 0) {
      console.log(`[trigger] ${result.data.length} frames fetched but all filtered out`);
      return { triggered: false };
    }

    const texts = unique.map(e => e.text);
    const apps = new Set(unique.map(e => e.app));
    console.log(`[trigger] got ${texts.length} texts from [${[...apps].join(", ")}]`);

    const batch = {
      texts,
      apps,
      startTime: Date.now(),
      endTime: Date.now(),
    };

    const intent = await detectIntent(batch, { hotkeyTriggered: true });

    if (!intent) {
      console.log("[trigger] intent detection returned null");
      return { triggered: true };
    }

    if (intent.actionable) {
      const reviewCtx: ReviewContext = {
        sourceApp: [...apps].join(", "),
        trigger: "hotkey",
        textSnippet: extractSnippet(texts, intent.content),
        language: outputLanguage,
      };
      await processIntent(intent, reviewCtx);
    } else {
      console.log("[trigger] not actionable");
    }

    return { triggered: true, intent };
  } catch (error) {
    console.error("[trigger] error:", error);
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

  const detectedInterval = await detectScreenpipeInterval();
  POLL_INTERVAL_MS = detectedInterval + 5000;
  LOOKBACK_MS = detectedInterval * 2;

  console.log(`[pipeline] started — poll every ${POLL_INTERVAL_MS / 1000}s, lookback ${LOOKBACK_MS / 1000}s`);
  console.log(`[pipeline] filter: ${allowedAppsLower.size} allowed apps, minText=${filterConfig.minTextLength}, blockedWindows=[${filterConfig.blockedWindows.join(", ")}]`);

  try {
    while (true) {
      try {
        const data = await fetchAndFilter(LOOKBACK_MS);

        if (!data) {
          noDataCount++;
          console.log(`[poll] no OCR data in last ${LOOKBACK_MS / 1000}s (×${noDataCount})`);
          await sleep(POLL_INTERVAL_MS);
          continue;
        }

        noDataCount = 0;

        const combined = data.texts.join("\n");

        // First poll: just set baseline, don't process stale screenpipe data
        if (isFirstPoll) {
          isFirstPoll = false;
          lastText = combined.trim();
          console.log(`[poll] first poll — set baseline (${lastText.length} chars), skipping`);
          await sleep(POLL_INTERVAL_MS);
          continue;
        }

        const changed = detectChange(combined);

        if (!changed) {
          await sleep(POLL_INTERVAL_MS);
          continue;
        }

        const batch = {
          texts: data.texts,
          apps: data.apps,
          startTime: Date.now(),
          endTime: Date.now(),
        };

        const intent = await detectIntent(batch);

        if (!intent) {
          console.log("[poll] intent detection returned null");
        } else if (intent.actionable) {
          const reviewCtx: ReviewContext = {
            sourceApp: [...data.apps].join(", "),
            trigger: "poll",
            textSnippet: extractSnippet(data.texts, intent.content),
            language: outputLanguage,
          };
          await processIntent(intent, reviewCtx);
        } else {
          console.log("[poll] not actionable");
        }
      } catch (error) {
        console.error("[poll] error:", error);
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
  console.log("[auto-start] Starting pipeline...");
  loadRawFromFile();
  loadTasksFromFile();
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
