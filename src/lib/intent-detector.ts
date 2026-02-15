import type { IntentResult } from "./schemas";
import type { Batch } from "./batch-aggregator";
import { DEFAULT_OLLAMA_MODEL, OLLAMA_CHAT_URL } from "./constants";
import { debugError, debugLog } from "./pipeline-logger";

const SYSTEM_PROMPT = `You are an intent detector for OCR screen text. Decide independently whether content is actionable and/or noteworthy. Do NOT rewrite, translate, or summarize.

Your decisions:
1. "actionable": true only if user should take action (task, reminder, meeting, deadline, reply).
2. "noteworthy": true only if content is worth recording even without action (decision, valuable fact, reference context).
3. "content": extract original relevant phrase only (keep original language).
4. "due_time": parse time to ISO only when actionable time exists.
5. "urgent": true when wording implies high urgency/deadline pressure.

Hard reject rules:
- UI labels/buttons/menus are NOT actionable and NOT noteworthy.
- Ads/promo/newsletter CTA/polls are NOT actionable and NOT noteworthy.
- Code/log/terminal/system text is NOT actionable and NOT noteworthy.
- Quoted examples/tutorial principles/translations are NOT actionable and usually NOT noteworthy.
- Explicit no-action statements are NOT actionable.

Actionable rules:
- Direct requests or commitments with clear action target are actionable.
- Meetings/deadlines with future schedule are actionable.
- If cancellation + new time both appear, use the new schedule.
- In mixed text, extract only the real actionable sentence.

Noteworthy rules:
- Should be true for decisions, useful facts, reference links/info worth reviewing later.
- Should be false for noise, generic slogans, UI text, ads, random fragments, code.
- Can be true together with actionable.

Urgent rules:
- true when there is explicit urgency/deadline pressure: "ASAP", "立即", "马上", "今天下班前", "before 5pm", "紧急".
- false otherwise.

CRITICAL rules for "content":
- Extract original wording only; no translation.
- Keep only relevant actionable/noteworthy phrase.
- Maximum 200 characters.

CRITICAL rules for "due_time":
- ISO 8601 format: "YYYY-MM-DDTHH:mm"
- due_time must be AFTER current time.
- Convert relative expressions. If resolved time is in the past, push to next valid occurrence.
- If no actionable time is mentioned, set null.

Respond ONLY with JSON:
{"actionable": bool, "noteworthy": bool, "content": "extracted original text", "due_time": "YYYY-MM-DDTHH:mm or null", "urgent": bool}`;

const HOTKEY_SYSTEM_PROMPT = `You are a screen text intent detector. User pressed a hotkey, so be more lenient in capturing useful content. Do NOT rewrite, translate, or summarize.

Output fields:
- actionable: true if user might need to act.
- noteworthy: true if content is worth saving for later reference.
- content: original useful phrase only.
- due_time: ISO if actionable time exists, else null.
- urgent: true if urgency signals exist.

Hotkey behavior:
- Prefer capturing potentially useful intent instead of dropping.
- Still reject obvious junk: pure UI labels, ads, random OCR gibberish, code logs.
- actionable and noteworthy can both be true.

CRITICAL rules for "content":
- Keep original wording and language.
- Remove surrounding noise.
- Maximum 200 characters.

CRITICAL rules for "due_time":
- ISO 8601 format: "YYYY-MM-DDTHH:mm"
- due_time must be AFTER current time.
- Convert relative expressions to absolute time.
- If no actionable time, set null.

Respond ONLY with JSON:
{"actionable": bool, "noteworthy": bool, "content": "extracted original text", "due_time": "YYYY-MM-DDTHH:mm or null", "urgent": bool}`;

export interface DetectOptions {
  hotkeyTriggered?: boolean;
}

