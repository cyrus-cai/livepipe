/**
 * Structured pipeline logger — collects per-stage results and outputs
 * a clean, block-formatted log at the end of each processing loop.
 *
 * Set LIVEPIPE_DEBUG=1 to also see detailed inner-module logs.
 */

export const isDebug = process.env.LIVEPIPE_DEBUG === "1";

/** Debug-only log: only prints when LIVEPIPE_DEBUG=1 */
export function debugLog(...args: unknown[]): void {
  if (isDebug) console.log(...args);
}

/** Debug-only error: only prints when LIVEPIPE_DEBUG=1 */
export function debugError(...args: unknown[]): void {
  if (isDebug) console.error(...args);
}

// ── Structured result types ──

export interface FetchResult {
  totalItems: number;
  keptItems: number;
  apps: string[];
  chars: number;
  skippedApp: number;
  skippedWindow: number;
  skippedShort: number;
  skippedDedup: number;
  skippedTime?: number;
}

export interface IntentInfo {
  actionable: boolean;
  noteworthy: boolean;
  urgent: boolean;
  content: string;
  dueTime: string | null;
  latencyMs: number;
}

export interface DedupResult {
  passed: boolean;
  reason: string;
  similarity?: number;
  cacheSize?: number;
  threshold?: number;
}

export interface ReviewStageResult {
  stage: 1 | 2;
  latencyMs: number;
  outcome: string; // e.g. "actionable=true noteworthy=false", "refined content+due"
}

export interface ReviewResult {
  stages: ReviewStageResult[];
  finalContent?: string;
  finalDueTime?: string | null;
  rejected?: boolean;
  source?: string;
}

export interface NotifyResult {
  desktop?: boolean;
  webhooks: string[]; // e.g. ["feishu", "telegram"]
  remindersSynced?: boolean;
  notesSynced?: boolean;
  errors: string[];
}

// ── ANSI helpers ──

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";

// ── Logger ──

export class PipelineLogger {
  private mode: "poll" | "hotkey";
  private seq: number;
  private lines: string[] = [];
  private startMs = Date.now();
  private flushed = false;
  private headerPrinted = false;

  constructor(mode: "poll" | "hotkey", seq: number) {
    this.mode = mode;
    this.seq = seq;
  }

  private getLabel(): string {
    return this.mode === "poll" ? `POLL #${this.seq}` : `HOTKEY #${this.seq}`;
  }

  private getHeaderLine(): string {
    const label = this.getLabel();
    return `╭─ ${label} ${"─".repeat(Math.max(0, 50 - label.length))}`;
  }

  private printHeaderIfNeeded(): void {
    if (this.headerPrinted) return;
    console.log(this.getHeaderLine());
    this.headerPrinted = true;
  }

  private pushLine(line: string): void {
    this.lines.push(line);
    this.printHeaderIfNeeded();
    console.log(line);
  }

  /** Record a "no data / skip" result and flush immediately */
  skip(reason: string): void {
    const label = this.getLabel();
    console.log(`${DIM}╭─ ${label} ──── ${reason} ───╯${RESET}`);
    this.flushed = true;
  }

  /** ① Fetch stage */
  fetch(r: FetchResult): void {
    const filters: string[] = [];
    if (r.skippedApp > 0) filters.push(`app:−${r.skippedApp}`);
    if (r.skippedWindow > 0) filters.push(`win:−${r.skippedWindow}`);
    if (r.skippedShort > 0) filters.push(`short:−${r.skippedShort}`);
    if (r.skippedDedup > 0) filters.push(`dup:−${r.skippedDedup}`);
    if ((r.skippedTime ?? 0) > 0) filters.push(`time:−${r.skippedTime}`);
    const filterStr = filters.length > 0 ? ` (${filters.join(" ")})` : "";
    this.pushLine(
      `│ ① FETCH   ${r.totalItems} items → ${r.keptItems} kept [${r.apps.join(", ")}] ${r.chars} chars${filterStr}`
    );
  }

