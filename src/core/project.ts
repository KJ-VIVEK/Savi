import { z } from "zod";
import { tool, type Tool } from "./tools.ts";

/** Joins the current conversation to a code project; a coding assistant then answers there. */
export interface ProjectLink {
  projects(): string[];
  connect(name: string, request?: string): void;
}

export function createProjectTools(link: ProjectLink): Tool[] {
  return [
    tool({
      name: "list_projects",
      description: "List the code projects this chat can connect to.",
      effect: "read",
      schema: z.strictObject({}),
      run: async () => ({ projects: link.projects() }),
    }),
    tool({
      name: "connect_project",
      description:
        "Connect this chat to a code project so the user can ask for features, fixes or commands here. Use it when they say to connect to, open or work on a project. If they also said what to build, put that in request. After connecting, a coding assistant takes over: reply with at most one short sentence and do not attempt the work.",
      effect: "modify", // always asks
      schema: z.strictObject({ project: z.string().min(1), request: z.string().optional() }),
      describe: ({ project, request }) =>
        `Connect to "${project}"\nSavi can read its files. Every edit and command will ask you first.${request ? `\nThen: ${request}` : ""}`,
      run: async ({ project, request }) => {
        link.connect(project, request);
        return { connected: project };
      },
    }),
  ];
}
