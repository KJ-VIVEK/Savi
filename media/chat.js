const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);
const log = $("log"), input = $("input"), button = $("button");
const cards = new Map();
let busy = false, reply = null, draft = null;

function add(kind, text) {
  const el = document.createElement("div");
  el.className = kind;
  el.textContent = text; // never HTML: content can come from calendars
  log.append(el);
  log.scrollTop = log.scrollHeight;
  return el;
}

function setBusy(value) {
  busy = value;
  reply = null;
  button.textContent = busy ? "Stop" : "Send";
}

function write(delta) {
  reply ??= add("assistant", "");
  reply.textContent += delta;
  log.scrollTop = log.scrollHeight;
}

function approval({ id, summary }) {
  reply = null;
  const card = add("approval", summary);
  const row = document.createElement("p");
  for (const [label, allow] of [["Allow", true], ["Cancel", false]]) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    if (!allow) b.className = "secondary";
    b.onclick = () => {
      for (const x of row.children) x.disabled = true;
      vscode.postMessage({ type: "approve", id, allow });
    };
    row.append(b);
  }
  card.append(row);
  log.scrollTop = log.scrollHeight;
  cards.set(id, card);
}

function message(m) {
  if (m.text) add(m.role, m.text);
  if (m.problem) add("error", m.problem);
}

function showState(s) {
  log.replaceChildren();
  cards.clear();
  const rows = [...s.messages.map((m) => ({ at: m.at, show: () => message(m) })),
    ...s.actions.map((a) => ({ at: a.at, show: () => add("tool", `${a.summary.split("\n")[0]} (${a.outcome === "started" ? (s.busy ? "in progress" : "result unknown") : a.outcome})`) }))];
  rows.sort((a, b) => a.at.localeCompare(b.at)).forEach((r) => r.show());
  setBusy(s.busy);
  if (s.partial) write(s.partial);
  s.approvals.forEach(approval);
}

$("form").addEventListener("submit", (e) => {
  e.preventDefault();
  if (busy) return vscode.postMessage({ type: "stop" });
  const text = input.value.trim();
  if (!text) return;
  draft = text;
  input.value = "";
  setBusy(true);
  vscode.postMessage({ type: "send", text });
});

input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    if (!busy) $("form").requestSubmit();
  }
});

window.addEventListener("message", ({ data }) => {
  switch (data.event) {
    case "state": showState(data.state); break;
    case "message":
      if (data.message.text === draft) draft = null;
      message(data.message);
      setBusy(true);
      break;
    case "text": write(data.delta); break;
    case "tool": reply = null; add("tool", data.name.replaceAll("_", " ")); break;
    case "approval": approval(data.approval); break;
    case "approved": cards.get(data.id)?.querySelector("p")?.remove(); cards.delete(data.id); break;
    case "done":
      if (data.problem) add("error", data.problem);
      setBusy(false);
      break;
    case "failed":
      add("error", data.problem);
      if (draft !== null) {
        if (!input.value) input.value = draft; // not accepted: give it back
        draft = null;
        setBusy(false);
      }
      break;
  }
});
vscode.postMessage({ type: "ready" });
