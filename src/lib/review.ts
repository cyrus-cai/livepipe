import type { LlmProvider } from "./llm-provider";
import type { IntentResult } from "./schemas";
import { debugError, debugLog, type ReviewResult } from "./pipeline-logger";

/**
 * Lightweight context passed alongside IntentResult to help the cloud reviewer
 * make better judgments without seeing the full OCR text.
 */
export interface ReviewContext {
  /** App that produced the OCR text, e.g. "chrome", "slack" */
  sourceApp: string;
  /** "poll" = automatic background capture, "hotkey" = user pressed hotkey */
  trigger: "poll" | "hotkey";
  /** Short snippet (~120 chars) of original OCR around the relevant content */
  textSnippet: string;
  /** Target language for the refined output, e.g. "zh-CN", "en", "ja" */
  language: string;
}

export interface ReviewIntentOutcome {
  intent: IntentResult | null;
  review: ReviewResult;
}

export interface ReviewFailureMeta {
  stage: "stage1" | "stage2";
  reason: string;
  provider?: string;
  status?: number;
  response?: string;
}

export class ReviewExecutionError extends Error {
  readonly meta: ReviewFailureMeta;

  constructor(meta: ReviewFailureMeta, cause?: unknown) {
    super(`[${meta.stage}] ${meta.reason}`);
    this.name = "ReviewExecutionError";
    this.meta = meta;
    if (cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = cause;
    }
  }
}

function summarizeRawResponse(text: string, limit = 500): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return "(empty)";
  return flat.length > limit ? `${flat.slice(0, limit)}...` : flat;
}

function wrapReviewError(stage: "stage1" | "stage2", err: unknown): ReviewExecutionError {
  const source = err as {
    reason?: unknown;
    provider?: unknown;
    status?: unknown;
    responseText?: unknown;
  };
  const reason = typeof source.reason === "string"
    ? source.reason
    : err instanceof Error
      ? err.message
      : String(err);
  const provider = typeof source.provider === "string" ? source.provider : undefined;
  const status = typeof source.status === "number" ? source.status : undefined;
  const response = typeof source.responseText === "string"
    ? summarizeRawResponse(source.responseText)
    : undefined;
  return new ReviewExecutionError(
    {
      stage,
      reason,
      provider,
      status,
      response,
    },
    err,
  );
}

/**
 * Prompt 1: Dimension validation
 * Validate actionable/noteworthy independently.
 */
const INTENT_VALIDATION_PROMPT = `You are an OCR intent review expert.
Validate two independent dimensions for extracted content:
- actionable: user should take action
- noteworthy: worth recording even without action

You will receive:
- extracted content + due_time + urgent + current actionable/noteworthy flags
- source app
- trigger mode: poll/hotkey
- OCR snippet

Validation rules:
- actionable=false for UI labels/buttons/ads/code/logs/tutorial examples/no-action notices
- actionable=true for concrete user requests/commitments/meetings/deadlines/reply-required messages
- noteworthy=false for noise, random fragments, pure UI text, ads, code, logs
- noteworthy=true for decisions, valuable references, meaningful context worth revisiting
- hotkey mode can be slightly more lenient, but still reject obvious junk

Respond in JSON:
{"actionable": true/false, "noteworthy": true/false, "reason": "brief explanation"}

Respond ONLY with JSON.`;

/**
 * Prompt 2: Content refinement
 * Refine content with strategy split for task vs memo.
 */
