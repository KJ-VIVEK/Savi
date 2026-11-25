import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import type { Event } from "../service/protocol.ts";
import type { Client } from "./client.ts";

type FromView =
  | { type: "ready" } | { type: "send"; text: string } | { type: "stop" }
  | { type: "approve"; id: string; allow: boolean };

/** A window onto the shared conversation; it holds no state of its own. */
export class ChatView implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private extensionUri: vscode.Uri;
  private client: Client;

  constructor(extensionUri: vscode.Uri, client: Client) {
    this.extensionUri = extensionUri;
    this.client = client;
  }

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    const media = vscode.Uri.joinPath(this.extensionUri, "media");
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    const uri = (f: string) => view.webview.asWebviewUri(vscode.Uri.joinPath(media, f));
    const nonce = randomBytes(16).toString("base64");
    view.webview.html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${view.webview.cspSource}; script-src 'nonce-${nonce}'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${uri("chat.css")}"></head>
<body>
<main id="log" aria-live="polite"></main>
<form id="form"><textarea id="input" rows="2" aria-label="Message Savi" placeholder="Lunch with Sam Friday at 1pm"></textarea>
<button id="button" type="submit">Send</button></form>
<script nonce="${nonce}" src="${uri("chat.js")}"></script>
</body></html>`;
    view.webview.onDidReceiveMessage((m: FromView) => void this.receive(m));
    view.onDidDispose(() => (this.view = undefined));
  }

  /** Shows the whole conversation again, e.g. after reconnecting. */
  async sync() {
    if (!this.view) return;
    try {
      this.post({ event: "state", state: await this.client.call("state", {}) });
    } catch (e) {
      this.fail(e);
    }
  }

  post(e: Event) {
    void this.view?.webview.postMessage(e);
    if (e.event === "approval" && !this.view?.visible)
      void vscode.window.showInformationMessage("Savi needs your approval.", "Show").then((c) => c && vscode.commands.executeCommand("savi.chat.focus"));
  }

  private async receive(m: FromView) {
    try {
      if (m.type === "ready") await this.sync();
      else if (m.type === "send") await this.client.call("send", { text: m.text });
      else if (m.type === "stop") await this.client.call("stop", {});
      else await this.client.call("approve", { id: m.id, allow: m.allow });
    } catch (e) {
      this.fail(e);
    }
  }

  private fail(e: unknown) {
    void this.view?.webview.postMessage({ event: "failed", problem: e instanceof Error ? e.message : String(e) });
  }
}
