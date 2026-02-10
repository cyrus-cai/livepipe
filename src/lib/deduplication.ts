import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { IntentResult } from "./schemas";

const SIMILARITY_THRESHOLD = 0.6;
const LOOKBACK_DAYS = 7;
const TASKS_DIR = join(homedir(), ".livepipe");
const TASKS_FILE = join(TASKS_DIR, "tasks.md");

interface TaskEntry {
  content: string;
  type: string;
  dueTime: string | null;
  detected: string; // ISO timestamp
  completed: boolean;
}

// In-memory cache, loaded from file on init
let taskCache: TaskEntry[] = [];
let initialized = false;

/**
 * Character bigram overlap (Dice coefficient) — fast and effective for short text.
 */
function similarity(a: string, b: string): number {
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

/**
 * Parse a task line like:
 * - [ ] some content | type:todo | due:明天 | detected:2026-02-10T14:30:00
 * - [x] some content | type:todo | due:null | detected:2026-02-10T14:30:00
 */
function parseTaskLine(line: string): TaskEntry | null {
  const match = line.match(
    /^- \[([ x])\] (.+?)(?:\s*\|\s*type:(\w+))?(?:\s*\|\s*due:(.*?))?(?:\s*\|\s*detected:(\S+))?$/
  );
  if (!match) return null;

  const [, status, content, type, due, detected] = match;
  return {
    completed: status === "x",
    content: content.trim(),
    type: type || "todo",
    dueTime: due && due.trim() !== "null" ? due.trim() : null,
    detected: detected || new Date().toISOString(),
  };
}

/**
 * Format a task entry as a markdown line.
 */
function formatTaskLine(entry: TaskEntry): string {
  const check = entry.completed ? "x" : " ";
  const due = entry.dueTime ?? "null";
  return `- [${check}] ${entry.content} | type:${entry.type} | due:${due} | detected:${entry.detected}`;
}

/**
 * Load tasks from ~/.livepipe/tasks.md into memory cache.
 */
export function loadTasksFromFile(): void {
  taskCache = [];

  if (!existsSync(TASKS_FILE)) {
    initialized = true;
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

  initialized = true;
}

/**
 * Append a new task to ~/.livepipe/tasks.md under today's date section.
 */
function appendTaskToFile(entry: TaskEntry): void {
  mkdirSync(TASKS_DIR, { recursive: true });

  const todayStr = entry.detected.slice(0, 10); // YYYY-MM-DD
  const newLine = formatTaskLine(entry);

  if (!existsSync(TASKS_FILE)) {
    writeFileSync(TASKS_FILE, `# LivePipe Tasks\n\n## ${todayStr}\n\n${newLine}\n`);
    return;
  }

  const raw = readFileSync(TASKS_FILE, "utf-8");
  const sectionHeader = `## ${todayStr}`;

  if (raw.includes(sectionHeader)) {
    // Insert after the section header line
    const idx = raw.indexOf(sectionHeader);
    const afterHeader = idx + sectionHeader.length;
    // Find the end of the header line (skip any trailing whitespace/newline)
    let insertPos = afterHeader;
    while (insertPos < raw.length && raw[insertPos] !== "\n") insertPos++;
    insertPos++; // skip the newline after header
    // Skip one blank line if present
    if (insertPos < raw.length && raw[insertPos] === "\n") insertPos++;

    const updated = raw.slice(0, insertPos) + newLine + "\n" + raw.slice(insertPos);
    writeFileSync(TASKS_FILE, updated);
  } else {
    // Add new date section at the top (after "# LivePipe Tasks" header)
    const titleEnd = raw.indexOf("\n", raw.indexOf("# LivePipe Tasks"));
    if (titleEnd === -1) {
      writeFileSync(TASKS_FILE, raw + `\n\n## ${todayStr}\n\n${newLine}\n`);
    } else {
      const insertPos = titleEnd + 1;
      const updated =
        raw.slice(0, insertPos) +
        `\n## ${todayStr}\n\n${newLine}\n` +
        raw.slice(insertPos);
      writeFileSync(TASKS_FILE, updated);
    }
  }
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

  // Group by date, newest first
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

/**
 * Check if this intent result should trigger a notification.
 * Compares against 7 days of uncompleted tasks from persistent storage.
 */
export function shouldNotify(result: IntentResult): boolean {
  if (!result.actionable) return false;

  if (!initialized) loadTasksFromFile();

  const now = new Date();
  const cutoff = new Date(now.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const cutoffStr = cutoff.toISOString();

  // Compare against recent uncompleted tasks
  for (const task of taskCache) {
    if (task.completed) continue;
    if (task.detected < cutoffStr) continue;

    const sim = similarity(result.content, task.content);
    if (sim >= SIMILARITY_THRESHOLD) {
      console.log(
        `[dedup] skipping similar content (${(sim * 100).toFixed(0)}% match, task from ${task.detected.slice(0, 10)}): "${result.content.substring(0, 50)}"`
      );
      return false;
    }
  }

  // Validate due_time is not in the past
  let dueTime = result.due_time;
  if (dueTime) {
    const dueDate = new Date(dueTime);
    if (!isNaN(dueDate.getTime()) && dueDate.getTime() < now.getTime()) {
      console.log(`[dedup] due_time "${dueTime}" is in the past, clearing`);
      dueTime = null;
    }
  }

  // New task — record it
  const entry: TaskEntry = {
    content: result.content,
    type: result.type,
    dueTime,
    detected: now.toISOString(),
    completed: false,
  };

  taskCache.push(entry);
  appendTaskToFile(entry);

  return true;
}
