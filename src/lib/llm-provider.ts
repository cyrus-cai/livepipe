export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
}

export interface LlmProvider {
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<string>;
}
