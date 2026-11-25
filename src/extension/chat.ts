import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import type { Event } from "../service/protocol.ts";
import type { Client } from "./client.ts";

type FromView =
  | { type: "ready" } | { type: "send"; text: string } | { type: "stop" }
  | { type: "approve"; id: string; allow: boolean; all?: boolean } | { type: "disconnect" };

/** Windows onto the shared conversation, in the sidebar and an editor tab. They hold no state. */
export class ChatView implements vscode.WebviewViewProvider {
  private side?: vscode.WebviewView;
  private tab?: vscode.WebviewPanel;
  private extensionUri: vscode.Uri;
  private client: Client;

  constructor(extensionUri: vscode.Uri, client: Client) {
    this.extensionUri = extensionUri;
    this.client = client;
  }

  resolveWebviewView(view: vscode.WebviewView) {
    this.side = view;
    view.onDidDispose(() => (this.side = undefined));
    this.fill(view.webview);
  }

  openTab() {
    if (this.tab) return this.tab.reveal();
    this.tab = vscode.window.createWebviewPanel("savi.chatTab", "Savi", vscode.ViewColumn.Active, { retainContextWhenHidden: true });
    this.tab.iconPath = vscode.Uri.joinPath(this.extensionUri, "media", "app", "icon.svg");
    this.tab.onDidDispose(() => (this.tab = undefined));
    this.fill(this.tab.webview);
  }

  /** Shows the whole conversation again, e.g. after reconnecting. */
  async sync() {
    await Promise.all(this.webviews().map((w) => this.syncOne(w)));
  }

  post(e: Event) {
    for (const w of this.webviews()) void w.postMessage(e);
    if (e.event === "approval" && !this.side?.visible && !this.tab?.visible)
      void vscode.window.showInformationMessage("Savi needs your approval.", "Show").then((c) => c && vscode.commands.executeCommand("savi.chat.focus"));
  }

  private webviews() {
    return [this.side?.webview, this.tab?.webview].filter((w) => w !== undefined);
  }

  private fill(webview: vscode.Webview) {
    const media = vscode.Uri.joinPath(this.extensionUri, "media");
    webview.options = { enableScripts: true, localResourceRoots: [media] };
    const uri = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(media, f));
    const nonce = randomBytes(16).toString("base64");
    webview.onDidReceiveMessage((m: FromView) => void this.receive(m, webview));
    webview.html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${uri("chat.css")}"></head>
<body>
<div id="project" hidden><span></span><button type="button" class="secondary">Disconnect</button></div>
<main id="log" aria-live="polite"></main>
<div class="dock">
      <button type="button" id="jump" class="secondary" hidden>Latest</button>
      <form id="form">
        <textarea id="input" rows="1" aria-label="Message Savi" placeholder="Ask Savi anything"></textarea>
        <button id="button" type="submit">Send</button>
      </form>
    </div>
<script nonce="${nonce}" src="${uri("markdown.js")}"></script>
<script nonce="${nonce}" src="${uri("chat.js")}"></script>
</body></html>`;
  }

  private async syncOne(webview: vscode.Webview) {
    try {
      const event: Event = { event: "state", state: await this.client.call("state", {}) };
      void webview.postMessage(event);
    } catch (e) {
      this.fail(e, webview);
    }
  }

  private async receive(m: FromView, webview: vscode.Webview) {
    try {
      if (m.type === "ready") await this.syncOne(webview);
      else if (m.type === "send") await this.client.call("send", { text: m.text });
      else if (m.type === "stop") await this.client.call("stop", {});
      else if (m.type === "disconnect") await this.client.call("disconnect", {});
      else await this.client.call("approve", { id: m.id, allow: m.allow, all: m.all });
    } catch (e) {
      this.fail(e, webview);
    }
  }

  private fail(e: unknown, webview: vscode.Webview) {
    void webview.postMessage({ event: "failed", problem: e instanceof Error ? e.message : String(e) });
  }
}
