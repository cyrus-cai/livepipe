import type { LlmProvider } from "./llm-provider";
import type { IntentResult } from "./schemas";

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

// ANSI colors for cloud API logs
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const MAGENTA = "\x1b[35m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

/**
 * Prompt 1: Actionability validation
 * Verify whether the small model's output is truly a human-actionable task.
 */
const ACTIONABILITY_PROMPT = `You are a task review expert. Your job is to verify whether a "to-do item" extracted by a small AI model from screen OCR text is truly a task that requires human action.

You will receive:
- The extracted task (type, content, due_time)
- Source app: which application the screen text came from
- Trigger: "poll" (automatic background capture) or "hotkey" (user explicitly requested capture — be more lenient)
- OCR snippet: a short excerpt of original screen text for context

Use the source app and OCR snippet to judge whether this is a real task:
- Browser ads/buttons ("Buy Now", "Subscribe") from chrome are usually NOT real tasks
- Messages from chat apps (slack, wechat, telegram) that say "remember to..." ARE likely real
- Calendar/email apps have high trust for meetings and deadlines
- If trigger is "hotkey", the user actively wanted this captured — lower your rejection threshold

Common false positives from the small model:
- UI labels, button text, or menu items misidentified as tasks
- News headlines or article content misidentified as to-do items
- Code comments or TODO markers misidentified as user tasks
- Ads or recommended content misidentified as reminders
- Hallucinated tasks that don't match the OCR snippet at all
- Incomplete/truncated fragments: an action verb followed by gibberish, random characters, or meaningless fragments (e.g. "Investigate Oj&", "Check xK#2", "Review @@") — these are OCR artifacts, NOT real tasks
- Content where the object of the action is unintelligible or missing — a real task must have a clear, understandable target (e.g. "Investigate the bug" is valid, "Investigate Oj&" is NOT)

Respond in JSON format:
{"approved": true/false, "reason": "brief explanation"}

Respond ONLY with JSON, no other text.`;

/**
 * Prompt 2: Content refinement
 * Take the raw extracted text and produce a clean, natural to-do sentence in the target language.
 */
