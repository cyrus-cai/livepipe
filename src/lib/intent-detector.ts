import type { IntentResult } from "./schemas";
import type { Batch } from "./batch-aggregator";
import { DEFAULT_OLLAMA_MODEL, OLLAMA_CHAT_URL } from "./constants";

const SYSTEM_PROMPT = `You analyze screen text to find human tasks, reminders, or things to do. The text is noisy (mixed with UI elements, code, logs) — focus on finding actionable items buried in the noise. When in doubt, lean toward marking as actionable. Missing a real task is worse than a false alarm.

NOT actionable (always false):
- Pure code, logs, error messages, stack traces with NO human task
- Pure UI labels, navigation, app chrome with NO task content
- News/articles being READ (not tasks someone WROTE)

Actionable (true) — look for these patterns even if surrounded by noise:
- Reminders: "remind me...", "don't forget...", "记得...", "别忘了..."
- Todos: "need to...", "要做...", "待办...", "buy...", "购买..."
- Meetings/deadlines: any event with a time, "meeting at...", "开会..."
- Tasks: "please do...", "帮我...", "去...", any imperative action item
- Notes that describe something to DO (not just information)

IMPORTANT: The text contains lots of noise. A single actionable phrase among noise = actionable. Scan the ENTIRE text carefully.

CRITICAL rules for "content" field:
- Write a COMPLETE, well-organized sentence in Chinese with full context
- The sentence must be self-explanatory without requiring the user to see the original screen
- Include WHO (if mentioned), WHAT (the action), WHEN (if time-sensitive), and WHY (if context helps)
- Use natural, flowing language with proper grammar — NOT fragmented phrases or keywords
- Examples of GOOD content:
  * "下午3点需要参加团队周会" (not just "3点开会")
  * "记得今天下班前完成项目报告的初稿" (not just "完成报告")
  * "明天上午提醒自己去超市买牛奶和鸡蛋" (not just "买牛奶")
  * "客户要求本周五之前提交设计方案的修改版本" (not just "提交方案")
- Do NOT copy raw screen text, UI elements, file paths, or code
- Do NOT use fragmented keywords or phrases without proper sentence structure
- If you cannot form a complete, contextual sentence, set actionable to false

CRITICAL rules for "due_time" field:
- due_time must be a specific future date/time in ISO 8601 format: "YYYY-MM-DDTHH:mm"
- The current date/time will be provided in each request. All due_time values MUST be AFTER the current time.
- Convert relative expressions: "明天下午3点" → next day at 15:00, "今天5pm" → today at 17:00
- If the resolved time would be in the past, push it to the next day
- If no time is mentioned or cannot be determined, set to null

Respond ONLY with JSON, no other text:
{"actionable": bool, "type": "reminder"|"todo"|"meeting"|"deadline"|"note", "content": "一句话中文总结", "due_time": "YYYY-MM-DDTHH:mm or null"}`;

const HOTKEY_SYSTEM_PROMPT = `You analyze screen text captured when the user explicitly pressed a hotkey, meaning they WANT you to find actionable content. Be MORE lenient — the user is actively requesting analysis, so lower your threshold for "actionable".

Mark as actionable (true) if there is ANY hint of:
- Tasks, todos, reminders, appointments, deadlines
- Messages that might need a reply
- Content the user might want to remember or act on
- Shopping lists, notes, calendar items
- Any text that describes something to DO, BUY, SEND, READ, CHECK, or ATTEND

Only mark as NOT actionable if the screen contains absolutely nothing useful — pure code, empty UI, or completely irrelevant content.

CRITICAL rules for "content" field:
- Write a COMPLETE, well-organized sentence in Chinese with full context
- The sentence must be self-explanatory without requiring the user to see the original screen
- Include WHO (if mentioned), WHAT (the action), WHEN (if time-sensitive), and WHY (if context helps)
- Use natural, flowing language with proper grammar — NOT fragmented phrases or keywords
- Examples of GOOD content:
  * "下午3点需要参加团队周会" (not just "3点开会")
  * "记得今天下班前完成项目报告的初稿" (not just "完成报告")
  * "明天上午提醒自己去超市买牛奶和鸡蛋" (not just "买牛奶")
- Do NOT copy raw screen text, UI elements, file paths, or code
- Do NOT use fragmented keywords or phrases without proper sentence structure
- If you truly cannot find anything meaningful, set actionable to false

CRITICAL rules for "due_time" field:
- due_time must be a specific future date/time in ISO 8601 format: "YYYY-MM-DDTHH:mm"
- The current date/time will be provided in each request. All due_time values MUST be AFTER the current time.
- Convert relative expressions: "明天下午3点" → next day at 15:00, "今天5pm" → today at 17:00
- If the resolved time would be in the past, push it to the next day
- If no time is mentioned or cannot be determined, set to null

Respond ONLY with JSON, no other text:
{"actionable": bool, "type": "reminder"|"todo"|"meeting"|"deadline"|"note", "content": "一句话中文总结", "due_time": "YYYY-MM-DDTHH:mm or null"}`;

export interface DetectOptions {
  hotkeyTriggered?: boolean;
}

function isGarbled(text: string): boolean {
  if (!text || text.length < 2) return true;
  // Count readable characters (CJK, alphanumeric, common punctuation, spaces)
  const readable = text.match(/[\w\s\u4e00-\u9fff\u3000-\u303f.,;:!?]/g) || [];
  const ratio = readable.length / text.length;
  // If less than 50% readable, it's garbled
  return ratio < 0.5;
}

