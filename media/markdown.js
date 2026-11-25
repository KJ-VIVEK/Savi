// A small, safe Markdown renderer. It only builds elements and text nodes, never HTML from
// strings, so content from calendars or the web cannot inject anything.
globalThis.renderMarkdown = (() => {
  const make = (tag, className) => {
    const n = document.createElement(tag);
    if (className) n.className = className;
    return n;
  };

  const INLINE = /(`[^`\n]+`)|(\*\*[^\n]+?\*\*)|((?<![\w*])\*[^*\s][^*\n]*\*(?![\w*]))|\[([^\]\n]+)\]\((https:\/\/[^\s)]+)\)|(https:\/\/[^\s<>()"']+)/g;

  function link(href, text) {
    const a = make("a");
    a.href = href;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.title = href; // shows where it really goes
    a.textContent = text;
    return a;
  }

  function inline(parent, text) {
    let last = 0;
    for (const m of text.matchAll(INLINE)) {
      parent.append(text.slice(last, m.index));
      last = m.index + m[0].length;
      if (m[1]) parent.append(Object.assign(make("code"), { textContent: m[1].slice(1, -1) }));
      else if (m[2]) inline(parent.appendChild(make("strong")), m[2].slice(2, -2));
      else if (m[3]) inline(parent.appendChild(make("em")), m[3].slice(1, -1));
      else if (m[5]) parent.append(link(m[5], m[4]));
      else {
        const url = m[6].replace(/[.,;:!?]+$/, "");
        parent.append(link(url, url), m[6].slice(url.length));
      }
    }
    parent.append(text.slice(last));
  }

  function codeBlock(text) {
    const box = make("div", "code"), copy = make("button", "copy"), pre = make("pre");
    copy.type = "button";
    copy.textContent = "Copy";
    copy.onclick = async () => {
      try {
        await navigator.clipboard.writeText(text);
        copy.textContent = "Copied";
      } catch {
        copy.textContent = "Could not copy";
      }
      setTimeout(() => (copy.textContent = "Copy"), 1500);
    };
    pre.tabIndex = 0;
    pre.append(Object.assign(make("code"), { textContent: text }));
    box.append(copy, pre);
    return box;
  }

  const cells = (line) => line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
  const ITEM = /^(\s*)(?:[-*•]|(\d+)[.)])\s+(.*)$/;
  const SPECIAL = /^(```|#{1,6}\s|>\s?|\s*(?:[-*•]|\d+[.)])\s+|\s*(?:-{3,}|\*{3,})\s*$)/;

  function table(lines) {
    const wrap = make("div", "table"), t = wrap.appendChild(make("table"));
    lines.forEach((l, i) => {
      if (i === 1) return; // the dashes
      const tr = t.appendChild(make("tr"));
      for (const c of cells(l)) inline(tr.appendChild(make(i === 0 ? "th" : "td")), c);
    });
    wrap.tabIndex = 0;
    return wrap;
  }

  return (text) => {
    const out = document.createDocumentFragment();
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; ) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }
      if (line.startsWith("```")) {
        const body = [];
        for (i++; i < lines.length && !lines[i].startsWith("```"); i++) body.push(lines[i]);
        i++;
        out.append(codeBlock(body.join("\n")));
      } else if (/^#{1,6}\s/.test(line)) {
        inline(out.appendChild(make("h3")), line.replace(/^#+\s+/, "").replace(/\s+#+$/, ""));
        i++;
      } else if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
        out.append(make("hr"));
        i++;
      } else if (line.startsWith(">")) {
        const q = out.appendChild(make("blockquote"));
        const body = [];
        for (; i < lines.length && lines[i].startsWith(">"); i++) body.push(lines[i].replace(/^>\s?/, ""));
        inline(q, body.join("\n"));
      } else if (line.includes("|") && /^\s*\|?\s*:?-{2,}[-|:\s]*$/.test(lines[i + 1] ?? "")) {
        const body = [];
        for (; i < lines.length && lines[i].includes("|"); i++) body.push(lines[i]);
        out.append(table(body));
      } else if (ITEM.test(line)) {
        const first = ITEM.exec(line);
        const list = make(first[2] ? "ol" : "ul");
        if (first[2]) list.start = Number(first[2]);
        for (; i < lines.length; i++) {
          const m = ITEM.exec(lines[i]);
          if (m) {
            const nested = m[1].length > first[1].length;
            if (!nested && Boolean(m[2]) !== Boolean(first[2])) break;
            const li = list.appendChild(make("li", nested ? "nested" : ""));
            inline(li, m[3]);
          } else if (/^\s+\S/.test(lines[i])) {
            list.lastChild.append("\n");
            inline(list.lastChild, lines[i].trim());
          } else if (lines[i].trim() || !ITEM.test(lines[i + 1] ?? "")) break;
        }
        out.append(list);
      } else {
        const body = [line];
        for (i++; i < lines.length && lines[i].trim() && !SPECIAL.test(lines[i]); i++) body.push(lines[i]);
        inline(out.appendChild(make("p")), body.join("\n"));
      }
    }
    return out;
  };
})();
