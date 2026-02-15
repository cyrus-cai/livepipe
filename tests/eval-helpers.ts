import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Batch } from "../src/lib/batch-aggregator";
import { similarity } from "../src/lib/deduplication";
import { detectIntent } from "../src/lib/intent-detector";
import type { IntentResult } from "../src/lib/schemas";

export type FixtureCategory = "chat" | "email" | "calendar" | "noise" | "code" | "mixed";

export interface FixtureExpectation {
  actionable: boolean;
  noteworthy: boolean;
  urgent: boolean;
  hasTime?: boolean;
  contentLike?: string;
}

export interface Fixture {
  id: string;
  category: FixtureCategory;
  desc: string;
  texts: string[];
  sourceApp: string;
  hotkeyTriggered?: boolean;
  expect: FixtureExpectation;
}

export interface FixtureRunResult {
  fixture: Fixture;
  actual: IntentResult;
  durationMs: number;
}

export interface CategoryMetric {
  category: FixtureCategory;
  total: number;
  actionableAccuracy: number;
}

export interface EvalMetrics {
  total: number;
  truePositive: number;
  trueNegative: number;
  falsePositive: number;
  falseNegative: number;
  precision: number;
  recall: number;
  f1: number;
  noteworthyAccuracy: number;
  urgentAccuracy: number;
  timeAccuracy: number | null;
  contentAccuracy: number | null;
  avgLatencyMs: number;
  byCategory: CategoryMetric[];
}

export interface EvalRunOptions {
  suppressIntentLogs?: boolean;
  showProgress?: boolean;
}

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURES_PATH = join(TESTS_DIR, "fixtures.json");
const CONTENT_SIMILARITY_THRESHOLD = 0.6;
const SPINNER_FRAMES = ["|", "/", "-", "\\"];

const DEFAULT_RESULT: IntentResult = {
  actionable: false,
  noteworthy: false,
  content: "",
  due_time: null,
  urgent: false,
};

const CATEGORY_ORDER: FixtureCategory[] = ["chat", "email", "calendar", "noise", "code", "mixed"];

type EvalProgressReporter = {
  startFixture: (fixture: Fixture, index: number) => void;
  finishFixture: (durationMs: number) => void;
  success: () => void;
  fail: () => void;
};

function createEvalProgressReporter(total: number): EvalProgressReporter {
  const interactive = Boolean(process.stdout.isTTY);
  const startedAt = Date.now();
  let completed = 0;
  let current = "waiting";
  let spinnerIndex = 0;
  let ticker: ReturnType<typeof setInterval> | null = null;

  function elapsedSeconds(): string {
    return ((Date.now() - startedAt) / 1000).toFixed(1);
  }

  function percentage(): number {
    if (total === 0) return 100;
    return Math.round((completed / total) * 100);
  }

  function renderInteractive(): void {
    const frame = SPINNER_FRAMES[spinnerIndex % SPINNER_FRAMES.length];
    spinnerIndex += 1;
    const line = `[eval] ${frame} ${completed}/${total} (${percentage()}%) ${current} elapsed ${elapsedSeconds()}s`;
    process.stdout.write(`\r${line}`);
  }

  function completeInteractive(status: "done" | "failed"): void {
    if (ticker) {
      clearInterval(ticker);
      ticker = null;
    }
    const line = `[eval] ${status} ${completed}/${total} (${percentage()}%) elapsed ${elapsedSeconds()}s`;
    process.stdout.write(`\r${line}\n`);
  }

  if (interactive) {
    ticker = setInterval(renderInteractive, 120);
    renderInteractive();
  } else {
    console.log(`[eval] starting evaluation (${total} fixtures)`);
  }

  return {
    startFixture(fixture, index) {
      current = `fixture ${index + 1}/${total}: ${fixture.id}`;
      if (!interactive) {
        console.log(`[eval] [${index + 1}/${total}] running ${fixture.id} (${fixture.category})`);
      }
    },
    finishFixture(durationMs) {
      completed += 1;
      if (!interactive) {
        console.log(`[eval] [${completed}/${total}] finished in ${durationMs}ms`);
      }
    },
    success() {
      if (interactive) {
        completeInteractive("done");
      } else {
        console.log(`[eval] completed ${completed}/${total} in ${elapsedSeconds()}s`);
      }
    },
    fail() {
      if (interactive) {
        completeInteractive("failed");
      } else {
        console.error(`[eval] failed after ${completed}/${total} fixtures at ${elapsedSeconds()}s`);
      }
    },
  };
}

