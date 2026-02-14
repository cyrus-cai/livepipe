import type { IntentResult } from "./schemas";
import type { Batch } from "./batch-aggregator";
import { DEFAULT_OLLAMA_MODEL, OLLAMA_CHAT_URL } from "./constants";

const SYSTEM_PROMPT = `You are a strict task detector for OCR screen text. Decide whether there is a REAL user-actionable item. Do NOT rewrite, translate, or summarize.

Your decisions:
1. "actionable": true only for real tasks/reminders/meetings/deadlines.
2. "type": reminder/todo/meeting/deadline/note
3. "content": extract the ORIGINAL task phrase only (keep original language).
4. "due_time": parse time to ISO when possible.

Hard non-task rules (higher priority):
- Quoted/translation/example context is NOT a task: "这句...怎么翻", "people say", tutorials, principles, tips.
- Article/newsletter/poll/ad/CTA/UI text is NOT a task UNLESS there is a separate explicit assigned action sentence.
- App chrome/buttons/options are NOT tasks: "Remind me later", "Enable | Not now", "Vote now", "Add to cart".
- Code/log/terminal/system prompts are NOT tasks, including code comments/diffs such as "// reminder: retry on 429", "const ...", "Files changed".
- Explicit no-action statements are NOT tasks: "不用回了", "no action needed", "no follow-up required".
- "canceled" + "no follow-up required" means NOT actionable.
- Past/completed-only items are NOT tasks: "Yesterday ... (Completed)".

Task rules (apply only if non-task rules above do not match):
- Direct request assigned to user with concrete action object is actionable:
  "please update vendor bank info...", "could you follow up with Legal...", "don't forget to call the landlord at 8pm".
- Personal commitments are actionable: "我需要...", "记得...", "别忘了...", "need to...".
- Meetings/deadlines with a real future schedule are actionable.
- If cancellation + new time both appear, use the NEW schedule as actionable.
- In mixed text (noise + one task sentence), actionable=true and extract only that task sentence.
- Explicit directive sentences win over nearby promo noise:
  "记得今晚9点前把报销单提交到OA", "plz 记得 Tue 4pm 跟供应商确认交期", "Please update the vendor bank info before payment run".

Tie-break:
- If uncertain, choose actionable=false.
- Do NOT convert generic advice into a task unless it is clearly assigned.

CRITICAL rules for "content":
- Extract original wording only; no translation.
- Keep only task phrase; remove unrelated noise.
- Maximum 200 characters.

CRITICAL rules for "due_time":
- ISO 8601 format: "YYYY-MM-DDTHH:mm"
- Current date/time will be provided. due_time must be AFTER current time.
- Convert relative expressions. If resolved time is in the past, push to next day.
- If no time mentioned, set null.

Respond ONLY with JSON:
{"actionable": bool, "type": "reminder"|"todo"|"meeting"|"deadline"|"note", "content": "extracted original text", "due_time": "YYYY-MM-DDTHH:mm or null"}`;

const HOTKEY_SYSTEM_PROMPT = `You are a screen text filter. The user explicitly pressed a hotkey to capture this — they WANT you to find actionable content. Be MORE lenient. Do NOT rewrite, translate, or summarize — just extract the relevant original text.

Mark as actionable (true) if there is ANY hint of:
- Tasks, todos, reminders, appointments, deadlines
- Messages that might need a reply
- Content the user might want to remember or act on
- Shopping lists, notes, calendar items
- Any text that describes something to DO, BUY, SEND, READ, CHECK, or ATTEND

Only mark as NOT actionable if the screen contains absolutely nothing useful.

CRITICAL rules for "content":
- EXTRACT the original task text from the screen, do NOT rewrite or translate it
- Remove noise (UI elements, code, unrelated text) but keep the task phrase intact
- If the original is English, keep English. If Chinese, keep Chinese. Do NOT translate.
- You may lightly trim or combine fragments, but preserve original wording
- Maximum 200 characters

CRITICAL rules for "due_time":
- ISO 8601 format: "YYYY-MM-DDTHH:mm"
- Current date/time will be provided. All due_time must be AFTER current time.
- Convert relative expressions: "明天下午3点" → next day 15:00, "at 11AM" → today 11:00
- If resolved time is in the past, push to next day
- If no time mentioned, set to null

Respond ONLY with JSON:
{"actionable": bool, "type": "reminder"|"todo"|"meeting"|"deadline"|"note", "content": "extracted original text", "due_time": "YYYY-MM-DDTHH:mm or null"}`;

export interface DetectOptions {
  hotkeyTriggered?: boolean;
}

export function isGarbled(text: string): boolean {
  if (!text || text.length < 2) return true;
  // Count readable characters (CJK, alphanumeric, common punctuation, spaces)
  const readable = text.match(/[\w\s\u4e00-\u9fff\u3000-\u303f.,;:!?]/g) || [];
  const ratio = readable.length / text.length;
  // If less than 50% readable, it's garbled
  return ratio < 0.5;
}

export function isCodeLine(line: string): boolean {
  const codePatterns = /^(import |export |const |let |var |function |class |if\s*\(|for\s*\(|return |await |async |\{|\}|\/\/|<\/|=>|\.then|\.catch|console\.|npm |bun |curl )/;
  const symbolRatio = (line.match(/[{}();=<>|&]/g) || []).length / Math.max(line.length, 1);
  return codePatterns.test(line.trim()) || symbolRatio > 0.15;
}

export function cleanOcrText(texts: string[]): string {
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

export function extractJson(text: string): IntentResult | null {
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
