const el = (id) => document.getElementById(id);

async function post(path, value) {
  const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
  if (res.status === 401) showPairing();
  const out = await res.json().catch(() => ({ error: "Savi did not accept the request." }));
  if (out.error) throw new Error(out.error);
  return out.result;
}
const call = (method, params = {}) => post("/call", { method, params });
const deliver = (data) => window.dispatchEvent(new MessageEvent("message", { data }));

// chat.js is shared with VS Code and talks through this.
globalThis.saviHost = {
  async postMessage({ type, ...params }) {
    if (type === "ready") return start();
    try {
      await call(type, params);
    } catch (e) {
      deliver({ event: "failed", problem: e.message });
    }
  },
};

let events;
async function start() {
  events?.close();
  const res = await fetch("/paired").catch(() => undefined);
  if (res?.status === 401) return showPairing();
  el("pair").hidden = true;
  el("app").hidden = false;
  el("offline").hidden = Boolean(res?.ok);
  events = new EventSource("/events"); // reconnects by itself, and starts with the full state
  events.onopen = () => (el("offline").hidden = true);
  events.onerror = () => {
    el("offline").hidden = false;
    // Refused rather than dropped: check whether this phone was removed.
    if (events.readyState === EventSource.CLOSED) setTimeout(start, 5000);
  };
  events.onmessage = (m) => {
    const data = JSON.parse(m.data);
    deliver(data);
  };
}

function showPairing() {
  events?.close();
  el("app").hidden = true;
  el("pair").hidden = false;
}

el("pairForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  el("pairError").textContent = "";
  try {
    await post("/pair", { code: el("code").value });
    el("code").value = "";
    await start();
  } catch (err) {
    el("pairError").textContent = err.message;
  }
});

function tab(name) {
  for (const s of document.querySelectorAll(".tab")) s.hidden = s.id !== name;
  for (const b of document.querySelectorAll("[data-tab]")) {
    if (b.dataset.tab === name) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  }
  if (name === "history") void loadHistory();
}
for (const b of document.querySelectorAll("[data-tab]")) b.onclick = () => tab(b.dataset.tab);
el("newChat").onclick = async () => {
  try {
    await call("newConversation");
    tab("chat");
  } catch (e) {
    deliver({ event: "failed", problem: e.message });
  }
};

function node(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text; // never HTML
  return n;
}
function row(tag, title, detail) {
  const r = node(tag, "row");
  const text = node("span", "", title);
  if (detail) text.append(node("small", "", detail));
  r.append(text);
  return r;
}

let search = 0, timer;
async function loadHistory() {
  const mine = ++search;
  const text = el("search").value.trim();
  let rows;
  try {
    const when = (s) => new Date(s).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
    const found = text ? await call("search", { text }) : await call("conversations");
    rows = found.map((f) => {
      const id = text ? f.conversationId : f.id;
      const title = text ? (f.kind === "action" ? f.summary : f.text || f.problem) : f.title;
      const r = row(id ? "button" : "div", title.slice(0, 200), when(f.at ?? f.startedAt));
      if (id) {
        r.type = "button";
        r.onclick = async () => {
          try {
            await call("openConversation", { id });
            tab("chat");
          } catch (e) {
            r.append(node("small", "error", e.message));
          }
        };
      }
      return r;
    });
    if (!rows.length) rows = [node("p", "", text ? "Nothing found." : "No conversations yet.")];
  } catch (e) {
    rows = [node("p", "error", e.message)];
  }
  if (mine === search) el("results").replaceChildren(...rows);
}
el("search").addEventListener("input", () => {
  clearTimeout(timer);
  timer = setTimeout(loadHistory, 250);
});