function normalizeResult(result: IntentResult | null): IntentResult {
  if (!result) {
    return { ...DEFAULT_RESULT };
  }

  return {
    actionable: Boolean(result.actionable),
    noteworthy: Boolean(result.noteworthy),
    content: typeof result.content === "string" ? result.content : "",
    due_time: typeof result.due_time === "string" ? result.due_time : null,
    urgent: Boolean(result.urgent),
  };
}

export function loadFixtures(filePath = FIXTURES_PATH): Fixture[] {
  const raw = readFileSync(filePath, "utf-8");
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`[eval] fixtures must be an array: ${filePath}`);
  }
  return parsed as Fixture[];
}

export async function runEvaluation(fixtures: Fixture[], options?: EvalRunOptions): Promise<FixtureRunResult[]> {
  const results: FixtureRunResult[] = [];
  const suppressIntentLogs = options?.suppressIntentLogs ?? true;
  const showProgress = options?.showProgress ?? true;
  const originalLog = console.log;
  const originalError = console.error;
  const progress = showProgress ? createEvalProgressReporter(fixtures.length) : null;

  if (suppressIntentLogs) {
    console.log = (...args: unknown[]) => {
      if (typeof args[0] === "string" && args[0].startsWith("[intent]")) return;
      originalLog(...args);
    };
    console.error = (...args: unknown[]) => {
      if (typeof args[0] === "string" && args[0].startsWith("[intent]")) return;
      originalError(...args);
    };
  }

  try {
    for (const [index, fixture] of fixtures.entries()) {
      progress?.startFixture(fixture, index);

      const batch: Batch = {
        texts: fixture.texts,
        apps: new Set([fixture.sourceApp]),
        startTime: Date.now(),
        endTime: Date.now(),
      };

      const start = Date.now();
      const detected = await detectIntent(batch, { hotkeyTriggered: fixture.hotkeyTriggered ?? false });
      const durationMs = Date.now() - start;

      results.push({
        fixture,
        actual: normalizeResult(detected),
        durationMs,
      });

      progress?.finishFixture(durationMs);
    }
    progress?.success();
  } catch (error) {
    progress?.fail();
    throw error;
  } finally {
    if (suppressIntentLogs) {
      console.log = originalLog;
      console.error = originalError;
    }
  }

  return results;
}

function safeDivide(numerator: number, denominator: number): number {
  if (denominator === 0) return 0;
  return numerator / denominator;
}

