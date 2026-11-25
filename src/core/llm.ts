/** Provider-neutral model contract. Adapters live in src/providers. */
export interface ToolSpec {
  name: string;
  description: string;
  schema: Record<string, unknown>; // JSON Schema
}

export interface ToolCall { id: string; name: string; input: unknown }
export interface ToolResult { callId: string; content: string; isError?: boolean }

export type Message =
  | { role: "user"; text: string }
  | {
      role: "assistant";
      text: string;
      toolCalls: ToolCall[];
      /** The provider's own message, replayed verbatim to that provider (e.g. thinking blocks). */
      native?: { provider: string; content: unknown };
    }
  | { role: "tool"; results: ToolResult[] };

export type AssistantMessage = Extract<Message, { role: "assistant" }>;

export interface LLMRequest {
  system: string;
  messages: readonly Message[];
  tools: readonly ToolSpec[];
  signal?: AbortSignal;
  onText?: (delta: string) => void;
}

export interface LLMResponse {
  message: AssistantMessage;
  stop: "end" | "tools" | "length" | "refused";
}

export interface LLM { complete(request: LLMRequest): Promise<LLMResponse> }
