import { z } from "zod";
import type { Assistant } from "./agent.ts";
import { tool, type Tool } from "./tools.ts";

/** Lets a light model hand a hard question to a stronger one, which has no Savi tools. */
export function createExpertTool(create: () => Promise<Assistant>): Tool {
  return tool({
    name: "ask_expert",
    description:
      "Ask a stronger model. Use it for hard questions: careful reasoning, planning, long writing, maths, code explanations or in-depth comparisons. Do not use it for calendar, tasks, history or simple facts. Put everything it needs in the question, as it sees nothing else. Pass its answer on in full.",
    effect: "read",
    schema: z.strictObject({ question: z.string().min(1) }),
    run: async ({ question }) => {
      const assistant = await create();
      let answer = "";
      await assistant.send({ text: question, context: [] }, {
        onText: (d) => (answer += d), needsApproval: () => true, approve: async () => false,
      }, AbortSignal.timeout(4 * 60_000));
      return { answer };
    },
  });
}