  /** ② Change detection — screen didn't change enough */
  noChange(ratio: number): void {
    this.pushLine(`│ ② CHANGE  ${(ratio * 100).toFixed(0)}% < threshold — skipped`);
  }

  /** ② Intent detection */
  intent(r: IntentInfo): void {
    const flags = [`actionable=${r.actionable}`, `noteworthy=${r.noteworthy}`];
    if (r.urgent) flags.push("urgent");
    this.pushLine(`│ ② INTENT  ${flags.join(" ")} (${r.latencyMs}ms)`);
    if (r.content) {
      this.pushLine(`│            "${r.content}"`);
    }
    if (r.dueTime) {
      this.pushLine(`│            due=${r.dueTime}`);
    }
  }

  /** Intent returned nothing useful */
  intentSkip(reason: string): void {
    this.pushLine(`│ ② INTENT  ${DIM}${reason}${RESET}`);
  }

  /** ③ Dedup check */
  dedup(r: DedupResult): void {
    if (r.passed) {
      this.pushLine(
        `│ ③ DEDUP   ${GREEN}✓ passed${RESET} (${r.cacheSize ?? "?"} entries, threshold=${((r.threshold ?? 0) * 100).toFixed(0)}%)`
      );
    } else {
      const simStr = r.similarity != null
        ? `${(r.similarity * 100).toFixed(0)}% match`
        : r.reason || "duplicate";
      this.pushLine(
        `│ ③ DEDUP   ${RED}✗ duplicate${RESET} (${simStr}) — skipped`
      );
    }
  }

  /** ④ Cloud review stages */
  review(r: ReviewResult): void {
    const sourceTag = r.source ? `[${r.source}] ` : "";
    for (const s of r.stages) {
      const icon = s.stage === 1 ? `${CYAN}stage1${RESET}` : `${CYAN}stage2${RESET}`;
      this.pushLine(`│ ④ REVIEW  ${sourceTag}${icon}: ${s.outcome} (${s.latencyMs}ms)`);
    }
    if (r.rejected) {
      this.pushLine(`│ ④ REVIEW  ${RED}✗ rejected${RESET}`);
    } else if (r.finalContent) {
      this.pushLine(
        `│            → "${r.finalContent}"${r.finalDueTime ? ` due=${r.finalDueTime}` : ""}`
      );
    }
  }

  /** Review skipped (not enabled) */
  reviewSkipped(): void {
    this.pushLine(`│ ④ REVIEW  ${DIM}(disabled)${RESET}`);
  }

  /** ⑤ Notification */
  notify(r: NotifyResult): void {
    const parts: string[] = [];
    if (r.desktop) parts.push("desktop");
    if (r.webhooks.length) parts.push(r.webhooks.join("+"));
    this.pushLine(
      parts.length > 0
        ? `│ ⑤ NOTIFY  ${GREEN}✓${RESET} ${parts.join(" + ")}`
        : `│ ⑤ NOTIFY  ${DIM}(no external notification)${RESET}`
    );
    if (r.remindersSynced) {
      this.pushLine(`│           ${GREEN}✓${RESET} reminders synced`);
    }
    if (r.notesSynced) {
      this.pushLine(`│           ${GREEN}✓${RESET} notes synced`);
    }
    for (const err of r.errors) {
      this.pushLine(`│           ${RED}✗${RESET} ${err}`);
    }
  }

  /** Add an arbitrary info line */
  info(text: string): void {
    this.pushLine(`│ ${text}`);
  }

  /** Flush all collected lines as a formatted block */
  flush(): void {
    if (this.flushed) return;
    this.flushed = true;

    const elapsed = ((Date.now() - this.startMs) / 1000).toFixed(1);
    const footerLine = `╰${"─".repeat(30)} ${elapsed}s total`;

    this.printHeaderIfNeeded();
    console.log(footerLine);
  }
}
