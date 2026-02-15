import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { IntentResult } from "./schemas";
import { syncTaskToReminders } from "./apple-reminders";
import { syncMemoToAppleNotes } from "./apple-notes";
import { getPipeConfig } from "./pipe-config";

const DEFAULT_ACTIONABLE_THRESHOLD = 0.6;
const DEFAULT_NOTEWORTHY_THRESHOLD = 0.8;
const DEFAULT_LOOKBACK_DAYS = 7;
const TASKS_DIR = join(homedir(), ".livepipe");
const TASKS_FILE = join(TASKS_DIR, "tasks.md");
const TASKS_RAW_FILE = join(TASKS_DIR, "tasks-raw.md");
const MEMOS_RAW_FILE = join(TASKS_DIR, "memos-raw.md");

interface TaskEntry {
  content: string;
  urgent: boolean;
  dueTime: string | null;
  detected: string;
  completed: boolean;
}

/** Simplified raw entry for dedup-only storage */
interface RawEntry {
  content: string;
  detected: string;
}

interface DedupRuntimeConfig {
  actionableThreshold: number;
  noteworthyThreshold: number;
  lookbackDays: number;
}

// === Caches ===

let taskCache: TaskEntry[] = [];
let actionableRawCache: RawEntry[] = [];
let noteworthyRawCache: RawEntry[] = [];
let taskInitialized = false;
let actionableRawInitialized = false;
let noteworthyRawInitialized = false;

function getDedupRuntimeConfig(): DedupRuntimeConfig {
  try {
    const config = getPipeConfig().dedup;
    return {
      actionableThreshold: config.actionableThreshold,
      noteworthyThreshold: config.noteworthyThreshold,
      lookbackDays: config.lookbackDays,
    };
  } catch (error) {
    console.error("[dedup] failed to read dedup config, fallback to defaults:", error);
    return {
      actionableThreshold: DEFAULT_ACTIONABLE_THRESHOLD,
      noteworthyThreshold: DEFAULT_NOTEWORTHY_THRESHOLD,
      lookbackDays: DEFAULT_LOOKBACK_DAYS,
    };
  }
}

// === Shared utilities ===

/**
 * Character bigram overlap (Dice coefficient) — fast and effective for short text.
 */
export function similarity(a: string, b: string): number {
  const la = a.length;
  const lb = b.length;
  if (la === 0 && lb === 0) return 1;
  if (la === 0 || lb === 0) return 0;

  if (Math.abs(la - lb) / Math.max(la, lb) > 0.5) return 0;

  const na = a.toLowerCase().replace(/\s+/g, " ").trim();
  const nb = b.toLowerCase().replace(/\s+/g, " ").trim();

  if (na === nb) return 1;

  const bigramsA = new Set<string>();
  for (let i = 0; i < na.length - 1; i++) bigramsA.add(na.slice(i, i + 2));
  const bigramsB = new Set<string>();
  for (let i = 0; i < nb.length - 1; i++) bigramsB.add(nb.slice(i, i + 2));

  let intersection = 0;
  for (const bg of bigramsA) {
    if (bigramsB.has(bg)) intersection++;
  }

  return (2 * intersection) / (bigramsA.size + bigramsB.size);
}

// === raw dedup files ===

function parseRawLine(line: string): RawEntry | null {
  const legacy = line.match(/^(.+?)\s*\|\s*type:\w+\s*\|\s*detected:(\S+)$/);
  if (legacy) {
    return {
      content: legacy[1].trim(),
      detected: legacy[2],
    };
  }

  const modern = line.match(/^(.+?)\s*\|\s*detected:(\S+)$/);
  if (!modern) return null;
  return {
    content: modern[1].trim(),
    detected: modern[2],
  };
}

function formatRawLine(entry: RawEntry): string {
  return `${entry.content} | detected:${entry.detected}`;
}

function loadRawEntries(file: string, cacheTarget: "actionable" | "noteworthy"): void {
  const cache = cacheTarget === "actionable" ? actionableRawCache : noteworthyRawCache;
  cache.length = 0;

  if (!existsSync(file)) {
    if (cacheTarget === "actionable") actionableRawInitialized = true;
    if (cacheTarget === "noteworthy") noteworthyRawInitialized = true;
    return;
  }

  try {
    const raw = readFileSync(file, "utf-8");
    for (const line of raw.split("\n")) {
      const entry = parseRawLine(line.trim());
      if (entry) cache.push(entry);
    }
    console.log(`[dedup-raw-${cacheTarget}] loaded ${cache.length} entries from ${file}`);
  } catch (err) {
    console.error(`[dedup-raw-${cacheTarget}] failed to read ${file}:`, err);
  }

  if (cacheTarget === "actionable") actionableRawInitialized = true;
  if (cacheTarget === "noteworthy") noteworthyRawInitialized = true;
}

