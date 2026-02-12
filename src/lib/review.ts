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

Respond in JSON format:
{"approved": true/false, "reason": "brief explanation"}

Respond ONLY with JSON, no other text.`;

/**
 * Prompt 2: Content refinement
 * Take the raw extracted text and produce a clean, natural to-do sentence in the target language.
 */
function buildQualityPrompt(language: string): string {
  return `You are a to-do content refiner. You receive raw text extracted from a screen by a small model, along with an OCR snippet for context. Your job is to produce a clean, natural to-do sentence in ${language}.

Your tasks:
1. Verify the content matches the OCR snippet (reject hallucinations or text that doesn't match)
2. Translate to ${language} if the original is in a different language
3. Write a complete, self-explanatory sentence (who/what/when as applicable)
4. Translate well-known brand/proper names to their standard ${language} form if one exists
5. Keep unknown proper nouns in their original form — do NOT invent translations

Reject if:
- Content is garbled, incomprehensible, or contains OCR artifacts
- Content doesn't match the OCR snippet at all (hallucination)
- Content is too vague to be a useful to-do item

Respond in JSON format:
{"approved": true/false, "refined_content": "refined sentence in ${language} (if approved)", "reason": "brief explanation"}

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
    let input2 = `Content: ${intent.content}`;
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

    // Use refined content if provided
    if (result2?.refined_content && typeof result2.refined_content === "string") {
      const refined = result2.refined_content.substring(0, 200);
      if (refined !== intent.content) {
        console.log(`${YELLOW}[review] ✎ refined: "${intent.content.substring(0, 30)}" → "${refined.substring(0, 30)}"${RESET}`);
        return { ...intent, content: refined };
      }
    }

    console.log(`${GREEN}[review] ✓ stage 2 passed: ${result2?.reason || "ok"}${RESET}`);
    return intent;
  } catch (err) {
    console.error(`${RED}[review] stage 2 error:${RESET}`, err);
    throw err;
  }
}
