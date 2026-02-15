import type { LlmProvider, ChatMessage, ChatOptions } from "../llm-provider";
import { debugLog } from "../pipeline-logger";

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const MAX_RETRIES = 2;

interface GeminiConfig {
  apiKey: string;
  model: string;
}

function summarizeText(text: string, limit = 500): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return "(empty)";
  return flat.length > limit ? `${flat.slice(0, limit)}...` : flat;
}

function buildProviderError(
  message: string,
  meta?: {
    reason?: string;
    status?: number;
    responseText?: string;
    cause?: unknown;
  }
): Error {
  const err = new Error(message);
  const target = err as Error & {
    reason?: string;
    provider?: string;
    status?: number;
    responseText?: string;
    cause?: unknown;
  };
  target.provider = "gemini";
  if (meta?.reason) target.reason = meta.reason;
  if (typeof meta?.status === "number") target.status = meta.status;
  if (meta?.responseText) target.responseText = meta.responseText;
  if (meta?.cause) target.cause = meta.cause;
  return err;
}

export function createGeminiProvider(config: GeminiConfig): LlmProvider {
  const model = config.model;

  return {
    async chat(messages: ChatMessage[], options?: ChatOptions): Promise<string> {
      const url = `${BASE_URL}/${model}:generateContent?key=${config.apiKey}`;

      // Convert chat messages to Gemini format
      // Gemini uses systemInstruction for system messages and contents for user messages
      const systemParts: string[] = [];
      const contents: { role: string; parts: { text: string }[] }[] = [];

      for (const msg of messages) {
        if (msg.role === "system") {
          systemParts.push(msg.content);
        } else {
          contents.push({
            role: "user",
            parts: [{ text: msg.content }],
          });
        }
      }

      const body: Record<string, unknown> = {
        contents,
        generationConfig: {
          temperature: options?.temperature ?? 0.2,
          maxOutputTokens: options?.maxTokens ?? 500,
          responseMimeType: "application/json",
        },
      };

      if (systemParts.length > 0) {
        body.systemInstruction = {
          parts: systemParts.map((text) => ({ text })),
        };
      }

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        const t0 = Date.now();
        let res: Response;
        try {
          res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
        } catch (error) {
          throw buildProviderError("Gemini API network error", {
            reason: "network_error",
            cause: error,
          });
        }

        const latency = Date.now() - t0;

        if (!res.ok) {
          const raw = await res.text().catch(() => "");
          const responseText = summarizeText(raw);
          if (res.status === 429) {
            throw buildProviderError(`Gemini API rate limited (${latency}ms) — retry later`, {
              reason: "rate_limited",
              status: res.status,
              responseText,
            });
          } else if (res.status === 401 || res.status === 403) {
            throw buildProviderError(`Gemini API auth failed (${res.status}) — check API key`, {
              reason: "auth_failed",
              status: res.status,
              responseText,
            });
          } else {
            throw buildProviderError(`Gemini API error ${res.status} (${latency}ms)`, {
              reason: "http_error",
              status: res.status,
              responseText,
            });
          }
        }

        const data = await res.json();
        const candidate = data.candidates?.[0];
        const finishReason = candidate?.finishReason;
        const parts = candidate?.content?.parts;
        const text = Array.isArray(parts)
          ? parts
            .map((part: { text?: string }) => (typeof part?.text === "string" ? part.text : ""))
            .join("")
          : "";

        // Check if response is valid JSON when we requested JSON mode
        const isValidJson = (() => {
          try {
            const match = text.match(/\{[\s\S]*\}/);
            if (!match) return false;
            JSON.parse(match[0]);
            return true;
          } catch {
            return false;
          }
        })();

        if (finishReason && finishReason !== "STOP") {
          debugLog(`[gemini] response (${latency}ms, ${text.length} chars) finishReason=${finishReason}`);
        } else {
          debugLog(`[gemini] response (${latency}ms, ${text.length} chars)`);
        }

        if (!isValidJson && attempt < MAX_RETRIES) {
          debugLog(`[gemini] invalid JSON on attempt ${attempt + 1}, retrying... raw: "${text.substring(0, 80)}"`);
          continue;
        }

        return text;
      }

      // Should not reach here, but just in case
      return "";
    },
  };
}