function appendRawToFile(file: string, entry: RawEntry): void {
  mkdirSync(TASKS_DIR, { recursive: true });
  // Ensure file ends with newline before appending to prevent line concatenation
  let prefix = "";
  if (existsSync(file)) {
    const existing = readFileSync(file, "utf-8");
    if (existing.length > 0 && !existing.endsWith("\n")) {
      prefix = "\n";
    }
  }
  const line = prefix + formatRawLine(entry) + "\n";
  writeFileSync(file, line, { flag: "a" });
}

function shouldProcessInRawCache(
  content: string,
  mode: "actionable" | "noteworthy",
): boolean {
  const dedupConfig = getDedupRuntimeConfig();
  const threshold = mode === "actionable"
    ? dedupConfig.actionableThreshold
    : dedupConfig.noteworthyThreshold;

  const cache = mode === "actionable" ? actionableRawCache : noteworthyRawCache;
  const rawFile = mode === "actionable" ? TASKS_RAW_FILE : MEMOS_RAW_FILE;

  const now = new Date();
  const cutoff = new Date(now.getTime() - dedupConfig.lookbackDays * 24 * 60 * 60 * 1000);
  const cutoffStr = cutoff.toISOString();

  console.log(`[dedup-raw-${mode}] checking "${content.substring(0, 60)}" against ${cache.length} entries (cutoff=${cutoffStr.substring(0, 10)})`);

  for (const entry of cache) {
    if (entry.detected < cutoffStr) continue;

    const sim = similarity(content, entry.content);
    if (sim >= threshold) {
      console.log(
        `[dedup-raw-${mode}] skipping similar content (${(sim * 100).toFixed(0)}% match, threshold=${(
          threshold * 100
        ).toFixed(0)}%): "${content.substring(0, 50)}"`
      );
      return false;
    }
    if (sim > 0.3) {
      console.log(`[dedup-raw-${mode}] near-miss: sim=${(sim * 100).toFixed(0)}% with "${entry.content.substring(0, 60)}"`);
    }
  }

  const entry: RawEntry = {
    content,
    detected: now.toISOString(),
  };
  cache.push(entry);
  appendRawToFile(rawFile, entry);
  return true;
}

/**
 * Load actionable raw entries from tasks-raw.md.
 */
export function loadRawFromFile(): void {
  loadRawEntries(TASKS_RAW_FILE, "actionable");
}

/**
 * Load noteworthy raw entries from memos-raw.md.
 */
export function loadMemoRawFromFile(): void {
  loadRawEntries(MEMOS_RAW_FILE, "noteworthy");
}

/**
 * Check if actionable content should proceed based on tasks-raw.md dedup.
 */
export function shouldProcessActionable(result: IntentResult): boolean {
  if (!result.actionable) return false;
  if (!actionableRawInitialized) loadRawFromFile();
  return shouldProcessInRawCache(result.content, "actionable");
}

/**
 * Check if noteworthy content should proceed based on memos-raw.md dedup.
 */
export function shouldProcessNoteworthy(result: IntentResult): boolean {
  if (!result.noteworthy) return false;
  if (!noteworthyRawInitialized) loadMemoRawFromFile();
  return shouldProcessInRawCache(result.content, "noteworthy");
}

/**
 * Backward-compatible alias: actionable path dedup.
 */
export function shouldProcess(result: IntentResult): boolean {
  return shouldProcessActionable(result);
}

// === tasks.md: final actionable records ===

/**
 * Parse a task line.
 * Supports both new format (urgent) and legacy format (type).
 */
function parseTaskLine(line: string): TaskEntry | null {
  const match = line.match(/^- \[([ x])\] (.+)$/);
  if (!match) return null;

  const [, status, payload] = match;
  const segments = payload.split(" | ").map((item) => item.trim()).filter(Boolean);
  if (segments.length === 0) return null;

  const content = segments[0];
  let urgent = false;
  let dueTime: string | null = null;
  let detected = new Date().toISOString();

  for (const segment of segments.slice(1)) {
    if (segment.startsWith("urgent:")) {
      urgent = segment.slice("urgent:".length).trim() === "true";
      continue;
    }
    if (segment.startsWith("type:")) {
      const legacyType = segment.slice("type:".length).trim();
      if (legacyType === "deadline") urgent = true;
      continue;
    }
    if (segment.startsWith("due:")) {
      dueTime = segment.slice("due:".length).trim() || null;
      continue;
    }
    if (segment.startsWith("detected:")) {
      detected = segment.slice("detected:".length).trim() || detected;
    }
  }

  return {
    completed: status === "x",
    content,
    urgent,
    dueTime,
    detected,
  };
}

function formatTaskLine(entry: TaskEntry): string {
  const check = entry.completed ? "x" : " ";
  let line = `- [${check}] ${entry.content} | urgent:${entry.urgent}`;
  if (entry.dueTime) line += ` | due:${entry.dueTime}`;
  line += ` | detected:${entry.detected}`;
  return line;
}

/**
 * Load tasks from ~/.livepipe/tasks.md into memory cache.
 */