function isCodeLine(line: string): boolean {
  const codePatterns = /^(import |export |const |let |var |function |class |if\s*\(|for\s*\(|return |await |async |\{|\}|\/\/|<\/|=>|\.then|\.catch|console\.|npm |bun |curl )/;
  const symbolRatio = (line.match(/[{}();=<>|&]/g) || []).length / Math.max(line.length, 1);
  return codePatterns.test(line.trim()) || symbolRatio > 0.15;
}

function cleanOcrText(texts: string[]): string {
  const result: string[] = [];

  for (const text of texts) {
    const lines = text.split(/[\n\r]+/);
    const kept: string[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.length < 3) continue;
      if (isCodeLine(trimmed)) continue;
      kept.push(trimmed);
    }
    if (kept.length > 0) {
      result.push(kept.join(" "));
    }
  }

  const combined = result.join("\n").substring(0, 4000);
  return combined;
}

function extractJson(text: string): IntentResult | null {
  // Try to find JSON object
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  let jsonStr = jsonMatch[0];

  // Fix common model issues: truncated JSON
  if (!jsonStr.endsWith("}")) jsonStr += "}";
  // Fix unquoted values
  jsonStr = jsonStr.replace(/:\s*null\b/g, ': null');

  const validTypes = ["reminder", "todo", "meeting", "deadline", "note"];

  try {
    const parsed = JSON.parse(jsonStr);
    const type = validTypes.includes(parsed.type) ? parsed.type : "note";
    return {
      actionable: Boolean(parsed.actionable),
      type,
      content: String(parsed.content || "").substring(0, 200),
      due_time: parsed.due_time && String(parsed.due_time) !== "null" ? String(parsed.due_time) : null,
    };
  } catch {
    // Last resort: regex extract fields
    try {
      const actionable = /"actionable"\s*:\s*(true|false)/.exec(jsonStr);
      const contentMatch = /"content"\s*:\s*"([^"]*)"/.exec(jsonStr);
      const typeMatch = /"type"\s*:\s*"([^"]*)"/.exec(jsonStr);
      const dueMatch = /"due_time"\s*:\s*"([^"]*)"/.exec(jsonStr);

      if (actionable) {
        const validType = validTypes.includes(typeMatch?.[1] || "") ? typeMatch![1] : "note";
        return {
          actionable: actionable[1] === "true",
          type: validType as IntentResult["type"],
          content: contentMatch?.[1] || "",
          due_time: dueMatch?.[1] || null,
        };
      }
    } catch {}
    return null;
  }
}

export async function detectIntent(
  batch: Batch,
  options?: DetectOptions
): Promise<IntentResult | null> {
  const hotkeyTriggered = options?.hotkeyTriggered ?? false;
  const appsStr = [...batch.apps].join(", ");
  const cleanedText = cleanOcrText(batch.texts);

  if (cleanedText.length < 5) {
    console.log("[intent] text too short after cleaning, skipping");
    return null;
  }

  const systemPrompt = hotkeyTriggered ? HOTKEY_SYSTEM_PROMPT : SYSTEM_PROMPT;

  const now = new Date();
  const localTime = now.toLocaleString("zh-CN", { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
  const isoDate = now.toISOString().slice(0, 16);

  const userPrompt = `Current date/time: ${localTime} (${isoDate})

Screen text from [${appsStr}]:
${cleanedText}

JSON:`;

  try {
    console.log(
      `[intent] analyzing ${cleanedText.length} chars from [${appsStr}]${hotkeyTriggered ? " (hotkey mode)" : ""}`
    );
    console.log(`[intent] cleaned text sample: "${cleanedText.substring(0, 200)}${cleanedText.length > 200 ? "..." : ""}"`);

    const t0 = Date.now();
    const res = await fetch(OLLAMA_CHAT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: DEFAULT_OLLAMA_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        stream: false,
        think: false,
        options: { temperature: 0.1, num_predict: 300 },
      }),
    });

    const latency = Date.now() - t0;

    if (!res.ok) {
      console.error(`[intent] ollama HTTP ${res.status} (${latency}ms)`);
      return null;
    }

    const rawBody = await res.text();
    const data = JSON.parse(rawBody);
    const content = data.message?.content || "";

    const trimmed = content.replace(/```json?/g, "").replace(/```/g, "").trim();
    if (!trimmed) {
      console.log(`[intent] empty response (${latency}ms)`);
      return { actionable: false, type: "note", content: "", due_time: null };
    }

    console.log(`[intent] LLM response (${latency}ms): ${trimmed.substring(0, 300)}`);

    const result = extractJson(trimmed);
    if (!result) {
      console.log("[intent] JSON parse failed, raw was:", trimmed.substring(0, 500));
      return null;
    }

    // Filter out garbage/garbled content from bad OCR
    if (result.actionable && isGarbled(result.content)) {
      console.log(`[intent] content looks garbled, ignoring: "${result.content}"`);
      return { actionable: false, type: "note", content: "", due_time: null };
    }

    console.log(
      `[intent] => actionable=${result.actionable}, type=${result.type}, content="${result.content}", due="${result.due_time}"`
    );

    return result;
  } catch (error) {
    console.error("[intent] error:", error);
    return null;
  }
}
