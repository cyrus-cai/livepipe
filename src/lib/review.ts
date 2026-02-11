import type { LlmProvider } from "./llm-provider";
import type { IntentResult } from "./schemas";

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

Common false positives from the small model:
- UI labels, button text, or menu items misidentified as tasks
- News headlines or article content misidentified as to-do items
- Code comments or TODO markers misidentified as user tasks
- Ads or recommended content misidentified as reminders
- Hallucinated tasks that don't exist in the original text
- Other people's conversation content misidentified as tasks for the user

Criteria:
- Real task: has a clear action to perform, and it's something the user personally needs to do
- Not a task: pure information, news, UI text, code, other people's content, vague descriptions

Review the following small model output and respond in JSON format:
{"approved": true/false, "reason": "brief explanation"}

Respond ONLY with JSON, no other text.`;

/**
 * Prompt 2: Content quality review
 * Check Chinese sentence quality, optionally refine the expression.
 */
const QUALITY_PROMPT = `You are a Chinese content quality reviewer. Your job is to check whether a to-do item's Chinese expression is clear, complete, and natural.

Review criteria:
- Is the sentence complete and self-explanatory (without needing to see the original screen)?
- Does it contain OCR artifacts, garbled characters, or truncated text?
- Is the grammar correct and wording accurate?
- Does it include necessary context (who, what, when)?

If the content quality is acceptable, you may slightly adjust the wording to make it more natural. If there are serious issues (garbled text, incomprehensible, missing key information), reject it.

Review the following content and respond in JSON format:
{"approved": true/false, "refined_content": "refined content (if approved is true)", "reason": "brief explanation"}

Respond ONLY with JSON, no other text.`;

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
  intent: IntentResult
): Promise<IntentResult | null> {
  // Stage 1: Actionability check
  try {
    const input1 = `Task type: ${intent.type}\nContent: ${intent.content}\nDue time: ${intent.due_time || "none"}`;

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

  // Stage 2: Content quality check
  try {
    console.log(`${BOLD}${MAGENTA}[review] ☁️  CLOUD API CALL — stage 2: content quality${RESET}`);
    console.log(`${MAGENTA}[review] → sending to cloud: "${intent.content.substring(0, 80)}"${RESET}`);
    const response2 = await provider.chat(
      [
        { role: "system", content: QUALITY_PROMPT },
        { role: "user", content: intent.content },
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