export function loadTasksFromFile(): void {
  taskCache = [];

  if (!existsSync(TASKS_FILE)) {
    taskInitialized = true;
    return;
  }

  try {
    const raw = readFileSync(TASKS_FILE, "utf-8");
    for (const line of raw.split("\n")) {
      const entry = parseTaskLine(line.trim());
      if (entry) taskCache.push(entry);
    }
    console.log(`[dedup] loaded ${taskCache.length} tasks from ${TASKS_FILE}`);
  } catch (err) {
    console.error(`[dedup] failed to read ${TASKS_FILE}:`, err);
  }

  taskInitialized = true;
}

function appendTaskToFile(entry: TaskEntry): void {
  mkdirSync(TASKS_DIR, { recursive: true });

  const todayStr = entry.detected.slice(0, 10);
  const newLine = formatTaskLine(entry);

  if (!existsSync(TASKS_FILE)) {
    writeFileSync(TASKS_FILE, `# LivePipe Tasks\n\n## ${todayStr}\n\n${newLine}\n`);
    return;
  }

  const raw = readFileSync(TASKS_FILE, "utf-8");
  const sectionHeader = `## ${todayStr}`;

  if (raw.includes(sectionHeader)) {
    const idx = raw.indexOf(sectionHeader);
    const afterHeader = idx + sectionHeader.length;
    let insertPos = afterHeader;
    while (insertPos < raw.length && raw[insertPos] !== "\n") insertPos++;
    insertPos++;
    if (insertPos < raw.length && raw[insertPos] === "\n") insertPos++;

    const updated = raw.slice(0, insertPos) + newLine + "\n" + raw.slice(insertPos);
    writeFileSync(TASKS_FILE, updated);
  } else {
    const titleEnd = raw.indexOf("\n", raw.indexOf("# LivePipe Tasks"));
    if (titleEnd === -1) {
      writeFileSync(TASKS_FILE, raw + `\n\n## ${todayStr}\n\n${newLine}\n`);
    } else {
      const insertPos = titleEnd + 1;
      const updated = raw.slice(0, insertPos) + `\n## ${todayStr}\n\n${newLine}\n` + raw.slice(insertPos);
      writeFileSync(TASKS_FILE, updated);
    }
  }
}

/**
 * Record an actionable intent to tasks.md and sync to reminders.
 * due_time in the past will be cleared.
 */
export function recordAndNotify(result: IntentResult): boolean {
  if (!result.actionable) return false;

  if (!taskInitialized) loadTasksFromFile();

  const now = new Date();
  let dueTime = result.due_time;
  if (dueTime) {
    const dueDate = new Date(dueTime);
    if (!Number.isNaN(dueDate.getTime()) && dueDate.getTime() < now.getTime()) {
      console.log(`[dedup] due_time "${dueTime}" is in the past, clearing`);
      dueTime = null;
    }
  }

  const detected = now.toISOString();
  const entry: TaskEntry = {
    content: result.content,
    urgent: result.urgent,
    dueTime,
    detected,
    completed: false,
  };

  taskCache.push(entry);
  appendTaskToFile(entry);
  void syncTaskToReminders({
    content: entry.content,
    urgent: entry.urgent,
    dueTime: entry.dueTime,
    detected: entry.detected,
  }).catch((error) => {
    console.error("[reminders] sync error:", error);
  });

  return true;
}

/**
 * Sync noteworthy content to Apple Notes.
 */
export function recordNoteworthy(result: IntentResult, sourceApp: string): boolean {
  if (!result.noteworthy) return false;
  void syncMemoToAppleNotes({
    content: result.content,
    sourceApp,
    detectedAt: new Date().toISOString(),
  }).catch((error) => {
    console.error("[notes] sync error:", error);
  });
  return true;
}

/**
 * Legacy actionable shortcut for path without cloud review.
 */
export function shouldNotify(result: IntentResult): boolean {
  if (!shouldProcessActionable(result)) return false;
  return recordAndNotify(result);
}

/**
 * Noteworthy shortcut for path without cloud review.
 */
export function shouldSyncNoteworthy(result: IntentResult, sourceApp: string): boolean {
  if (!shouldProcessNoteworthy(result)) return false;
  return recordNoteworthy(result, sourceApp);
}

/**
 * Mark a task as completed by index in cache, and rewrite the file.
 */
export function markTaskComplete(index: number): void {
  if (index < 0 || index >= taskCache.length) return;
  taskCache[index].completed = true;
  rewriteFile();
}

/**
 * Rewrite the entire tasks.md from cache.
 */
function rewriteFile(): void {
  mkdirSync(TASKS_DIR, { recursive: true });

  const byDate = new Map<string, TaskEntry[]>();
  for (const entry of taskCache) {
    const date = entry.detected.slice(0, 10);
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date)!.push(entry);
  }

  const sortedDates = [...byDate.keys()].sort((a, b) => b.localeCompare(a));

  let out = "# LivePipe Tasks\n";
  for (const date of sortedDates) {
    out += `\n## ${date}\n\n`;
    for (const entry of byDate.get(date)!) {
      out += formatTaskLine(entry) + "\n";
    }
  }

  writeFileSync(TASKS_FILE, out);
}