function buildQualityPrompt(language: string): string {
  return `You are an intent quality reviewer. Refine extracted OCR intent into final output in ${language}.

Input fields:
- content
- actionable
- noteworthy
- urgent
- due_time
- current time
- OCR snippet

Goals:
1. Verify content matches OCR snippet (reject hallucinations).
2. Keep strict output language: ${language}.
3. Refine expression by intent type:
   - actionable=true: use imperative/action-oriented sentence.
   - actionable=false and noteworthy=true: use declarative memo/information sentence.
   - actionable=true and noteworthy=true: keep action clear and include key memo context briefly.
4. Correct due_time:
   - Extract missing time from OCR if present.
   - Fix wrong time, normalize to ISO "YYYY-MM-DDTHH:mm".
   - due_time must be after current time; if past, move to next valid occurrence.
   - If no actionable time exists, set null.
5. Correct urgent:
   - true only when explicit urgency/deadline pressure exists.

Reject when:
- content is garbled/incomprehensible
- content does not match OCR snippet
- output cannot satisfy strict target language

Respond in JSON:
{"approved": true/false, "refined_content": "string", "refined_due_time": "YYYY-MM-DDTHH:mm or null", "refined_urgent": true/false, "refined_actionable": true/false, "refined_noteworthy": true/false, "reason": "brief explanation"}

Respond ONLY with JSON.`;
}

function extractReviewJson(text: string): Record<string, unknown> | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

/**
 * Two-stage review of an IntentResult using a large model.
 * Returns refined IntentResult with structured review metadata.
 */