function buildQualityPrompt(language: string): string {
  return `You are a to-do quality reviewer. You receive a task extracted by a small model from screen OCR, along with context. Your job is to produce the final, polished output in ${language}.

You will receive:
- Content: the raw extracted task text
- Extracted type: the small model's classification (reminder/todo/meeting/deadline/note)
- Extracted due_time: the small model's parsed time (ISO 8601 or null)
- Current time: for resolving relative time references
- OCR snippet: original screen text for verification

Your tasks:
1. Verify the content matches the OCR snippet (reject hallucinations)
2. Translate to ${language} if needed; translate well-known brands to their standard ${language} form, keep unknown proper nouns as-is
3. Fix grammar issues, remove redundancy, write a clean self-explanatory sentence
4. Verify and correct the type classification if wrong (e.g. a meeting classified as "todo")
5. Verify and correct due_time:
   - If the small model missed a time that exists in the OCR, extract it
   - If the small model got the time wrong, fix it
   - Convert relative times ("明天", "tomorrow", "Friday") to absolute ISO 8601 using the provided current time
   - All due_time must be AFTER current time; if resolved time is in the past, push to next occurrence
   - If no time is mentioned at all, set to null

Reject if:
- Content is garbled, incomprehensible, or contains OCR artifacts
- Content doesn't match the OCR snippet at all (hallucination)
- Content is too vague to be a useful to-do item
- Content is a truncated fragment with meaningless action target (e.g. "Investigate Oj&") — do NOT salvage, just reject

Respond in JSON format:
{"approved": true/false, "refined_content": "refined sentence in ${language}", "refined_type": "reminder|todo|meeting|deadline|note", "refined_due_time": "YYYY-MM-DDTHH:mm or null", "reason": "brief explanation"}

Respond ONLY with JSON, no other text.`;
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
 * Returns the (possibly refined) IntentResult, or null if review fails and failOpen is false.
 */
export async function reviewIntent(
  provider: LlmProvider,
  intent: IntentResult,
  context?: ReviewContext
): Promise<IntentResult | null> {
  // Stage 1: Actionability check
  try {
    let input1 = `Task type: ${intent.type}\nContent: ${intent.content}\nDue time: ${intent.due_time || "none"}`;
    if (context) {
      input1 += `\nSource app: ${context.sourceApp}`;
      input1 += `\nTrigger: ${context.trigger}`;
      if (context.textSnippet) {
        input1 += `\nOCR snippet: ${context.textSnippet}`;
      }
    }

    console.log(`${BOLD}${CYAN}[review] ☁️  CLOUD API CALL — stage 1: actionability check${RESET}`);
    console.log(`${CYAN}[review] → sending to cloud: "${intent.content.substring(0, 80)}"${RESET}`);
    const response1 = await provider.chat(
      [
        { role: "system", content: ACTIONABILITY_PROMPT },
        { role: "user", content: input1 },
      ],
      { temperature: 0.1, maxTokens: 200 },
    );

    const result1 = extractReviewJson(response1);
    if (result1 && result1.approved === false) {
      console.log(`${RED}[review] ✗ stage 1 REJECTED: ${result1.reason}${RESET}`);
      return { ...intent, actionable: false };
    }
    console.log(`${GREEN}[review] ✓ stage 1 passed: ${result1?.reason || "ok"}${RESET}`);
  } catch (err) {
    console.error(`${RED}[review] stage 1 error:${RESET}`, err);
    throw err;
  }

  // Stage 2: Content refinement
  try {
    const lang = context?.language || "zh-CN";
    console.log(`${BOLD}${MAGENTA}[review] ☁️  CLOUD API CALL — stage 2: content refinement (${lang})${RESET}`);
    console.log(`${MAGENTA}[review] → sending to cloud: "${intent.content.substring(0, 80)}"${RESET}`);
    const now = new Date();
    const isoNow = now.toISOString().slice(0, 16);
    let input2 = `Content: ${intent.content}`;
    input2 += `\nExtracted type: ${intent.type}`;
    input2 += `\nExtracted due_time: ${intent.due_time || "null"}`;
    input2 += `\nCurrent time: ${isoNow}`;
    if (context?.textSnippet) {
      input2 += `\nOCR snippet: ${context.textSnippet}`;
    }
    const response2 = await provider.chat(
      [
        { role: "system", content: buildQualityPrompt(lang) },
        { role: "user", content: input2 },
      ],
      { temperature: 0.1, maxTokens: 300 },
    );

    const result2 = extractReviewJson(response2);
    if (result2 && result2.approved === false) {
      console.log(`${RED}[review] ✗ stage 2 REJECTED: ${result2.reason}${RESET}`);
      return { ...intent, actionable: false };
    }

    // Apply refined fields from Gemini, falling back to small model values
    if (result2) {
      const validTypes = ["reminder", "todo", "meeting", "deadline", "note"];
      const refinedContent = typeof result2.refined_content === "string"
        ? result2.refined_content.substring(0, 200)
        : intent.content;
      const refinedType = typeof result2.refined_type === "string" && validTypes.includes(result2.refined_type as string)
        ? (result2.refined_type as IntentResult["type"])
        : intent.type;
      const refinedDueTime = result2.refined_due_time === null
        ? null
        : typeof result2.refined_due_time === "string" && result2.refined_due_time !== "null"
          ? result2.refined_due_time as string
          : intent.due_time;

      const changed: string[] = [];
      if (refinedContent !== intent.content) changed.push("content");
      if (refinedType !== intent.type) changed.push(`type:${intent.type}→${refinedType}`);
      if (refinedDueTime !== intent.due_time) changed.push(`due:${intent.due_time}→${refinedDueTime}`);

      if (changed.length > 0) {
        console.log(`${YELLOW}[review] ✎ refined [${changed.join(", ")}]: "${refinedContent.substring(0, 40)}"${RESET}`);
      } else {
        console.log(`${GREEN}[review] ✓ stage 2 passed (no changes): ${result2.reason || "ok"}${RESET}`);
      }

      return { ...intent, content: refinedContent, type: refinedType, due_time: refinedDueTime };
    }

    console.log(`${GREEN}[review] ✓ stage 2 passed: ok${RESET}`);
    return intent;
  } catch (err) {
    console.error(`${RED}[review] stage 2 error:${RESET}`, err);
    throw err;
  }
}