export function calcMetrics(results: FixtureRunResult[]): EvalMetrics {
  let truePositive = 0;
  let trueNegative = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  let noteworthyCorrect = 0;
  let urgentCorrect = 0;
  let timeCorrect = 0;
  let timeTotal = 0;
  let contentCorrect = 0;
  let contentTotal = 0;
  let totalLatencyMs = 0;

  const categoryStats: Record<FixtureCategory, { total: number; actionableCorrect: number }> = {
    chat: { total: 0, actionableCorrect: 0 },
    email: { total: 0, actionableCorrect: 0 },
    calendar: { total: 0, actionableCorrect: 0 },
    noise: { total: 0, actionableCorrect: 0 },
    code: { total: 0, actionableCorrect: 0 },
    mixed: { total: 0, actionableCorrect: 0 },
  };

  for (const item of results) {
    const expectedActionable = item.fixture.expect.actionable;
    const expectedNoteworthy = item.fixture.expect.noteworthy;
    const expectedUrgent = item.fixture.expect.urgent;
    const predictedActionable = item.actual.actionable;
    const predictedNoteworthy = item.actual.noteworthy;
    const predictedUrgent = item.actual.urgent;
    totalLatencyMs += item.durationMs;

    if (expectedActionable && predictedActionable) truePositive++;
    if (!expectedActionable && !predictedActionable) trueNegative++;
    if (!expectedActionable && predictedActionable) falsePositive++;
    if (expectedActionable && !predictedActionable) falseNegative++;

    if (expectedNoteworthy === predictedNoteworthy) noteworthyCorrect++;
    if (expectedUrgent === predictedUrgent) urgentCorrect++;

    if (item.fixture.expect.hasTime !== undefined) {
      timeTotal++;
      if (Boolean(item.actual.due_time) === item.fixture.expect.hasTime) {
        timeCorrect++;
      }
    }

    if (item.fixture.expect.contentLike) {
      contentTotal++;
      const score = similarity(item.actual.content, item.fixture.expect.contentLike);
      if (score >= CONTENT_SIMILARITY_THRESHOLD) {
        contentCorrect++;
      }
    }

    const category = item.fixture.category;
    categoryStats[category].total += 1;
    if (expectedActionable === predictedActionable) {
      categoryStats[category].actionableCorrect += 1;
    }
  }

  const precision = safeDivide(truePositive, truePositive + falsePositive);
  const recall = safeDivide(truePositive, truePositive + falseNegative);
  const f1 = safeDivide(2 * precision * recall, precision + recall);

  return {
    total: results.length,
    truePositive,
    trueNegative,
    falsePositive,
    falseNegative,
    precision,
    recall,
    f1,
    noteworthyAccuracy: safeDivide(noteworthyCorrect, results.length),
    urgentAccuracy: safeDivide(urgentCorrect, results.length),
    timeAccuracy: timeTotal > 0 ? timeCorrect / timeTotal : null,
    contentAccuracy: contentTotal > 0 ? contentCorrect / contentTotal : null,
    avgLatencyMs: results.length > 0 ? totalLatencyMs / results.length : 0,
    byCategory: CATEGORY_ORDER.map((category) => ({
      category,
      total: categoryStats[category].total,
      actionableAccuracy: safeDivide(categoryStats[category].actionableCorrect, categoryStats[category].total),
    })),
  };
}

function toPercent(value: number | null): string {
  if (value === null) return "n/a";
  return `${(value * 100).toFixed(1)}%`;
}

export function formatMetricsReport(metrics: EvalMetrics): string {
  const totalPositive = metrics.truePositive + metrics.falseNegative;
  const totalPredictedPositive = metrics.truePositive + metrics.falsePositive;

  let diagnosis = "False positives and false negatives are relatively balanced.";
  if (metrics.falseNegative > metrics.falsePositive) {
    diagnosis = "Main issue: too many missed tasks. Prioritize improving recall.";
  } else if (metrics.falsePositive > metrics.falseNegative) {
    diagnosis = "Main issue: too many false alarms. Prioritize improving precision.";
  }

  const weakCategories = metrics.byCategory
    .filter((item) => item.actionableAccuracy < 0.9)
    .sort((a, b) => a.actionableAccuracy - b.actionableAccuracy);

  const lines: string[] = [
    "=== Intent Detection Evaluation ===",
    "",
    "Core Metrics",
    "| Metric | Value | Meaning |",
    "| --- | --- | --- |",
    `| Recall | ${toPercent(metrics.recall)} | Share of real tasks successfully detected (higher means fewer misses) |`,
    `| Precision | ${toPercent(metrics.precision)} | Share of predicted tasks that are truly actionable (higher means fewer false alarms) |`,
    `| F1 | ${toPercent(metrics.f1)} | Balanced score of recall and precision |`,
    `| Noteworthy Accuracy | ${toPercent(metrics.noteworthyAccuracy)} | Correctness of noteworthy dimension |`,
    `| Urgent Accuracy | ${toPercent(metrics.urgentAccuracy)} | Correctness of urgency dimension |`,
    `| False Negatives (FN) | ${metrics.falseNegative}/${totalPositive} | Real tasks that the model missed |`,
    `| False Positives (FP) | ${metrics.falsePositive}/${totalPredictedPositive} | Non-tasks incorrectly predicted as tasks |`,
    `| Sample Size | ${metrics.total} | Total fixtures in this evaluation run |`,
    "",
    `One-line Diagnosis: ${diagnosis}`,
  ];

  if (weakCategories.length > 0) {
    lines.push("");
    lines.push("Problem Categories (< 90% actionable accuracy)");
    lines.push("| Category | Cases | Accuracy |");
    lines.push("| --- | --- | --- |");
    for (const item of weakCategories) {
      lines.push(`| ${item.category} | ${item.total} | ${toPercent(item.actionableAccuracy)} |`);
    }
  }

  return lines.join("\n");
}