export async function reviewIntent(
  provider: LlmProvider,
  intent: IntentResult,
  context?: ReviewContext
): Promise<ReviewIntentOutcome> {
  const stages: ReviewResult["stages"] = [];

  // Stage 1: Validate actionable/noteworthy
  const stage1ResultIntent: IntentResult = { ...intent };
  const stage1Start = Date.now();

  try {
    let input1 = `Content: ${intent.content}`;
    input1 += `\nActionable: ${intent.actionable}`;
    input1 += `\nNoteworthy: ${intent.noteworthy}`;
    input1 += `\nUrgent: ${intent.urgent}`;
    input1 += `\nDue time: ${intent.due_time || "none"}`;
    if (context) {
      input1 += `\nSource app: ${context.sourceApp}`;
      input1 += `\nTrigger: ${context.trigger}`;
      if (context.textSnippet) {
        input1 += `\nOCR snippet: ${context.textSnippet}`;
      }
    }

    debugLog(`[review] stage1 input: "${intent.content.substring(0, 80)}"`);

    const response1 = await provider.chat(
      [
        { role: "system", content: INTENT_VALIDATION_PROMPT },
        { role: "user", content: input1 },
      ],
      { temperature: 0.1, maxTokens: 512 },
    );

    const result1 = extractReviewJson(response1);
    if (result1) {
      const reviewedActionable = typeof result1.actionable === "boolean"
        ? intent.actionable && result1.actionable
        : intent.actionable;
      const reviewedNoteworthy = typeof result1.noteworthy === "boolean"
        ? intent.noteworthy && result1.noteworthy
        : intent.noteworthy;
      stage1ResultIntent.actionable = reviewedActionable;
      stage1ResultIntent.noteworthy = reviewedNoteworthy;
    } else {
      debugLog(`[review] stage1 non-json: "${summarizeRawResponse(response1)}"`);
    }

    const stage1Latency = Date.now() - stage1Start;
    stages.push({
      stage: 1,
      latencyMs: stage1Latency,
      outcome: `actionable=${stage1ResultIntent.actionable} noteworthy=${stage1ResultIntent.noteworthy}`,
    });

    if (!stage1ResultIntent.actionable && !stage1ResultIntent.noteworthy) {
      return {
        intent: stage1ResultIntent,
        review: {
          stages,
          rejected: true,
        },
      };
    }
  } catch (err) {
    debugError("[review] stage1 error:", err);
    throw wrapReviewError("stage1", err);
  }

  // Stage 2: Refine content
  const stage2Start = Date.now();

  try {
    const lang = context?.language || "zh-CN";
    const now = new Date();
    const isoNow = now.toISOString().slice(0, 16);
    let input2 = `Target output language (strict): ${lang}`;
    input2 += `\nContent: ${stage1ResultIntent.content}`;
    input2 += `\nActionable: ${stage1ResultIntent.actionable}`;
    input2 += `\nNoteworthy: ${stage1ResultIntent.noteworthy}`;
    input2 += `\nUrgent: ${stage1ResultIntent.urgent}`;
    input2 += `\nExtracted due_time: ${stage1ResultIntent.due_time || "null"}`;
    input2 += `\nCurrent time: ${isoNow}`;
    if (context?.textSnippet) {
      input2 += `\nOCR snippet: ${context.textSnippet}`;
    }

    debugLog(`[review] stage2 input (${lang}): "${stage1ResultIntent.content.substring(0, 80)}"`);

    const response2 = await provider.chat(
      [
        { role: "system", content: buildQualityPrompt(lang) },
        { role: "user", content: input2 },
      ],
      { temperature: 0.1, maxTokens: 1024 },
    );

    const result2 = extractReviewJson(response2);
    const stage2Latency = Date.now() - stage2Start;

    if (result2 && result2.approved === false) {
      const reason = typeof result2.reason === "string" && result2.reason.trim().length > 0
        ? result2.reason.trim()
        : "rejected";
      stages.push({
        stage: 2,
        latencyMs: stage2Latency,
        outcome: `rejected (${reason})`,
      });
      return {
        intent: { ...stage1ResultIntent, actionable: false, noteworthy: false },
        review: {
          stages,
          rejected: true,
        },
      };
    }

    if (!result2) {
      debugLog(`[review] stage2 non-json: "${summarizeRawResponse(response2)}"`);
      stages.push({
        stage: 2,
        latencyMs: stage2Latency,
        outcome: "fallback keep stage1",
      });
      return {
        intent: stage1ResultIntent,
        review: {
          stages,
          finalContent: stage1ResultIntent.content,
          finalDueTime: stage1ResultIntent.due_time,
        },
      };
    }

    const refinedContent = typeof result2.refined_content === "string"
      ? result2.refined_content.substring(0, 200)
      : stage1ResultIntent.content;
    const refinedDueTime = result2.refined_due_time === null
      ? null
      : typeof result2.refined_due_time === "string" && result2.refined_due_time !== "null"
        ? result2.refined_due_time
        : stage1ResultIntent.due_time;
    const refinedUrgent = typeof result2.refined_urgent === "boolean"
      ? result2.refined_urgent
      : stage1ResultIntent.urgent;
    const refinedActionable = typeof result2.refined_actionable === "boolean"
      ? stage1ResultIntent.actionable && result2.refined_actionable
      : stage1ResultIntent.actionable;
    const refinedNoteworthy = typeof result2.refined_noteworthy === "boolean"
      ? stage1ResultIntent.noteworthy && result2.refined_noteworthy
      : stage1ResultIntent.noteworthy;

    const changed: string[] = [];
    if (refinedContent !== stage1ResultIntent.content) changed.push("content");
    if (refinedDueTime !== stage1ResultIntent.due_time) changed.push("due");
    if (refinedUrgent !== stage1ResultIntent.urgent) changed.push("urgent");
    if (refinedActionable !== stage1ResultIntent.actionable) changed.push("actionable");
    if (refinedNoteworthy !== stage1ResultIntent.noteworthy) changed.push("noteworthy");

    stages.push({
      stage: 2,
      latencyMs: stage2Latency,
      outcome: changed.length > 0 ? `refined ${changed.join("+")}` : "no changes",
    });

    const refinedIntent: IntentResult = {
      ...stage1ResultIntent,
      content: refinedContent,
      due_time: refinedDueTime,
      urgent: refinedUrgent,
      actionable: refinedActionable,
      noteworthy: refinedNoteworthy,
    };

    return {
      intent: refinedIntent,
      review: {
        stages,
        finalContent: refinedIntent.content,
        finalDueTime: refinedIntent.due_time,
        rejected: !refinedIntent.actionable && !refinedIntent.noteworthy,
      },
    };
  } catch (err) {
    debugError("[review] stage2 error:", err);
    throw wrapReviewError("stage2", err);
  }
}
