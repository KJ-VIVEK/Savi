// Inside a function, so names do not clash with the phone app around it.
(() => {
const host = globalThis.saviHost ?? acquireVsCodeApi();
const $ = (id) => document.getElementById(id);
const log = $("log"), input = $("input"), button = $("button"), jump = $("jump");
const cards = new Map();
const SUGGESTIONS = ["What is on my calendar tomorrow?", "Remind me at 6pm to call home", "Plan a weekend trip near me", "Connect to a project"];
// Neutral, because a step is shown before it is approved.
const STEPS = {
  list_events: "Check calendar", create_event: "Add to calendar", update_event: "Change event", delete_event: "Delete event",
  list_tasks: "Check tasks", create_task: "Add task", update_task: "Change task", delete_task: "Delete task",
  search_history: "Search past chats", read_conversation: "Read a past chat", ask_expert: "Ask a stronger model",
  list_projects: "Check projects", connect_project: "Connect to project", Read: "Read a file", Glob: "Find files", Grep: "Search code", Edit: "Edit a file", Write: "Write a file", Bash: "Run a command",
  list_coding: "Check coding projects", start_coding: "Start coding", stop_coding: "Stop coding",
};
const OUTCOME = { done: "Done", declined: "Declined", failed: "Failed" };
let busy = false, draft = null, reply = null, steps = null, lastDay = "", following = true, frame = 0;

const make = (tag, className, text) => {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text; // never HTML: content can come from calendars
  return n;
};

// Follow new text only while the reader is at the end.
const nearEnd = () => log.scrollHeight - log.scrollTop - log.clientHeight < 60;
function follow(force) {
  if (force) following = true;
  if (following) log.scrollTop = log.scrollHeight;
  jump.hidden = following;
}
log.addEventListener("scroll", () => {
  following = nearEnd();
  jump.hidden = following;
});
jump.onclick = () => follow(true);

function put(el) {
  log.querySelector(".welcome")?.remove();
  thinking.remove();
  log.append(el);
  if (busy) log.append(thinking);
  follow();
  return el;
}

const thinking = make("div", "thinking");
thinking.role = "status";
thinking.append(make("i"), make("i"), make("i"), make("span", "", "Savi is working"));

function setBusy(value) {
  busy = value;
  reply = steps = null;
  button.textContent = busy ? "Stop" : "Send";
  button.classList.toggle("stop", busy);
  if (busy) log.append(thinking);
  else thinking.remove();
  follow();
}

function dayLine(at) {
  const date = new Date(at), key = date.toDateString();
  if (key === lastDay) return;
  lastDay = key;
  const today = new Date(), yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  put(make("div", "day", key === today.toDateString() ? "Today" : key === yesterday.toDateString() ? "Yesterday"
    : date.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric", year: date.getFullYear() === today.getFullYear() ? undefined : "numeric" })));
}

function bubble(role, at, source) {
  dayLine(at);
  const el = make("article", role);
  const time = new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (role === "assistant") el.append(make("i", "avatar", "S"));
  el.append(make("header", "", `${role === "user" ? "You" : "Savi"} · ${time}${role === "user" && source === "phone" ? " · phone" : ""}`), make("div", "body"));
  put(el);
  return el.lastChild;
}

function message(m) {
  steps = null;
  if (m.text) {
    const body = bubble(m.role, m.at, m.source);
    if (m.role === "user") body.textContent = m.text;
    else body.append(renderMarkdown(m.text));
  }
  if (m.problem) problem(m.problem);
  follow();
}
const problem = (text) => put(make("div", "problem", text));

function write(delta) {
  steps = null;
  if (!reply) reply = { body: bubble("assistant", new Date().toISOString()), text: "" };
  reply.text += delta;
  const current = reply;
  // At most one redraw per frame, however fast text arrives.
  frame ||= requestAnimationFrame(() => {
    frame = 0;
    current.body.replaceChildren(renderMarkdown(current.text));
    follow();
  });
}
function flush() {
  if (frame) cancelAnimationFrame(frame);
  frame = 0;
  reply?.body.replaceChildren(renderMarkdown(reply.text));
}

function step(text, state) {
  flush();
  reply = null;
  steps ??= put(make("ul", "steps"));
  steps.append(make("li", state ?? "", text));
  follow();
}

function approval({ id, summary, all }) {
  flush();
  reply = steps = null;
  const [title, ...rest] = summary.split("\n");
  const card = make("section", "approval");
  card.append(make("header", "", "Needs your approval"), make("strong", "", title));
  if (rest.length) card.append(make("pre", "", rest.join("\n")));
  const row = make("div", "choices");
  for (const [label, allow, every] of [["Allow", true], ...(all ? [[all, true, true]] : []), ["Cancel", false]]) {
    const b = make("button", allow && !every ? "" : "secondary", label);
    b.type = "button";
    b.onclick = () => {
      for (const x of row.children) x.disabled = true;
      host.postMessage({ type: "approve", id, allow, all: every === true });
    };
    row.append(b);
  }
  card.append(row);
  put(card);
  cards.set(id, card);
  follow(true);
}
function settled(id) {
  const card = cards.get(id);
  cards.delete(id);
  card?.querySelector(".choices")?.remove();
  if (card) {
    card.classList.add("answered");
    card.querySelector("header").textContent = "Answered";
  }
}

const bar = $("project");
bar.querySelector("button").onclick = () => host.postMessage({ type: "disconnect" });
function setProject(name) {
  bar.hidden = !name;
  bar.querySelector("span").textContent = name ? `Connected to ${name}` : "";
  input.placeholder = name ? `Ask for a change in ${name}` : "Ask Savi anything";
}

function welcome() {
  const box = make("div", "welcome");
  const hour = new Date().getHours();
  box.append(make("h2", "", hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening"), make("p", "", "What can I do for you?"));
  for (const s of SUGGESTIONS) {
    const b = make("button", "suggestion", s);
    b.type = "button";
    b.onclick = () => {
      input.value = s;
      grow();
      input.focus();
    };
    box.append(b);
  }
  log.append(box);
}

/** "Create event" alone says little, so the title is added. */
function brief(summary) {
  const [first, ...rest] = summary.split("\n");
  if (first === "Run a command") return rest.join(" ").slice(0, 80);
  const title = first.startsWith("Create ") && rest.find((l) => l.startsWith("title: "));
  return title ? `${first} "${title.slice(7)}"` : first;
}

function showState(s) {
  flush();
  log.replaceChildren();
  cards.clear();
  lastDay = "";
  busy = false;
  reply = steps = null;
  const waiting = new Set(s.approvals.map((a) => a.summary));
  const rows = [...s.messages.map((m) => ({ at: m.at, show: () => message(m) })),
    ...s.actions.filter((a) => !(a.outcome === "started" && waiting.has(a.summary))).map((a) => ({
      at: a.at, show: () => step(`${brief(a.summary)}: ${a.outcome === "started" ? (s.busy ? "in progress" : "result unknown") : OUTCOME[a.outcome].toLowerCase()}`, a.outcome),
    }))];
  rows.sort((a, b) => a.at.localeCompare(b.at)).forEach((r) => r.show());
  if (!rows.length && !s.busy) welcome();
  setProject(s.project);
  setBusy(s.busy);
  if (s.partial) write(s.partial);
  s.approvals.forEach(approval);
  follow(true);
}

function grow() {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight + 2, 160)}px`;
}
input.addEventListener("input", grow);

$("form").addEventListener("submit", (e) => {
  e.preventDefault();
  if (busy) return host.postMessage({ type: "stop" });
  const text = input.value.trim();
  if (!text) return;
  draft = text;
  input.value = "";
  grow();
  setBusy(true);
  follow(true);
  host.postMessage({ type: "send", text });
});

// On a touch keyboard, Enter adds a line and the button sends.
const touch = matchMedia("(pointer: coarse)").matches;
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !touch) {
    e.preventDefault();
    if (!busy) $("form").requestSubmit();
  }
});

window.addEventListener("message", ({ data, source }) => {
  if (globalThis.saviHost && source) return; // another window, not Savi
  switch (data.event) {
    case "state": showState(data.state); break;
    case "message":
      if (data.message.text === draft) draft = null;
      message(data.message);
      setBusy(true);
      break;
    case "text": write(data.delta); break;
    case "project": setProject(data.project); break;
    case "tool": step(STEPS[data.name] ?? data.name.replaceAll("_", " ")); break;
    case "approval": approval(data.approval); break;
    case "approved": settled(data.id); break;
    case "done":
      flush();
      if (data.problem) problem(data.problem);
      setBusy(false);
      break;
    case "failed":
      problem(data.problem);
      if (draft !== null) {
        if (!input.value) input.value = draft; // not accepted: give it back
        grow();
        draft = null;
        setBusy(false);
      }
      break;
  }
});
host.postMessage({ type: "ready" });
})();
