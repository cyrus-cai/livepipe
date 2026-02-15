import { execFile } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { getPipeConfig, type RemindersConfig } from "./pipe-config";

export interface ReminderTask {
  name: string;
  body?: string;
  dueDate?: string;
  priority?: number;
}

export interface ReminderSyncEntry {
  content: string;
  urgent: boolean;
  dueTime: string | null;
  detected: string;
}

const DEFAULT_REMINDERS_CONFIG: RemindersConfig = {
  enabled: false,
  list: "LivePipe",
};

const EXEC_TIMEOUT_MS = 10_000;
const JXA_MAX_BUFFER_BYTES = 1024 * 1024;
const ensuredLists = new Set<string>();
let warnedNonMacPlatform = false;
let warnedRemindersDisabled = false;

interface JxaResponse {
  ok: boolean;
  id?: string;
  error?: string;
}

function getRemindersConfig(): RemindersConfig {
  try {
    return getPipeConfig().reminders;
  } catch (error) {
    console.error("[reminders] failed to read reminders config:", error);
    return DEFAULT_REMINDERS_CONFIG;
  }
}

export function escapeJXA(str: string): string {
  return str
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

function runJxaScript(script: string): Promise<JxaResponse> {
  const tmpDir = mkdtempSync(join(tmpdir(), "livepipe-reminders-"));
  const scriptPath = join(tmpDir, "script.jxa");
  writeFileSync(scriptPath, script, "utf-8");

  return new Promise<JxaResponse>((resolve, reject) => {
    try {
      execFile(
        "osascript",
        ["-l", "JavaScript", scriptPath],
        { timeout: EXEC_TIMEOUT_MS, maxBuffer: JXA_MAX_BUFFER_BYTES },
        (error, stdout, stderr) => {
          try {
            if (error) {
              reject(new Error(`[reminders] osascript failed: ${error.message}${stderr ? ` | ${stderr.trim()}` : ""}`));
              return;
            }

            const text = stdout.trim();
            if (!text) {
              reject(new Error("[reminders] osascript returned empty output"));
              return;
            }

            const parsed = JSON.parse(text) as JxaResponse;
            resolve(parsed);
          } catch (parseError) {
            reject(new Error(`[reminders] invalid JXA output: ${String(parseError)}`));
          } finally {
            rmSync(tmpDir, { recursive: true, force: true });
          }
        }
      );
    } catch (error) {
      rmSync(tmpDir, { recursive: true, force: true });
      reject(error);
    }
  });
}

function buildEnsureListScript(listName: string): string {
  const escapedListName = escapeJXA(listName);
  return `
function run() {
  const app = Application("/System/Applications/Reminders.app");
  const listName = "${escapedListName}";

  function findListByName(targetName) {
    const lists = app.lists();
    for (let i = 0; i < lists.length; i++) {
      try {
        if (lists[i].name() === targetName) {
          return lists[i];
        }
      } catch (_) {}
    }
    return null;
  }

  try {
    let targetList = findListByName(listName);
    if (!targetList) {
      targetList = app.make({ new: "list", withProperties: { name: listName } });
    }
    return JSON.stringify({ ok: true });
  } catch (error) {
    return JSON.stringify({ ok: false, error: String(error) });
  }
}
`;
}

function buildCreateReminderScript(listName: string, task: ReminderTask): string {
  const escapedListName = escapeJXA(listName);
  const escapedName = escapeJXA(task.name);
  const bodyLiteral = typeof task.body === "string" ? `"${escapeJXA(task.body)}"` : "null";
  const dueDateLiteral = typeof task.dueDate === "string" ? `"${escapeJXA(task.dueDate)}"` : "null";
  const priorityLiteral = typeof task.priority === "number" ? String(task.priority) : "null";

  return `
function run() {
  const app = Application("/System/Applications/Reminders.app");
  const listName = "${escapedListName}";
  const reminderName = "${escapedName}";
  const reminderBody = ${bodyLiteral};
  const dueDateIso = ${dueDateLiteral};
  const reminderPriority = ${priorityLiteral};

  function findListByName(targetName) {
    const lists = app.lists();
    for (let i = 0; i < lists.length; i++) {
      try {
        if (lists[i].name() === targetName) {
          return lists[i];
        }
      } catch (_) {}
    }
    return null;
  }

  try {
    let targetList = findListByName(listName);
    if (!targetList) {
      targetList = app.make({ new: "list", withProperties: { name: listName } });
    }

    const props = { name: reminderName };
    if (reminderBody !== null) props.body = reminderBody;
    if (dueDateIso !== null) props.dueDate = new Date(dueDateIso);
    if (reminderPriority !== null) props.priority = reminderPriority;

    const reminder = app.make({ new: "reminder", at: targetList, withProperties: props });

    return JSON.stringify({ ok: true, id: String(reminder.id()) });
  } catch (error) {
    return JSON.stringify({ ok: false, error: String(error) });
  }
}
`;
}

export async function ensureList(listName: string): Promise<void> {
  const normalizedListName = listName.trim();
  if (!normalizedListName) {
    throw new Error("[reminders] list name cannot be empty");
  }

  const result = await runJxaScript(buildEnsureListScript(normalizedListName));
  if (!result.ok) {
    throw new Error(`[reminders] ensure list failed: ${result.error ?? "unknown error"}`);
  }
}

export async function createReminder(listName: string, task: ReminderTask): Promise<string> {
  const normalizedListName = listName.trim();
  const normalizedTaskName = task.name.trim();

  if (!normalizedListName) {
    throw new Error("[reminders] list name cannot be empty");
  }
  if (!normalizedTaskName) {
    throw new Error("[reminders] reminder name cannot be empty");
  }

  const result = await runJxaScript(
    buildCreateReminderScript(normalizedListName, {
      ...task,
      name: normalizedTaskName,
    })
  );

  if (!result.ok) {
    throw new Error(`[reminders] create reminder failed: ${result.error ?? "unknown error"}`);
  }
  return result.id ?? "";
}

export function mapUrgencyToReminderPriority(urgent: boolean): number {
  return urgent ? 1 : 0;
}

export function normalizeDueDateForReminder(dueTime: string | null): string | undefined {
  if (!dueTime) return undefined;
  const parsed = new Date(dueTime);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed.toISOString();
}

function buildReminderBody(_entry: ReminderSyncEntry): string | undefined {
  return undefined;
}

export async function syncTaskToReminders(entry: ReminderSyncEntry): Promise<void> {
  const remindersConfig = getRemindersConfig();
  if (!remindersConfig.enabled) {
    if (!warnedRemindersDisabled) {
      console.log("[reminders] reminders.enabled is false, skipping reminders sync");
      warnedRemindersDisabled = true;
    }
    return;
  }
  warnedRemindersDisabled = false;

  if (process.platform !== "darwin") {
    if (!warnedNonMacPlatform) {
      console.warn("[reminders] reminders sync is enabled but current platform is not macOS, skipping");
      warnedNonMacPlatform = true;
    }
    return;
  }

  const listName = remindersConfig.list.trim();
  if (!listName) {
    console.error("[reminders] reminders.list is empty, skipping sync");
    return;
  }

  if (!ensuredLists.has(listName)) {
    await ensureList(listName);
    ensuredLists.add(listName);
  }

  const dueDate = normalizeDueDateForReminder(entry.dueTime);
  if (entry.dueTime && !dueDate) {
    console.warn(`[reminders] invalid dueTime "${entry.dueTime}", creating reminder without due date`);
  }

  const reminderId = await createReminder(listName, {
    name: entry.content,
    body: buildReminderBody(entry),
    dueDate,
    priority: mapUrgencyToReminderPriority(entry.urgent),
  });

  console.log(`[reminders] synced task to list "${listName}"${reminderId ? ` (id=${reminderId})` : ""}`);
}
