import type { LlmProvider, ChatMessage, ChatOptions } from "../llm-provider";

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";

interface GeminiConfig {
  apiKey: string;
  model: string;
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
        },
      };

      if (systemParts.length > 0) {
        body.systemInstruction = {
          parts: systemParts.map((text) => ({ text })),
        };
      }

      const t0 = Date.now();
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const latency = Date.now() - t0;

      if (!res.ok) {
        if (res.status === 429) {
          throw new Error(`Gemini API rate limited (${latency}ms) — retry later`);
        } else if (res.status === 401 || res.status === 403) {
          throw new Error(`Gemini API auth failed (${res.status}) — check API key`);
        } else {
          throw new Error(`Gemini API error ${res.status} (${latency}ms)`);
        }
      }

      const data = await res.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";

      console.log(`[gemini] response (${latency}ms, ${text.length} chars)`);
      return text;
    },
  };
}
