import * as vscode from "vscode";
import type { Conversation, Found, StoredAction, StoredMessage } from "../core/history.ts";
import type { Client } from "./client.ts";

type Item = vscode.QuickPickItem & { conversation?: number };

const when = (iso: string) => new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/** Recent conversations; typing searches all messages and actions. */
export function showHistory(client: Client, report: (e: unknown) => void) {
  const remove: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon("trash"), tooltip: "Delete conversation" };
  const save: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon("markdown"), tooltip: "Open as Markdown" };
  const pick = vscode.window.createQuickPick<Item>();
  pick.title = "Savi history";
  pick.placeholder = "Search everything you and Savi said or did";
  let latest = 0;
  let timer: NodeJS.Timeout | undefined;

  const load = async () => {
    const mine = ++latest;
    const text = pick.value.trim();
    try {
      const items = text
        ? (await client.call("search", { text })).map(found)
        : (await client.call("conversations", {})).map(conversation);
      if (mine === latest) pick.items = items; // a slower, older search must not win
    } catch (e) {
      report(e);
    }
  };
  const conversation = (c: Conversation): Item => ({
    label: c.title, description: when(c.startedAt), conversation: c.id, alwaysShow: true, buttons: [save, remove],
  });
  const found = (f: Found): Item => ({
    label: `$(${f.kind === "action" ? "checklist" : f.role === "user" ? "account" : "comment"}) ${oneLine(f.kind === "action" ? f.summary : f.text).slice(0, 120)}`,
    description: f.kind === "action" ? `${f.outcome === "started" ? "result unknown" : f.outcome}, ${when(f.at)}` : when(f.at),
    conversation: f.conversationId ?? undefined, alwaysShow: true,
    buttons: f.conversationId ? [save] : [],
  });

  pick.onDidChangeValue(() => {
    clearTimeout(timer);
    timer = setTimeout(load, 200);
  });
  pick.onDidAccept(async () => {
    const id = pick.selectedItems[0]?.conversation;
    if (id === undefined) return;
    pick.hide();
    try {
      await client.call("openConversation", { id });
      await vscode.commands.executeCommand("savi.chat.focus");
    } catch (e) {
      report(e);
    }
  });
  pick.onDidTriggerItemButton(async ({ item, button }) => {
    const id = item.conversation!;
    try {
      if (button === save) {
        pick.hide();
        return await openMarkdown(client, id, item.label);
      }
      const ok = await vscode.window.showWarningMessage("Delete this conversation?", {
        modal: true, detail: `${item.label}\n\nIts messages and action log are removed. Daily backups keep a copy for up to 7 days of use. Your calendar is not changed.`,
      }, "Delete");
      if (ok) await client.call("deleteConversation", { id });
      showHistory(client, report); // the dialog closes the list
    } catch (e) {
      report(e);
    }
  });
  pick.onDidHide(() => {
    clearTimeout(timer);
    latest++;
    pick.dispose();
  });
  pick.show();
  void load();
}

async function openMarkdown(client: Client, id: number, title: string) {
  const { messages, actions } = await client.call("conversation", { id });
  const entries: { at: string; text: string }[] = [
    ...messages.map((m: StoredMessage) => ({
      at: m.at, text: `**${m.role === "user" ? "You" : "Savi"}**, ${when(m.at)} (${m.source})\n\n${[m.text, m.problem].filter(Boolean).join("\n\n")}`,
    })),
    ...actions.map((a: StoredAction) => ({ at: a.at, text: `> ${oneLine(a.summary)} (${a.outcome === "started" ? "result unknown" : a.outcome})` })),
  ];
  entries.sort((a, b) => a.at.localeCompare(b.at));
  const content = `# ${title}\n\n${entries.map((e) => e.text).join("\n\n")}\n`;
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: "markdown", content }));
}