export interface DetectIntentResult extends IntentResult {
  latencyMs: number;
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

const NO_ACTION_PATTERNS = [
  /no action needed/i,
  /no follow-?up required/i,
  /不用回了/,
  /无需跟进/,
  /\(completed\)/i,
  /已完成/,
];

const NOISE_PATTERNS = [
  /\b(add to cart|buy now|vote now|click to read more|unsubscribe)\b/i,
  /\b(weekend sale|flash sale|super deal|promo)\b/i,
  /\b(remind me later|snooze|dismiss|enable \| not now)\b/i,
  /\bselect\s+\*[\s\S]*\bfrom\b/i,
  /\berror[\s\S]*deadline exceeded\b/i,
  /\bretry on \d{3}\b/i,
  /\bdependabot alert resolved\b/i,
];

const TASK_SIGNAL_PATTERNS = [
  /\b(don't forget to|remember to|please|could you|need to|follow up|update|submit|call|review|pay|send)\b/i,
  /记得|别忘了|请|提交|确认|发我|联系|跟进/,
];

const NOTEWORTHY_SIGNAL_PATTERNS = [
  /结论|决策|要点|纪要|复盘|根因|takeaway|decision|summary|root cause|postmortem/i,
  /参考|runbook|endpoint|wiki|文档|context|背景|链接|reference/i,
];

const URGENT_PATTERNS = [
  /\b(asap|urgent|immediately|right now)\b/i,
  /紧急|立刻|马上|尽快|立即|今晚|今天下班前|截止|最迟/,
  /\b(priority:\s*high|by\s+\w+\s+\d{1,2}:\d{2}|before\s+\d{1,2}(:\d{2})?)\b/i,
];

function hasAnyPattern(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function hasStandaloneCancellation(text: string): boolean {
  const canceled = /(canceled|cancelled|取消|已取消)/i.test(text);
  const rescheduled = /(改到|改期|moved to|reschedul)/i.test(text);
  return canceled && !rescheduled;
}

function normalizeIntentResult(result: IntentResult): IntentResult {
  const normalizedContent = result.content.trim();
  if (!normalizedContent) {
    return { actionable: false, noteworthy: false, content: "", due_time: null, urgent: false };
  }

  const normalized: IntentResult = {
    ...result,
    content: normalizedContent,
  };

  const hasTaskSignal = hasAnyPattern(normalizedContent, TASK_SIGNAL_PATTERNS);
  if (hasAnyPattern(normalizedContent, NOISE_PATTERNS) && !hasTaskSignal) {
    return { actionable: false, noteworthy: false, content: normalizedContent, due_time: null, urgent: false };
  }

  if (hasAnyPattern(normalizedContent, NO_ACTION_PATTERNS) || hasStandaloneCancellation(normalizedContent)) {
    normalized.actionable = false;
  }

  const hasNoteworthySignal = hasAnyPattern(normalizedContent, NOTEWORTHY_SIGNAL_PATTERNS);
  if (normalized.noteworthy && !hasNoteworthySignal) {
    normalized.noteworthy = false;
  }

  if (!normalized.actionable) {
    normalized.due_time = null;
  }

  normalized.urgent = hasAnyPattern(normalizedContent, URGENT_PATTERNS);

  if (!normalized.actionable && !normalized.noteworthy) {
    normalized.urgent = false;
  }

  return normalized;
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

  try {
    const parsed = JSON.parse(jsonStr);
    return {
      actionable: Boolean(parsed.actionable),
      noteworthy: Boolean(parsed.noteworthy),
      content: String(parsed.content || "").substring(0, 200),
      due_time: parsed.due_time && String(parsed.due_time) !== "null" ? String(parsed.due_time) : null,
      urgent: Boolean(parsed.urgent),
    };
  } catch {
    // Last resort: regex extract fields
    try {
      const actionable = /"actionable"\s*:\s*(true|false)/.exec(jsonStr);
      const noteworthy = /"noteworthy"\s*:\s*(true|false)/.exec(jsonStr);
      const contentMatch = /"content"\s*:\s*"([^"]*)"/.exec(jsonStr);
      const dueMatch = /"due_time"\s*:\s*"([^"]*)"/.exec(jsonStr);
      const urgent = /"urgent"\s*:\s*(true|false)/.exec(jsonStr);

      if (actionable) {
        return {
          actionable: actionable[1] === "true",
          noteworthy: noteworthy ? noteworthy[1] === "true" : false,
          content: contentMatch?.[1] || "",
          due_time: dueMatch?.[1] || null,
          urgent: urgent ? urgent[1] === "true" : false,
        };
      }
    } catch {}
    return null;
  }
}

export async function detectIntent(
  batch: Batch,
  options?: DetectOptions
): Promise<DetectIntentResult | null> {
  const requestStartedAt = Date.now();
  const hotkeyTriggered = options?.hotkeyTriggered ?? false;
  const appsStr = [...batch.apps].join(", ");
  const cleanedText = cleanOcrText(batch.texts);

  if (cleanedText.length < 5) {
    debugLog("[intent] text too short after cleaning, skipping");
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
    debugLog(
      `[intent] analyzing ${cleanedText.length} chars from [${appsStr}]${hotkeyTriggered ? " (hotkey mode)" : ""}`
    );
    debugLog(`[intent] cleaned text sample: "${cleanedText.substring(0, 200)}${cleanedText.length > 200 ? "..." : ""}"`);

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
      debugError(`[intent] ollama HTTP ${res.status} (${latency}ms)`);
      return null;
    }

    const rawBody = await res.text();
    const data = JSON.parse(rawBody);
    const content = data.message?.content || "";

    const trimmed = content.replace(/```json?/g, "").replace(/```/g, "").trim();
    if (!trimmed) {
      debugLog(`[intent] empty response (${latency}ms)`);
      return {
        actionable: false,
        noteworthy: false,
        content: "",
        due_time: null,
        urgent: false,
        latencyMs: Date.now() - requestStartedAt,
      };
    }

    debugLog(`[intent] LLM response (${latency}ms): ${trimmed.substring(0, 300)}`);

    const result = extractJson(trimmed);
    if (!result) {
      debugLog("[intent] JSON parse failed, raw was:", trimmed.substring(0, 500));
      return null;
    }

    const normalizedResult = normalizeIntentResult(result);

    // Filter out garbage/garbled content from bad OCR
    if ((normalizedResult.actionable || normalizedResult.noteworthy) && isGarbled(normalizedResult.content)) {
      debugLog(`[intent] content looks garbled, ignoring: "${normalizedResult.content}"`);
      return {
        actionable: false,
        noteworthy: false,
        content: "",
        due_time: null,
        urgent: false,
        latencyMs: Date.now() - requestStartedAt,
      };
    }

    debugLog(
      `[intent] => actionable=${normalizedResult.actionable}, noteworthy=${normalizedResult.noteworthy}, urgent=${normalizedResult.urgent}, content="${normalizedResult.content}", due="${normalizedResult.due_time}"`
    );

    return {
      ...normalizedResult,
      latencyMs: Date.now() - requestStartedAt,
    };
  } catch (error) {
    debugError("[intent] error:", error);
    return null;
  }
}
