import Anthropic from "@anthropic-ai/sdk";
import type { LLM, LLMRequest, LLMResponse, Message, ToolCall } from "../core/llm.ts";

const NAME = "anthropic";
type Param = Anthropic.Beta.BetaMessageParam;

export class AnthropicLLM implements LLM {
  private client: Anthropic;
  private model: string;

  constructor(apiKey: string, model: string) {
    this.client = new Anthropic({ apiKey });
    this.model = model;
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const stream = this.client.beta.messages.stream(
      {
        model: this.model,
        max_tokens: 16000,
        system: req.system,
        messages: req.messages.map(toParam),
        // Inputs are tiny, so the API's default buffering and validation stay on.
        tools: req.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.schema as Anthropic.Beta.BetaTool.InputSchema,
        })),
        cache_control: { type: "ephemeral" },
        // Haiku has no server-side fallback.
        ...(this.model.includes("haiku") ? {} : { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }),
      },
      { signal: req.signal },
    );
    if (req.onText) stream.on("text", req.onText);

    let message: Anthropic.Beta.BetaMessage;
    try {
      message = await stream.finalMessage();
    } catch (e) {
      throw explain(e);
    }

    const toolCalls: ToolCall[] = [];
    let text = "";
    for (const block of message.content) {
      if (block.type === "text") text += block.text;
      else if (block.type === "tool_use") toolCalls.push({ id: block.id, name: block.name, input: block.input });
    }
    const stop =
      message.stop_reason === "refusal" ? "refused"
      : message.stop_reason === "max_tokens" || message.stop_reason === "model_context_window_exceeded" ? "length"
      : toolCalls.length > 0 ? "tools"
      : "end";
    return {
      message: { role: "assistant", text, toolCalls, native: { provider: NAME, content: message.content } },
      stop,
    };
  }
}

export function toParam(m: Message): Param {
  if (m.role === "user") return { role: "user", content: m.text };
  if (m.role === "tool")
    return {
      role: "user",
      content: m.results.map((r) => ({
        type: "tool_result" as const, tool_use_id: r.callId, content: r.content, is_error: r.isError ?? false,
      })),
    };
  // Our own turns go back untouched so thinking blocks stay valid.
  if (m.native?.provider === NAME) return { role: "assistant", content: m.native.content as Anthropic.Beta.BetaContentBlockParam[] };
  return {
    role: "assistant",
    content: [
      ...(m.text ? [{ type: "text" as const, text: m.text }] : []),
      ...m.toolCalls.map((c) => ({ type: "tool_use" as const, id: c.id, name: c.name, input: c.input })),
    ],
  };
}

function explain(e: unknown): unknown {
  if (e instanceof Anthropic.AuthenticationError) return new Error("The API key was rejected. Run 'Savi: Set Model API Key'.");
  if (e instanceof Anthropic.NotFoundError) return new Error("Model not found. Check the savi.llm.model setting.");
  if (e instanceof Anthropic.RateLimitError) return new Error("Rate limited. Try again shortly.");
  if (e instanceof Anthropic.APIConnectionError && !(e instanceof Anthropic.APIUserAbortError))
    return new Error("Could not reach the Claude API.");
  return e;
}
