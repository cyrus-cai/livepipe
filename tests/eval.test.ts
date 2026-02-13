import { beforeAll, describe, expect, test } from "bun:test";
import { DEFAULT_OLLAMA_MODEL, OLLAMA_CHAT_URL } from "../src/lib/constants";
import {
  calcMetrics,
  formatMetricsReport,
  loadFixtures,
  runEvaluation,
  type EvalMetrics,
  type FixtureCategory,
} from "./eval-helpers";

const MIN_PRECISION = 0.85;
const MIN_RECALL = 0.8;
const EVAL_TIMEOUT_MS = 300_000;
const fixtures = loadFixtures();

let metricsPromise: Promise<EvalMetrics> | null = null;

async function ensureOllamaReady(): Promise<void> {
  const tagsUrl = OLLAMA_CHAT_URL.replace("/api/chat", "/api/tags");
  let response: Response;

  try {
    response = await fetch(tagsUrl);
  } catch (error) {
    throw new Error(
      `[eval] Cannot connect to Ollama at ${tagsUrl}. Start Ollama before running tests. Original error: ${String(error)}`
    );
  }

  if (!response.ok) {
    throw new Error(`[eval] Ollama health check failed: HTTP ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as { models?: Array<{ name?: string }> };
  const modelNames = (data.models || [])
    .map((item) => item.name || "")
    .filter((name) => name.length > 0);

  if (!modelNames.includes(DEFAULT_OLLAMA_MODEL)) {
    console.warn(
      `[eval] model "${DEFAULT_OLLAMA_MODEL}" is not in Ollama model list. Available: ${modelNames.join(", ")}`
    );
  }
}

async function getMetrics(): Promise<EvalMetrics> {
  if (!metricsPromise) {
    metricsPromise = (async () => {
      const results = await runEvaluation(fixtures);
      return calcMetrics(results);
    })();
  }
  return metricsPromise;
}

describe("Intent Detection Evaluation", () => {
  beforeAll(async () => {
    await ensureOllamaReady();
  });

  test(
    "precision ≥ 85%",
    async () => {
      const metrics = await getMetrics();
      expect(metrics.precision).toBeGreaterThanOrEqual(MIN_PRECISION);
    },
    EVAL_TIMEOUT_MS
  );

  test(
    "recall ≥ 80%",
    async () => {
      const metrics = await getMetrics();
      expect(metrics.recall).toBeGreaterThanOrEqual(MIN_RECALL);
    },
    EVAL_TIMEOUT_MS
  );

  test(
    "print metrics report",
    async () => {
      const metrics = await getMetrics();
      const categories = new Set<FixtureCategory>(["chat", "email", "calendar", "noise", "code", "mixed"]);

      console.log(formatMetricsReport(metrics));
      expect(metrics.total).toBe(fixtures.length);
      expect(metrics.byCategory.length).toBe(categories.size);
      expect(metrics.byCategory.every((item) => categories.has(item.category))).toBe(true);
    },
    EVAL_TIMEOUT_MS
  );
});
