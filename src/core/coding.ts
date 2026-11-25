import { z } from "zod";
import { tool, type Tool } from "./tools.ts";

export interface CodingSession { project: string; startedAt: string; link?: string }

/** Starts coding sessions the user then drives elsewhere. Savi itself never edits code. */
export interface Coding {
  projects(): string[];
  sessions(): CodingSession[];
  start(project: string): Promise<CodingSession>;
  stop(project: string): Promise<void>;
}

export function createCodingTools(coding: Coding): Tool[] {
  const project = z.string().min(1).describe("A project name from list_coding");
  return [
    tool({
      name: "list_coding",
      description: "List the code projects on this PC that can be opened for coding, and the coding sessions running now.",
      effect: "read",
      schema: z.strictObject({}),
      run: async () => ({ projects: coding.projects(), running: coding.sessions() }),
    }),
    tool({
      name: "start_coding",
      description:
        "Open a Claude Code Remote Control session on one project, which the user then drives from the Code tab of the Claude app. Use it only when the user mentions the Claude app or Remote Control by name; otherwise use connect_project. You cannot write code in it yourself: give the user the link, or tell them to open the Code tab.",
      effect: "modify", // always asks: the session can run commands on this PC
      schema: z.strictObject({ project }),
      describe: ({ project: p }) => `Start a coding session on "${p}"\nIt can edit files and run commands on this PC, asking you in the Claude app first.`,
      run: ({ project: p }) => coding.start(p),
    }),
    tool({
      name: "stop_coding",
      description: "Stop the coding session on one project. Work in progress in it is interrupted; saved files stay.",
      effect: "modify",
      schema: z.strictObject({ project }),
      describe: ({ project: p }) => `Stop the coding session on "${p}"`,
      run: async ({ project: p }) => {
        await coding.stop(p);
        return { stopped: true };
      },
    }),
  ];
}
