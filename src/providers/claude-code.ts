import { createSdkMcpServer, query, tool as sdkTool } from "@anthropic-ai/claude-agent-sdk";
import { type AgentHooks, type Assistant, runTool, SYSTEM, type Turn, withNow } from "../core/agent.ts";
import type { Tool } from "../core/tools.ts";

const SERVER = "savi";
/** Light on plan limits, and as accurate as larger models on calendar requests. */
const DEFAULT_MODEL = "haiku";
const PREFIX = `mcp__${SERVER}__`;

export interface ClaudeCodeOptions {
  /** The user's own Claude Code executable; it handles sign-in itself. */
  executable: string;
  /** An otherwise empty working directory. */
  cwd: string;
  model?: string;
}

/** Runs the conversation in the installed Claude Code with only Savi's tools available. */
export class ClaudeCode implements Assistant {
  private options: ClaudeCodeOptions;
  private tools: Tool[];

  constructor(options: ClaudeCodeOptions, tools: Tool[]) {
    this.options = options;
    this.tools = tools;
  }

  async send(turn: Turn, hooks: AgentHooks, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const abortController = new AbortController();
    const abort = () => abortController.abort();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const run = query({
        prompt: prompt(turn),
        options: {
          pathToClaudeCodeExecutable: this.options.executable,
          cwd: this.options.cwd,
          model: this.options.model || DEFAULT_MODEL,
          env: subscriptionEnv(process.env),
          persistSession: false, // Savi keeps the record
          abortController,
          systemPrompt: SYSTEM,
          tools: [], // no shell, files or web
          settingSources: [],
          skills: [],
          strictMcpConfig: true,
          mcpServers: { [SERVER]: this.server(hooks, abortController.signal) },
          allowedTools: this.tools.map((t) => PREFIX + t.spec.name),
          permissionMode: "dontAsk", // anything not listed above is denied
          includePartialMessages: true,
          maxTurns: 12,
        },
      });
      for await (const m of run) {
        if (m.type === "stream_event") {
          if (m.parent_tool_use_id === null && m.event.type === "content_block_delta" && m.event.delta.type === "text_delta")
            hooks.onText?.(m.event.delta.text);
        } else if (m.type === "result") {
          if (m.subtype !== "success") throw new Error(m.errors.join(" ") || `Claude Code stopped: ${m.subtype}`);
          if (m.is_error) throw new Error(m.result);
        }
      }
      signal?.throwIfAborted();
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  private server(hooks: AgentHooks, signal: AbortSignal) {
    // One at a time, so approvals never overlap and writes keep their order.
    let queue: Promise<unknown> = Promise.resolve();
    return createSdkMcpServer({
      name: SERVER,
      alwaysLoad: true,
      timeout: 10 * 60_000, // approval may take a while
      tools: this.tools.map((t) =>
        sdkTool(t.spec.name, t.spec.description, t.shape, async (input) => {
          const result = queue.then(() => runTool(t, input, hooks, signal));
          queue = result;
          const { content, isError } = await result;
          return { content: [{ type: "text" as const, text: content }], isError };
        }),
      ),
    });
  }
}

/** JSON keeps past text from being mistaken for the tags around it. */
export function prompt({ text, context }: Turn) {
  const past = JSON.stringify(context).replaceAll("<", "\\u003c");
  return (context.length ? `<conversation_so_far>${past}</conversation_so_far>\n` : "") + withNow(text);
}

/** Drops API credentials (which would be billed separately) and variables of an enclosing Claude Code session. */
export function subscriptionEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([k]) => !/^ANTHROPIC_(API_KEY|AUTH_TOKEN|BASE_URL)$/.test(k) && !/^CLAUDECODE$|^CLAUDE_CODE_|^ELECTRON_|^VSCODE_|^SAVI_/.test(k),
    ),
  );
}
