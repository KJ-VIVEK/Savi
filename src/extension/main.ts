import { existsSync } from "node:fs";
import * as vscode from "vscode";
import { type Kind, KINDS, PRIORITIES, type Priority } from "../core/calendar.ts";
import { addDays, isDateOnly, isValidWhen, normalizeWhen, toDate, toLocal } from "../core/time.ts";
import * as autostart from "./autostart.ts";
import { Agenda, type Node } from "./agenda.ts";
import { ChatView } from "./chat.ts";
import { Client } from "./client.ts";
import { showHistory } from "./history.ts";

declare const BUILD: string;

/** The setting if given, else the executable inside the Claude Code extension. */
function findClaudeCode(): string {
  const set = vscode.workspace.getConfiguration("savi").get("claudeCode.path", "").trim();
  if (set) return set;
  const extension = vscode.extensions.getExtension("anthropic.claude-code");
  const file = process.platform === "win32" ? "claude.exe" : "claude";
  const path = extension && vscode.Uri.joinPath(extension.extensionUri, "resources", "native-binary", file).fsPath;
  return path && existsSync(path) ? path : "";
}

export function activate(context: vscode.ExtensionContext) {
  const config = () => vscode.workspace.getConfiguration("savi");
  const provider = () => config().get("llm.provider", "claude-code");
  const report = (e: unknown) => void vscode.window.showErrorMessage(`Savi: ${e instanceof Error ? e.message : String(e)}`);

  const script = vscode.Uri.joinPath(context.extensionUri, "dist", "service.cjs").fsPath;

  const client: Client = new Client({
    script,
    build: BUILD,
    config: () => ({
      provider: provider(), model: config().get("llm.model", ""),
      confirm: config().get<"all" | "modify">("confirm", "modify"), claudePath: findClaudeCode(),
      phone: config().get("phone.enabled", false), phoneInterface: config().get("phone.interface", "wt0"),
      stayAwake: config().get("stayAwake", true), webSearch: config().get("webSearch", true),
      expertModel: config().get("llm.expertModel", ""),
      codeProjects: config().get<string[]>("code.projects", []), codeModel: config().get("code.model", ""),
    }),
    onEvent: (e) => {
      if (e.event === "agenda") agenda.refresh();
      else if (e.event === "openUrl") void vscode.env.openExternal(vscode.Uri.parse(e.url));
      else chat.post(e);
    },
    onOpen: () => {
      void chat.sync();
      agenda.refresh();
    },
  });
  const agenda: Agenda = new Agenda(client);
  const chat: ChatView = new ChatView(context.extensionUri, client);

  const setApiKey = async () => {
    if (provider() === "claude-code") {
      void vscode.window.showInformationMessage("Chat uses your Claude Code sign-in, so no API key is needed.");
      return;
    }
    const key = (await vscode.window.showInputBox({
      title: "Claude API key", prompt: "From platform.claude.com. Stored in your system keyring.",
      password: true, ignoreFocusOut: true,
    }))?.trim();
    if (key) await client.call("setApiKey", { key });
  };

  const act = (tool: string, input: unknown) => client.call("act", { tool, input });

  const openGuide = () =>
    vscode.commands.executeCommand("markdown.showPreview", vscode.Uri.joinPath(context.extensionUri, "docs", "google-setup.md"));

  const connectGoogle = async () => {
    if (!(await client.call("googleHasClient", {})) && !(await importClient())) return;
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Waiting for Google sign-in in your browser", cancellable: true },
      (_, cancel) => {
        cancel.onCancellationRequested(() => void client.call("googleCancel", {}).catch(report));
        return client.call("googleConnect", {});
      },
    );
    void vscode.window.showInformationMessage("Savi is connected to Google.");
  };

  const importClient = async () => {
    const choice = await vscode.window.showInformationMessage(
      "Savi needs your Google OAuth client file (one-time setup).", "Choose File", "Show Guide");
    if (choice === "Show Guide") await openGuide();
    if (choice !== "Choose File") return false;
    const [file] = (await vscode.window.showOpenDialog({ filters: { JSON: ["json"] }, title: "Google OAuth client file" })) ?? [];
    if (!file) return false;
    await client.call("googleSetClient", { json: new TextDecoder().decode(await vscode.workspace.fs.readFile(file)) });
    return true;
  };

  const pickPriority = () =>
    vscode.window.showQuickPick<vscode.QuickPickItem & { value?: Priority }>(
      [{ label: "none" }, ...PRIORITIES.map((value) => ({ label: value, value }))],
      { title: "Priority" },
    );

  const addEvent = async () => {
    const kind = (await vscode.window.showQuickPick(KINDS, { title: "Add to calendar" })) as Kind | undefined;
    if (!kind) return;
    const title = await vscode.window.showInputBox({ title: `Add ${kind}`, prompt: "Title" });
    if (!title?.trim()) return;
    const startText = await vscode.window.showInputBox({
      title: `Add ${kind}`, prompt: "Start: YYYY-MM-DD HH:MM, or YYYY-MM-DD for all day",
      value: toLocal(new Date(Date.now() + 3_600_000)).slice(0, 14).replace("T", " ") + "00",
      validateInput: (v) => (isValidWhen(v.trim().replace(" ", "T")) ? undefined : "Use YYYY-MM-DD HH:MM or YYYY-MM-DD"),
    });
    if (!startText) return;
    const start = normalizeWhen(startText.trim().replace(" ", "T"));
    const allDay = isDateOnly(start);
    let end: string | undefined;
    if (kind === "event") {
      const length = await vscode.window.showInputBox({
        title: "Add event", prompt: allDay ? "Number of days" : "Length in minutes", value: allDay ? "1" : "60",
        validateInput: (v) => (/^[1-9]\d{0,4}$/.test(v.trim()) ? undefined : "Enter a positive number"),
      });
      if (!length) return;
      end = allDay
        ? addDays(start, Number(length) - 1)
        : new Date(Date.parse(`${start}Z`) + Number(length) * 60_000).toISOString().slice(0, 19);
    }
    const priority = await pickPriority();
    if (!priority) return;
    await act("create_event", { kind, title: title.trim(), start, end, priority: priority.value });
  };

  const addTask = async () => {
    const title = await vscode.window.showInputBox({ title: "Add task", prompt: "Title" });
    if (!title?.trim()) return;
    const due = await vscode.window.showInputBox({
      title: "Add task", prompt: "Due date, or empty for none", placeHolder: toDate(new Date()),
      validateInput: (v) => (!v.trim() || (isDateOnly(v.trim()) && isValidWhen(v.trim())) ? undefined : "Use YYYY-MM-DD"),
    });
    if (due === undefined) return;
    const priority = await pickPriority();
    if (!priority) return;
    await act("create_task", { title: title.trim(), priority: priority.value, due: due.trim() || undefined });
  };

  const deleteItem = async (n: Node) => {
    if (n.kind === "group") return;
    const detail = n.kind === "event" ? n.event.title : n.task.title;
    if ((await vscode.window.showWarningMessage("Delete this?", { modal: true, detail }, "Delete")) !== "Delete") return;
    await (n.kind === "event" ? act("delete_event", { id: n.event.id }) : act("delete_task", { id: n.task.id }));
  };

  const pairPhone = async () => {
    if (!config().get("phone.enabled", false)) {
      const ok = await vscode.window.showInformationMessage("Turn on phone access?", {
        modal: true,
        detail: "Savi will start when you log in and listen on your private network (NetBird) address. Only paired devices can use it.",
      }, "Turn On");
      if (!ok) return;
      await autostart.enable(script);
      await config().update("phone.enabled", true, vscode.ConfigurationTarget.Global);
      await client.configure();
    }
    const { url, certificateUrl, code } = await client.call("phonePair", {});
    await vscode.window.showInformationMessage(`Pairing code: ${code.slice(0, 4)} ${code.slice(4)}`, {
      modal: true,
      detail: `Valid for 10 minutes, for one device.\n\nOn your phone, with NetBird on:\n\nFirst time: open ${certificateUrl} and follow the steps there.\n\nAlready installed the certificate: open ${url}`,
    });
  };

  const phoneDevices = async () => {
    const devices = await client.call("phoneDevices", {});
    if (!devices.length) return void vscode.window.showInformationMessage("No phones are paired.");
    const when = (s: string) => new Date(s).toLocaleString();
    const pick = await vscode.window.showQuickPick(
      devices.map((d) => ({ label: `${d.name} ${d.id}`, description: `paired ${when(d.pairedAt)}, last used ${when(d.seenAt)}`, id: d.id })),
      { title: "Paired devices: choose one to remove" },
    );
    if (!pick) return;
    const ok = await vscode.window.showWarningMessage(`Remove ${pick.label}?`, { modal: true, detail: "It will need a new code to connect again." }, "Remove");
    if (ok) await client.call("phoneRemove", { id: pick.id });
  };

  const phoneOff = async () => {
    await config().update("phone.enabled", false, vscode.ConfigurationTarget.Global);
    await client.configure();
    await autostart.disable();
    void vscode.window.showInformationMessage("Phone access is off, and Savi no longer starts at login.");
  };

  const command = (id: string, run: (node: Node) => unknown) =>
    vscode.commands.registerCommand(`savi.${id}`, async (node: Node) => {
      try {
        await run(node);
      } catch (e) {
        report(e);
      }
    });

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("savi.chat", chat, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.window.registerTreeDataProvider("savi.agenda", agenda),
    command("connectGoogle", connectGoogle),
    command("disconnectGoogle", () => client.call("googleDisconnect", {})),
    command("setApiKey", setApiKey),
    command("clearApiKey", () => client.call("setApiKey", { key: "" })),
    command("pairPhone", pairPhone),
    command("phoneDevices", phoneDevices),
    command("phoneOff", phoneOff),
    command("history", () => showHistory(client, report)),
    command("openGuide", openGuide),
    command("addEvent", addEvent),
    command("addTask", addTask),
    command("refresh", () => agenda.refresh()),
    command("newChat", () => client.call("newConversation", {})),
    command("completeTask", async (n) => {
      if (n.kind === "task") await act("update_task", { id: n.task.id, completed: true });
    }),
    command("openItem", (n) => {
      if (n.kind === "event" && n.event.url) return vscode.env.openExternal(vscode.Uri.parse(n.event.url));
    }),
    command("deleteItem", deleteItem),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("savi")) void client.configure().catch(report);
      if (e.affectsConfiguration("savi.agendaDays")) agenda.refresh();
    }),
    // Claude Code's folder changes when it updates.
    vscode.extensions.onDidChange(() => void client.configure().catch(report)),
    { dispose: () => client.dispose() },
  );
}
