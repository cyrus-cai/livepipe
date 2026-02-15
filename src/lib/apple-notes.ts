import { execFile } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { getPipeConfig, type NotesConfig } from "./pipe-config";

export interface NotesSyncEntry {
  content: string;
  sourceApp: string;
  detectedAt?: string;
}

const DEFAULT_NOTES_CONFIG: NotesConfig = {
  enabled: false,
  folder: "LivePipe",
};

const EXEC_TIMEOUT_MS = 10_000;
const JXA_MAX_BUFFER_BYTES = 1024 * 1024;
let warnedNonMacPlatform = false;
let warnedNotesDisabled = false;

interface JxaResponse {
  ok: boolean;
  error?: string;
}

function getNotesConfig(): NotesConfig {
  try {
    return getPipeConfig().notes;
  } catch (error) {
    console.error("[notes] failed to read notes config:", error);
    return DEFAULT_NOTES_CONFIG;
  }
}

function escapeJXA(str: string): string {
  return str
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

function runJxaScript(script: string): Promise<JxaResponse> {
  const tmpDir = mkdtempSync(join(tmpdir(), "livepipe-notes-"));
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
              reject(new Error(`[notes] osascript failed: ${error.message}${stderr ? ` | ${stderr.trim()}` : ""}`));
              return;
            }

            const text = stdout.trim();
            if (!text) {
              reject(new Error("[notes] osascript returned empty output"));
              return;
            }

            const parsed = JSON.parse(text) as JxaResponse;
            resolve(parsed);
          } catch (parseError) {
            reject(new Error(`[notes] invalid JXA output: ${String(parseError)}`));
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

function formatLocalDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatLocalTime(date: Date): string {
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${hour}:${minute}`;
}

function buildAppendDailyNoteScript(folderName: string, noteTitle: string, line: string): string {
  const escapedFolderName = escapeJXA(folderName);
  const escapedNoteTitle = escapeJXA(noteTitle);
  const escapedLine = escapeJXA(line);

  return `
function run() {
  const app = Application("Notes");
  app.includeStandardAdditions = true;
  const folderName = "${escapedFolderName}";
  const noteTitle = "${escapedNoteTitle}";
  const appendLine = "${escapedLine}";

  function findFolderByName(targetName) {
    const folders = app.folders();
    for (let i = 0; i < folders.length; i++) {
      try {
        if (folders[i].name() === targetName) return folders[i];
      } catch (_) {}
    }
    return null;
  }

  function findNoteByName(folder, targetName) {
    const notes = folder.notes();
    for (let i = 0; i < notes.length; i++) {
      try {
        if (notes[i].name() === targetName) return notes[i];
      } catch (_) {}
    }
    return null;
  }

  try {
    let targetFolder = findFolderByName(folderName);
    if (!targetFolder) {
      targetFolder = app.make({ new: "folder", withProperties: { name: folderName } });
    }

    let targetNote = findNoteByName(targetFolder, noteTitle);
    if (!targetNote) {
      targetNote = app.make({
        new: "note",
        at: targetFolder,
        withProperties: { name: noteTitle, body: appendLine }
      });
    } else {
      const currentBody = targetNote.body();
      targetNote.body = currentBody + "\\n" + appendLine;
    }

    return JSON.stringify({ ok: true });
  } catch (error) {
    return JSON.stringify({ ok: false, error: String(error) });
  }
}
`;
}

export async function syncMemoToAppleNotes(entry: NotesSyncEntry): Promise<void> {
  const notesConfig = getNotesConfig();
  if (!notesConfig.enabled) {
    if (!warnedNotesDisabled) {
      console.log("[notes] notes.enabled is false, skipping notes sync");
      warnedNotesDisabled = true;
    }
    return;
  }
  warnedNotesDisabled = false;

  if (process.platform !== "darwin") {
    if (!warnedNonMacPlatform) {
      console.warn("[notes] notes sync is enabled but current platform is not macOS, skipping");
      warnedNonMacPlatform = true;
    }
    return;
  }

  const folderName = notesConfig.folder.trim();
  if (!folderName) {
    console.error("[notes] notes.folder is empty, skipping sync");
    return;
  }

  const detected = entry.detectedAt ? new Date(entry.detectedAt) : new Date();
  const date = Number.isNaN(detected.getTime()) ? new Date() : detected;
  const dailyTitle = `LivePipe ${formatLocalDateKey(date)}`;
  const line = `[${formatLocalTime(date)}] ${entry.content} — 来源: ${entry.sourceApp || "unknown"}`;

  const result = await runJxaScript(buildAppendDailyNoteScript(folderName, dailyTitle, line));
  if (!result.ok) {
    throw new Error(`[notes] append note failed: ${result.error ?? "unknown error"}`);
  }

  console.log(`[notes] synced memo to folder "${folderName}" note "${dailyTitle}"`);
}
