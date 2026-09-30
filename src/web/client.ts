// The browser-side script for the web page. Plain JS in a raw template string
// (no build step, no dependencies). Rules: no template literals in here, and
// a literal backtick is written as \` — String.raw hands it through as-is.
//
// Layout: a workspace sidebar on the left, the active session's transcript in
// the middle, and an optional right panel with browser and terminal tabs.
// Every session keeps its own view (transcript DOM, status, draft input,
// panel tabs) so switching is instant and background sessions keep streaming.

export const CLIENT_JS = String.raw`
"use strict";
const k = new URLSearchParams(location.search).get("k") || "";
const $ = (id) => document.getElementById(id);
const ls = {
  get(key) { try { return localStorage.getItem(key); } catch (e) { return null; } },
  set(key, v) { try { localStorage.setItem(key, v); } catch (e) {} },
};
const logwrap = $("logwrap"), logsEl = $("logs"), busyEl = $("busy"), actionBtn = $("actionbtn");
const jumpBottom = $("jumpbottom");
const input = $("input"), menu = $("menu"), sideEl = $("side"), panelEl = $("panel"), tabsEl = $("paneltabs");

let hub = { workspaces: [], home: "", version: "" };
const sessInfo = new Map();   // sid -> sidebar entry from the last hub snapshot
const views = new Map();      // sid -> per-session view state
let active = null;
let pendingSelect = null;
let busyTimer = null;
let uidCounter = 0;
const uid = () => "u" + (++uidCounter) + "_" + Date.now().toString(36);

function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
function post(path, body) {
  return fetch(path + "?k=" + k, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) })
    .then((r) => r.json()).catch(() => ({}));
}
function rel(ts) {
  const d = Date.now() - (ts || 0);
  if (!ts || d < 60e3) return "now";
  if (d < 3600e3) return Math.floor(d / 60e3) + "m";
  if (d < 86400e3) return Math.floor(d / 3600e3) + "h";
  if (d < 7 * 86400e3) return Math.floor(d / 86400e3) + "d";
  return new Date(ts).toLocaleDateString();
}
function shortPath(p) {
  if (!p) return "";
  const home = hub.home || "";
  if (home && p.slice(0, home.length).toLowerCase() === home.toLowerCase()) p = "~" + p.slice(home.length);
  return p.replace(/\\/g, "/");
}

// ---- markdown ------------------------------------------------------------
// Model output is untrusted: escape everything first, then build tags
// ourselves. Nothing from the model is ever inserted as raw HTML.
function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
const SENT = String.fromCharCode(1); // never appears in escaped text
function inlineMd(s) {
  const codes = [];
  s = s.replace(/\`([^\`]+)\`/g, (m, c) => { codes.push(c); return SENT + (codes.length - 1) + SENT; });
  s = s.replace(/\*\*\*([^*]+)\*\*\*/g, "<strong><em>$1</em></strong>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)"]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  s = s.replace(new RegExp(SENT + "(\\d+)" + SENT, "g"), (m, i) => "<code>" + codes[i] + "</code>");
  return s;
}
function renderMarkdown(src) {
  const lines = esc(src).split("\n");
  let out = "", i = 0, listType = null;
  const closeList = () => { if (listType) { out += "</" + listType + ">"; listType = null; } };
  const cells = (row) => row.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^\s*\`\`\`(\w*)\s*$/.exec(line);
    if (fence) {
      closeList();
      const body = []; i++;
      while (i < lines.length && !/^\s*\`\`\`/.test(lines[i])) { body.push(lines[i]); i++; }
      i++;
      out += "<pre><code>" + body.join("\n") + "</code></pre>";
      continue;
    }
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])) {
      closeList();
      const head = cells(line); i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) { rows.push(cells(lines[i])); i++; }
      out += "<table><thead><tr>" + head.map((h) => "<th>" + inlineMd(h) + "</th>").join("") + "</tr></thead><tbody>";
      for (const r of rows) out += "<tr>" + r.map((c) => "<td>" + inlineMd(c) + "</td>").join("") + "</tr>";
      out += "</tbody></table>";
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) { closeList(); out += "<h" + h[1].length + ">" + inlineMd(h[2]) + "</h" + h[1].length + ">"; i++; continue; }
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) { closeList(); out += "<hr>"; i++; continue; }
    // NB: lines are already escaped, so the blockquote marker is "&gt;".
    if (/^\s*&gt;\s?/.test(line)) {
      closeList();
      const body = [];
      while (i < lines.length && /^\s*&gt;\s?/.test(lines[i])) { body.push(lines[i].replace(/^\s*&gt;\s?/, "")); i++; }
      out += "<blockquote>" + inlineMd(body.join(" ")) + "</blockquote>";
      continue;
    }
    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ul || ol) {
      const want = ul ? "ul" : "ol";
      if (listType !== want) { closeList(); out += "<" + want + ">"; listType = want; }
      out += "<li>" + inlineMd((ul || ol)[1]) + "</li>";
      i++; continue;
    }
    if (!line.trim()) { closeList(); i++; continue; }
    closeList();
    const para = [line]; i++;
    while (i < lines.length && lines[i].trim() &&
           !/^(\s*#{1,6}\s|\s*\`\`\`|\s*>\s?|\s*[-*+]\s|\s*\d+[.)]\s|\s*\|)/.test(lines[i])) { para.push(lines[i]); i++; }
    out += "<p>" + inlineMd(para.join(" ")) + "</p>";
  }
  closeList();
  return out;
}

// ---- ANSI (terminal output) -----------------------------------------------
function ansiToFrag(text) {
  const frag = document.createDocumentFragment();
  const re = /\x1b\[([\d;]*)m/g;
  let last = 0, m, cls = [];
  const push = (s) => {
    if (!s) return;
    if (cls.length) frag.appendChild(el("span", cls.join(" "), s)); else frag.appendChild(document.createTextNode(s));
  };
  while ((m = re.exec(text))) {
    push(text.slice(last, m.index));
    last = re.lastIndex;
    const codes = (m[1] || "0").split(";").map(Number);
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) cls = [];
      else if (c === 1) cls.push("ab");
      else if (c === 2) cls.push("ad");
      else if (c === 22) cls = cls.filter((x) => x !== "ab" && x !== "ad");
      else if ((c >= 30 && c <= 37) || (c >= 90 && c <= 97)) { cls = cls.filter((x) => !/^a[39]\d$/.test(x)); cls.push("a" + c); }
      else if (c === 39) cls = cls.filter((x) => !/^a[39]\d$/.test(x));
      else if (c === 38 || c === 48) break; // 256/truecolor: not rendered
    }
  }
  push(text.slice(last));
  return frag;
}

// ---- per-session views ----------------------------------------------------
function getView(sid) {
  let v = views.get(sid);
  if (!v) {
    v = {
      sid, logEl: el("div", "log"), state: { commands: [] }, curText: null, curThought: null, thoughtBuf: "", thoughtStart: 0,
      busyLabel: null, busyStart: 0, unread: false, draft: "", scrollTop: null, followBottom: true, asks: new Map(), curTool: null, planEl: null,
      terms: new Map(), tabs: [], activeTab: null, panelOpen: false, panelEl: el("div", "panelview"), panelFull: false,
    };
    v.logEl.hidden = true; logsEl.appendChild(v.logEl);
    v.panelEl.hidden = true; $("panelviews").appendChild(v.panelEl);
    loadPanelState(v);
    views.set(sid, v);
  }
  return v;
}
function dropView(sid) {
  const v = views.get(sid);
  if (!v) return;
  v.logEl.remove(); v.panelEl.remove();
  views.delete(sid);
  if (active === v) show(null);
}
// Only follow while at the bottom. Keep this per session, so returning to a
// transcript doesn't lose the place the user was reading.
function atBottom() { return logwrap.scrollHeight - logwrap.scrollTop - logwrap.clientHeight <= 2; }
function renderJumpBottom() { jumpBottom.hidden = !active || atBottom(); }
function stick() {
  if (active) {
    // A token can arrive before the browser delivers a pending scroll event.
    if (active.scrollTop !== null && logwrap.scrollTop < active.scrollTop && !atBottom()) active.followBottom = false;
    if (active.followBottom) logwrap.scrollTop = logwrap.scrollHeight;
    active.scrollTop = logwrap.scrollTop;
  }
  renderJumpBottom();
}
function scrollToBottom() {
  if (!active) return;
  active.followBottom = true;
  logwrap.scrollTop = logwrap.scrollHeight;
  active.scrollTop = logwrap.scrollTop;
  renderJumpBottom();
}
logwrap.addEventListener("scroll", () => {
  if (active) { active.followBottom = atBottom(); active.scrollTop = logwrap.scrollTop; }
  renderJumpBottom();
}, { passive: true });
logwrap.addEventListener("wheel", (e) => {
  if (active && e.deltaY < 0 && logwrap.scrollTop > 0) active.followBottom = false;
}, { passive: true });
jumpBottom.onclick = scrollToBottom;
// Images, disclosure panels, and viewport/composer resizing can change the
// transcript height without a new message event.
const logResize = new ResizeObserver(stick);
logResize.observe(logwrap); logResize.observe(logsEl); logResize.observe($("busywrap"));
function add(v, e) { v.logEl.appendChild(e); if (v === active) stick(); return e; }
function fmtSize(n) { return n < 1024 ? n + " B" : n < 1048576 ? (n / 1024).toFixed(n < 10240 ? 1 : 0) + " KB" : (n / 1048576).toFixed(1) + " MB"; }
// A sent message: its text, then thumbnails for images and links for files.
function userBubble(m) {
  const d = el("div", "user", m.s || "");
  if (m.files && m.files.length) {
    const row = el("div", "files");
    for (const f of m.files) {
      const href = f.url + "&k=" + k;
      if (f.kind === "image") {
        const a = el("a"); a.href = href; a.target = "_blank"; a.rel = "noopener";
        const img = el("img", "thumb"); img.src = href; img.alt = f.name; img.title = f.name; img.loading = "lazy";
        a.appendChild(img); row.appendChild(a);
      } else {
        const a = el("a", "filechip", f.name + " · " + fmtSize(f.size)); a.href = href; a.target = "_blank"; a.rel = "noopener";
        row.appendChild(a);
      }
    }
    d.appendChild(row);
  }
  return d;
}
// Streaming: accumulate raw markdown on the element, re-render on a short
// timer. NOT requestAnimationFrame: rAF never fires in background tabs, so a
// response streamed while the tab is hidden would never render.
function scheduleMd(v, target) {
  if (target._pending) return;
  target._pending = true;
  setTimeout(() => { target._pending = false; target.innerHTML = renderMarkdown(target._raw || ""); if (v === active) stick(); }, 60);
}
function endThought(v) {
  if (v.curThought) {
    v.curThought._preview.textContent = "✦ thought for " + ((Date.now() - v.thoughtStart) / 1000).toFixed(1) + "s";
    v.curThought = null; v.thoughtBuf = "";
  }
}
function startThought(v) {
  const thought = el("details", "thought"), summary = el("summary");
  thought._preview = el("span", "thought-preview");
  summary.appendChild(thought._preview);
  summary.appendChild(el("span", "thought-expand", "Expand"));
  summary.appendChild(el("span", "thought-collapse", "Collapse"));
  const body = el("div", "thought-body");
  thought._body = document.createTextNode(""); body.appendChild(thought._body);
  thought.appendChild(summary); thought.appendChild(body);
  summary.addEventListener("click", () => {
    // Opening a long thought should keep its beginning in view, including
    // when it is still streaming. Native summary activation handles keys too.
    if (v === active && !thought.open) v.followBottom = false;
  });
  thought.addEventListener("toggle", () => {
    // Collapsing can put us back at the bottom without changing scrollTop,
    // so there may be no scroll event to resume following.
    if (v === active) { v.followBottom = atBottom(); stick(); }
  });
  v.thoughtStart = Date.now(); v.thoughtBuf = ""; v.curText = null;
  return add(v, thought);
}

function setBusy(v, label) {
  v.busyLabel = label || null;
  if (label) v.busyStart = Date.now();
  if (v === active) renderBusy();
}
function renderBusy() {
  const label = active ? active.busyLabel : null;
  actionBtn.textContent = label ? "■ stop" : "send";
  actionBtn.className = label ? "stop" : "";
  actionBtn.title = label ? "interrupt the agent (esc)" : "send (enter)";
  const tick = () => {
    const s = active && active.busyLabel ? Math.floor((Date.now() - active.busyStart) / 1000) : 0;
    $("busysecs").textContent = s > 2 ? s + "s" : "";
  };
  if (label) {
    busyEl.classList.add("on");
    $("busylabel").textContent = label + "…";
    if (!busyTimer) busyTimer = setInterval(tick, 500);
    tick();
  } else {
    busyEl.classList.remove("on");
    if (busyTimer) { clearInterval(busyTimer); busyTimer = null; }
    $("busysecs").textContent = "";
  }
  stick();
}

function renderState(v) {
  for (const t of v.tabs) if (t.kind === "browser") fillUrls(t, v.state.urls || []);
  // A /mode switch changes whether a file tab may be written, and it can land
  // on any session in the sidebar, so refresh the tabs of every view.
  for (const o of views.values()) for (const t of o.tabs) if (t.kind === "file") applyFileMode(o, t);
  if (v !== active) return;
  const s = v.state;
  const st = $("status");
  st.innerHTML = "";
  if (!s.mode) { st.textContent = "starting…"; renderCrumb(); return; }
  const command = (name) => post("/msg", { sid: v.sid, text: "/" + name });
  const mode = el("button", "statusbtn mode " + s.mode, s.mode === "ro" ? "Read-only" : s.mode === "bypass" ? "Bypass" : "Edit");
  mode.title = "Permission mode"; mode.onclick = () => command("mode");
  st.appendChild(mode);
  const model = el("button", "statusbtn modelpick", s.model + (s.host ? " @ " + s.host : "") + " ▾"); model.title = s.backend + (s.host ? " on " + s.host : "") + " · Switch model or find models on another machine"; model.onclick = () => command("models"); st.appendChild(model);
  const effort = el("button", "statusbtn eff", s.effort || "Auto"); effort.title = "Reasoning effort"; effort.onclick = () => command("effort"); st.appendChild(effort);
  st.appendChild(el("span", "grow"));
  const ctx = el("button", "statusbtn context-chip" + (s.ctxPct >= 75 ? " pressure" : ""));
  const meter = document.createElement("meter"); meter.min = 0; meter.max = 100; meter.value = s.ctxPct || 0; meter.setAttribute("aria-label", "Context used");
  ctx.appendChild(meter); ctx.appendChild(document.createTextNode((s.ctxPct || 0) + "%"));
  const b = s.context; ctx.title = b ? b.prompt.toLocaleString() + " / " + b.window.toLocaleString() + " tokens · " + b.reserve.toLocaleString() + " reserved for reply · " + b.source : "Context usage";
  ctx.onclick = () => command("context"); st.appendChild(ctx);
  if (s.plan) {
    const done = s.plan.steps.filter((x) => x.done).length;
    st.appendChild(el("span", "plan-chip" + (s.plan.current < 0 ? " done" : ""), "plan " + done + "/" + s.plan.steps.length));
  }
  if (s.tasks) st.appendChild(el("span", "task-chip", s.tasks + " running"));
  if (s.outcome === "error" || s.outcome === "cancelled") {
    const paused = el("span", s.outcome === "error" ? "line-warn" : "task-chip", s.outcome === "error" ? "Paused" : "Stopped");
    paused.title = s.lastError || "Turn cancelled; progress is kept"; st.appendChild(paused);
  }
  $("ws").textContent = shortPath(s.workspace || "");
  renderCrumb();
}

function renderPlan(v, p) {
  const box = el("div", "plan");
  const done = p.steps.filter((x) => x.done).length;
  const hdr = el("div", "hdr", "Plan ");
  hdr.appendChild(el("small", "", done + "/" + p.steps.length));
  box.appendChild(hdr);
  p.steps.forEach((s, i) => {
    const cls = s.done ? "done" : i === p.current ? "cur" : "todo";
    const mark = s.done ? "✔ " : i === p.current ? "▶ " : "○ ";
    box.appendChild(el("div", cls, mark + s.text));
  });
  if (v.planEl && v.planEl.isConnected) v.planEl.replaceWith(box); else add(v, box);
  v.planEl = box;
}

// ---- event handling -------------------------------------------------------
function handle(m) {
  if (m.t === "hub") { onHub(m); return; }
  if (m.t === "closed") { dropView(m.sid); return; }
  if (!m.sid) return;
  const v = getView(m.sid);
  switch (m.t) {
    case "state":
      v.state = Object.assign(v.state, m.s);
      if (m.s && "busy" in m.s) setBusy(v, m.s.busy);
      renderState(v); break;
    case "user": endThought(v); v.curText = null; v.curTool = null; v.planEl = null; add(v, userBubble(m)); break;
    case "response_reset":
      if (v.curText) v.curText.remove();
      if (v.curThought) v.curThought.remove();
      v.curText = null; v.curThought = null; v.thoughtBuf = ""; break;
    case "token":
      endThought(v);
      if (!v.curText) { v.curText = add(v, el("div", "md")); v.curText._raw = ""; }
      v.curText._raw += m.s; scheduleMd(v, v.curText); break;
    case "thinking":
      if (!v.curThought) v.curThought = startThought(v);
      v.curThought._body.appendData(m.s);
      // Only the one-line preview is truncated; the full text stays available.
      v.thoughtBuf = (v.thoughtBuf + m.s).slice(-2000);
      var tt = v.thoughtBuf.replace(/\s+/g, " ").trim();
      v.curThought._preview.textContent = "✦ " + (tt.length > 160 ? "…" + tt.slice(-160) : tt);
      if (v === active) stick(); break;
    case "tool": {
      endThought(v); v.curText = null;
      const d = el("details", "tool");
      const summary = el("summary"); summary.appendChild(el("span", "name", m.name.replace(/_/g, " "))); summary.appendChild(el("span", "tool-args", m.summary || ""));
      d.appendChild(summary); v.curTool = d; add(v, d); break;
    }
    case "result": {
      endThought(v); v.curText = null;
      const body = el("pre", "result" + (m.err ? " err" : ""), m.body || m.line);
      if (v.curTool) { v.curTool.classList.add(m.err ? "failed" : "finished"); v.curTool.appendChild(body); if (m.err) v.curTool.open = true; v.curTool = null; }
      else add(v, body);
      break;
    }
    case "plan": endThought(v); v.curText = null; renderPlan(v, m); break;
    case "line": endThought(v); v.curText = null; add(v, el("div", "line-" + m.kind, m.s)); break;
    case "turnend":
      endThought(v); v.curText = null; add(v, el("div", "turnend", "■ " + m.label));
      if (v !== active) { v.unread = true; renderSidebar(); }
      break;
    case "busy": setBusy(v, m.label); break;
    case "confirm": {
      endThought(v); v.curText = null;
      const box = el("div", "ask");
      box.appendChild(el("div", "", "run?")); box.appendChild(el("div", "cmd", m.command));
      if (m.reason) box.appendChild(el("div", "hint", m.reason));
      ["yes", "no", "always"].forEach((a) => {
        const b = el("button", "", a === "always" ? "always allow this program" : a);
        b.onclick = () => { post("/confirm", { sid: v.sid, id: m.id, answer: a }); box.remove(); };
        box.appendChild(b);
      });
      v.asks.set(m.id, box);
      // An approval needs the user's eyes. If the panel is eating the whole
      // screen, drop it back so the chat (home of this box) shows.
      if (v === active && v.panelFull) { v.panelFull = false; renderPanel(); }
      add(v, box); break;
    }
    case "answered": {
      // The server settled this prompt (answered here, elsewhere, or cancelled).
      const box = v.asks.get(m.id);
      if (box) { box.remove(); v.asks.delete(m.id); }
      break;
    }
    case "select": {
      endThought(v); v.curText = null;
      const box = el("div", "ask");
      box.appendChild(el("div", "cmd", m.title));
      m.options.forEach((o, i) => {
        const b = el("button", "opt" + (o.current ? " current" : ""), (o.current ? "● " : "") + o.label);
        if (o.hint) b.appendChild(el("span", "hint", o.hint));
        b.onclick = () => { post("/select", { sid: v.sid, id: m.id, index: i }); box.remove(); };
        box.appendChild(el("div")).appendChild(b);
      });
      const cancel = el("button", "", "cancel");
      cancel.onclick = () => { post("/select", { sid: v.sid, id: m.id, index: null }); box.remove(); };
      box.appendChild(cancel);
      v.asks.set(m.id, box);
      add(v, box); break;
    }
    case "prompt": {
      endThought(v); v.curText = null;
      const box = el("div", "ask");
      box.appendChild(el("div", "cmd", m.title));
      const field = el("input", "askinput"); field.type = "text"; field.placeholder = m.placeholder || ""; field.spellcheck = false; field.autocomplete = "off";
      const send = (value) => { post("/prompt", { sid: v.sid, id: m.id, value: value }); box.remove(); };
      field.onkeydown = (e) => {
        if (e.key === "Enter") { e.preventDefault(); send(field.value.trim() || null); }
        // Escape closes this box only; the page-level handler would cancel the whole turn.
        else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); send(null); }
      };
      box.appendChild(el("div")).appendChild(field);
      const ok = el("button", "", "ok"); ok.onclick = () => send(field.value.trim() || null); box.appendChild(ok);
      const cancel = el("button", "", "cancel"); cancel.onclick = () => send(null); box.appendChild(cancel);
      v.asks.set(m.id, box);
      add(v, box);
      if (v === active) field.focus();
      break;
    }
    case "termopen": ensureTermTab(v, m.tid, m.cwd); break;
    case "term": termWrite(v, m.tid, m.s); break;
    case "termdone": termDone(v, m.tid, m.code, m.cwd); break;
    case "termclosed": removeTermTab(v, m.tid); break;
  }
}

// ---- hub snapshot + sidebar ------------------------------------------------
function onHub(m) {
  hub = m;
  sessInfo.clear();
  for (const w of m.workspaces) for (const s of w.sessions) sessInfo.set(s.id, Object.assign({ workspace: w.path, wsname: w.name }, s));
  for (const v of views.values()) reconcileTerms(v);
  $("ver").textContent = "v" + m.version;
  if (pendingSelect && sessInfo.has(pendingSelect)) { const id = pendingSelect; pendingSelect = null; show(id); }
  else if (!active) {
    const h = location.hash.slice(1);
    if (h && sessInfo.has(h)) select(h);
    else {
      const live = [...sessInfo.values()].filter((s) => s.live).sort((a, b) => b.updatedAt - a.updatedAt)[0];
      show(live ? live.id : null);
    }
  } else if (!sessInfo.has(active.sid) && !pendingSelect) show(null);
  renderSidebar(); renderCrumb(); renderTitle(); renderWelcome();
}
function select(id) {
  const s = sessInfo.get(id);
  if (s && (!s.live || s.status === "error")) post("/sessions/resume", { id });
  show(id);
}
function show(sid) {
  if (active) {
    active.draft = input.value; active.scrollTop = logwrap.scrollTop;
    active.logEl.hidden = true;
  }
  active = sid ? getView(sid) : null;
  $("welcome").hidden = !!active;
  $("bottom").hidden = !active;
  busyEl.hidden = !active;
  if (active) {
    active.logEl.hidden = false; active.unread = false;
    input.value = active.draft || ""; autoGrow(); menuIdx = 0; renderMenu();
    renderState(active);
    logwrap.scrollTop = active.followBottom ? logwrap.scrollHeight : active.scrollTop || 0;
    active.scrollTop = logwrap.scrollTop;
    renderBusy();
    if (location.hash !== "#" + sid) history.replaceState(null, "", "#" + sid);
    // On a narrow window the sidebar floats over the chat: tuck it away once
    // a session is picked.
    if (narrow()) setSide(true);
    input.focus({ preventScroll: true });
  } else {
    if (location.hash) history.replaceState(null, "", location.pathname + location.search);
    $("status").textContent = "";
  }
  renderPanel(); renderSidebar(); renderCrumb(); renderTitle(); renderWelcome(); renderAttachments();
  // A different session can point at a different workspace, so the tree has
  // to follow. loadTree() is a no-op when the workspace is already cached.
  if (sideTab === "tree") loadTree();
  stick();
}
function newSession(path) {
  post("/sessions/new", { workspace: path }).then((r) => { if (r.id) { pendingSelect = r.id; show(r.id); } else if (r.error) alert(r.error); });
}
function renderSidebar() {
  const list = $("wslist");
  list.innerHTML = "";
  if (!hub.workspaces.length) return;
  for (const w of hub.workspaces) {
    const box = el("div", "ws");
    const hdr = el("div", "wshdr"); hdr.title = w.path;
    hdr.appendChild(el("span", "wsname", w.name)); hdr.appendChild(el("span", "grow"));
    const plus = el("button", "iconbtn", "+"); plus.title = "new session in " + w.name;
    plus.onclick = (e) => { e.stopPropagation(); newSession(w.path); };
    const rm = el("button", "iconbtn", "×"); rm.title = "remove " + w.name + " from the list";
    rm.onclick = (e) => { e.stopPropagation(); removeWorkspace(w); };
    hdr.appendChild(plus); hdr.appendChild(rm);
    if (!w.sessions.length) { hdr.style.cursor = "pointer"; hdr.onclick = () => newSession(w.path); }
    box.appendChild(hdr);
    const sl = el("div", "sessions");
    for (const s of w.sessions) {
      const v = views.get(s.id);
      const row = el("div", "sess " + (s.live ? s.status : "stored") + (active && active.sid === s.id ? " active" : "") + (v && v.unread ? " unread" : ""));
      row.appendChild(el("span", "dot"));
      row.appendChild(el("span", "stitle" + (s.title ? "" : " untitled"), s.title || "new session"));
      row.appendChild(el("span", "stime", rel(s.updatedAt)));
      const x = el("button", "iconbtn", "×");
      x.title = s.live ? "close session (kept in the list)" : "delete session";
      x.onclick = (e) => {
        e.stopPropagation();
        if (s.live) post("/sessions/close", { id: s.id });
        else if (confirm("Delete this session permanently?")) post("/sessions/delete", { id: s.id });
      };
      row.appendChild(x);
      row.title = (s.title || "new session") + (s.model ? " · " + s.model : "") + (s.live ? " · " + s.status : " · saved — click to resume");
      row.onclick = () => select(s.id);
      row.ondblclick = () => { const t = prompt("Rename session", s.title || ""); if (t !== null && t.trim()) post("/sessions/rename", { id: s.id, title: t }); };
      sl.appendChild(row);
    }
    box.appendChild(sl);
    list.appendChild(box);
  }
}
function removeWorkspace(w) {
  if (w.sessions.some((s) => s.live)) { alert("Close the open sessions in " + w.name + " first."); return; }
  const n = w.sessions.length;
  if (!confirm("Remove " + w.name + " from the list?" + (n ? " Its " + n + " saved session" + (n > 1 ? "s" : "") + " will be deleted." : ""))) return;
  post("/workspaces/remove", { path: w.path }).then((r) => { if (r.error) alert(r.error); });
}
function renderCrumb() {
  const c = $("crumb");
  c.innerHTML = "";
  if (!active) { c.appendChild(el("span", "ws", "smolcoder")); c.title = ""; return; }
  const info = sessInfo.get(active.sid);
  c.appendChild(el("span", "ws", info ? info.wsname : ""));
  c.appendChild(el("span", "sep", "›"));
  c.appendChild(el("span", "title", active.state.title || (info && info.title) || "new session"));
  c.title = info ? info.workspace : "";
}
function renderTitle() {
  let busy = false, waiting = false;
  for (const s of sessInfo.values()) { if (s.status === "busy" || s.status === "starting") busy = true; if (s.status === "waiting") waiting = true; }
  const info = active && sessInfo.get(active.sid);
  document.title = (waiting ? "⚠ " : busy ? "● " : "") + (info ? (info.title || info.wsname) + " · " : "") + "smol";
}
function renderWelcome() {
  const w = $("welcome");
  w.hidden = !!active;
  if (active) return;
  const r = $("recent");
  r.innerHTML = "";
  const ws = hub.workspaces.slice(0, 8);
  if (!ws.length) return;
  r.appendChild(el("div", "recent-label", "Recent"));
  for (const x of ws) {
    const b = el("button", "wsbtn");
    b.appendChild(el("span", "", x.name)); b.appendChild(el("span", "dim", "  " + x.display));
    b.onclick = () => newSession(x.path);
    r.appendChild(b);
  }
}
setInterval(() => { renderSidebar(); }, 30000);

// ---- file tree (left sidebar) -------------------------------------------
// Deferred render: don't fetch until the Files tab is first shown, and never
// block the first message. The whole tree arrives in one payload (the server
// walks it), so expanding a directory is pure DOM — no refetch.
const treeCache = new Map(); // workspace path -> FsTree
let treeRoot = "";          // workspace path the rendered tree is rooted at
let sideTab = "sessions";
// The hub snapshot carries every session's workspace from the first frame,
// while state.workspace only arrives once the model has actually started — so
// a session that is still starting (or whose backend failed) has no
// state.workspace even though it does have a folder. Read the snapshot first.
function currentWorkspace() {
  const sid = active && active.sid;
  const info = sid ? sessInfo.get(sid) : null;
  return (info && info.workspace) || (active && active.state && active.state.workspace) || "";
}
function switchTab(t) {
  sideTab = t === "tree" ? "tree" : "sessions";
  const tabs = document.querySelector(".side-tabs");
  if (tabs) {
    tabs.querySelectorAll(".side-tab").forEach((n) => n.classList.toggle("on", n.dataset.tab === sideTab));
  }
  $("sessions-panel").classList.toggle("on", sideTab === "sessions");
  $("tree-panel").classList.toggle("on", sideTab === "tree");
  ls.set("smol.side.tab", sideTab);
  if (sideTab === "tree") loadTree();
}
function loadTree(force) {
  const node = $("fstree");
  if (!node) return;
  if (!active) { renderTreeMessage(node, "No session open — pick or start one first."); return; }
  const sid = active.sid;
  // The server resolves the workspace from the sid, so an unknown session is
  // the only case that yields no tree — don't gate the fetch on client state.
  const key = currentWorkspace() || sid;
  if (force) treeCache.delete(key);
  const cached = treeCache.get(key);
  if (cached) { renderTree(node, cached); return; }
  renderTreeMessage(node, "Loading…");
  // GET, not POST: the tree route is a GET in the hub's query switch.
  fetch("/fs/tree?k=" + k + "&sid=" + encodeURIComponent(sid))
    .then((r) => r.json())
    .then((r) => {
      if (active && active.sid !== sid) return; // the user moved on
      if (r && r.ok && r.tree) {
        treeCache.set(key, r.tree);
        renderTree(node, r.tree);
      } else {
        renderTreeMessage(node, "This session has no workspace folder.");
      }
    })
    .catch(() => { renderTreeMessage(node, "Cannot reach the smolcoder server."); });
}
function renderTreeMessage(node, msg) {
  node.innerHTML = "";
  node.appendChild(el("div", "tree-empty", msg));
}
function treeRow(name, path, isDir) {
  const row = el("div", "tri" + (isDir ? " dir" : ""));
  const arrow = el("span", "arrow", isDir ? "▸" : "");
  row.appendChild(arrow);
  row.appendChild(el("span", "fname", name));
  row.title = path;
  return { row, arrow };
}
function renderTree(node, x) {
  node.innerHTML = "";
  // The server resolves the workspace root, so trust it for relative paths
  // instead of re-deriving it from a path that may be "~"-prefixed or stored
  // unresolved.
  treeRoot = x.path || "";
  const label = $("fslabel");
  if (label) { label.textContent = x.name || "Files"; label.title = treeRoot; }
  const expandAll = $("fsexpandall");
  if (expandAll) { expandAll.textContent = "▸"; expandAll.title = "expand all"; }
  // The root is the workspace itself and the header already names it, so the
  // tree starts at its children instead of repeating the same row.
  const frag = document.createDocumentFragment();
  fillTree(frag, x);
  node.appendChild(frag);
}
function fillTree(host, x) {
  for (const c of x.children || []) {
    const { row, arrow } = treeRow(c.name, c.path, true);
    const body = el("div", "tree-body");
    fillTree(body, c);
    body.hidden = true;
    row.onclick = () => {
      const open = body.hidden;
      body.hidden = !open;
      arrow.textContent = open ? "▾" : "▸";
    };
    host.appendChild(row);
    host.appendChild(body);
  }
  for (const f of x.files || []) {
    const p = x.path + "/" + f;
    const { row } = treeRow(f, p, false);
    // Clicking a file opens it, like every other editor. Mentioning its path in
    // the composer is the secondary action, so it lives behind the button that
    // only appears on hover (and alt-click, for the keyboard).
    const rel = relOf(p);
    const say = el("button", "tri-mention", "＋");
    say.title = "put this path in the composer so the agent can be told about it";
    say.onclick = (e) => { e.stopPropagation(); if (active) insertFile(p); };
    row.title = p + "  —  click to open · ＋ to mention";
    row.onclick = (e) => {
      if (!active) return;
      if (e.altKey) { insertFile(p); return; }
      openFileTab(active, rel);
    };
    row.appendChild(say);
    host.appendChild(row);
  }
}
function setTreeExpanded(open) {
  const root = $("fstree");
  if (!root) return;
  root.querySelectorAll(".tri.dir").forEach((row) => {
    const body = row.nextElementSibling;
    if (!body || !body.classList.contains("tree-body")) return;
    body.hidden = !open;
    const arrow = row.querySelector(".arrow");
    if (arrow) arrow.textContent = open ? "▾" : "▸";
  });
  const btn = $("fsexpandall");
  if (btn) {
    btn.textContent = open ? "▾" : "▸";
    btn.title = open ? "collapse all" : "expand all";
  }
}
function relOf(p) {
  const root = treeRoot || currentWorkspace();
  let rel = p;
  if (root && rel.slice(0, root.length) === root) rel = rel.slice(root.length);
  return rel.replace(/^[\\/]+/, "").replace(/\\/g, "/");
}
function insertFile(p) {
  const rel = relOf(p);
  if (!rel) return;
  // A path with spaces has to survive the trip through the model's tool call,
  // so quote it rather than percent-encoding it (the agent needs the real name).
  const token = /\s/.test(rel) ? '"' + rel + '"' : rel;
  const ta = $("input");
  if (ta) {
    const pos = ta.selectionStart == null ? ta.value.length : ta.selectionStart;
    const before = ta.value.slice(0, pos);
    const after = ta.value.slice(pos);
    const glue = before && !/\s$/.test(before) ? " " : "";
    ta.value = before + glue + token + (after ? " " + after : "");
    ta.selectionStart = ta.selectionEnd = (before + glue + token).length;
    autoGrow();
    ta.focus();
  }
}
// Wire tabs + deferred tree load once the DOM is ready.
document.addEventListener("DOMContentLoaded", () => {
  const tabs = document.querySelector(".side-tabs");
  if (tabs) {
    tabs.addEventListener("click", (e) => {
      const t = e.target.closest(".side-tab");
      if (t) switchTab(t.dataset.tab);
    });
    switchTab(ls.get("smol.side.tab") === "tree" ? "tree" : "sessions");
  }
  const expandAll = $("fsexpandall");
  if (expandAll) {
    expandAll.onclick = () => setTreeExpanded(expandAll.textContent !== "▾");
  }
  const reload = $("fsreload");
  if (reload) reload.onclick = () => loadTree(true);
  const full = $("panelfull");
  if (full) {
    full.addEventListener("click", () => {
      if (!active || !active.panelOpen) return;
      active.panelFull = !active.panelFull;
      renderPanel();
    });
    window.addEventListener("keydown", (e) => {
      if (e.key === "b" && e.ctrlKey && e.shiftKey) {
        if (active && active.panelOpen) { active.panelFull = !active.panelFull; renderPanel(); e.preventDefault(); }
      }
    });
  }
});

// ---- folder picker --------------------------------------------------------
let fsState = { path: "", parent: null };
function openDialog(start) {
  $("modal").hidden = false;
  browse(start || currentWorkspace());
  setTimeout(() => $("fspath").focus(), 0);
}
function closeDialog() { $("modal").hidden = true; }
function browse(p) {
  fetch("/fs?k=" + k + "&path=" + encodeURIComponent(p || "")).then((r) => r.json()).then(renderFs).catch(() => {});
}
function renderFs(d) {
  const list = $("fslist");
  list.innerHTML = "";
  const roots = $("fsroots");
  roots.innerHTML = "";
  const chip = (label, p) => { const c = el("span", "chip", label); c.onclick = () => browse(p); roots.appendChild(c); };
  chip("~ home", d.home);
  for (const r of d.roots || []) chip(r, r);
  if (d.error) { $("fspath").value = d.path || ""; list.appendChild(el("div", "sidehint", d.error)); $("fsopen").disabled = true; return; }
  $("fsopen").disabled = false;
  fsState = d;
  $("fspath").value = d.path;
  $("fsopen").textContent = "Open " + (d.path.split(/[\\/]/).filter(Boolean).pop() || d.path) + (d.project ? " ✦" : "");
  if (d.parent) { const up = el("div", "fsitem up", "↑ .."); up.onclick = () => browse(d.parent); list.appendChild(up); }
  for (const dir of d.dirs) {
    const it = el("div", "fsitem");
    it.appendChild(el("span", "", dir.name + "/"));
    if (dir.project) it.appendChild(el("span", "proj", "✦ project"));
    it.onclick = () => browse(dir.path);
    it.ondblclick = () => openFolder(dir.path);
    list.appendChild(it);
  }
  if (!d.dirs.length) list.appendChild(el("div", "sidehint", "no subfolders"));
}
function openFolder(p) {
  post("/workspaces/add", { path: p, start: $("fsstart").checked }).then((r) => {
    if (r.error) { alert(r.error); return; }
    closeDialog();
    if (r.id) { pendingSelect = r.id; show(r.id); }
  });
}
$("openfolder").onclick = () => openDialog();
$("welcomeopen").onclick = () => openDialog();
$("fsclose").onclick = closeDialog;
$("modal").onclick = (e) => { if (e.target === $("modal")) closeDialog(); };
$("fsgo").onclick = () => browse($("fspath").value);
$("fspath").onkeydown = (e) => { if (e.key === "Enter") browse($("fspath").value); };
$("fsopen").onclick = () => openFolder(fsState.path);

// ---- right panel: browser + terminal tabs ---------------------------------
let panelWidth = Math.max(300, Number(ls.get("smol.panel.w")) || 520);
function panelKey(v) { return "smol.panel." + v.sid; }
function savePanel(v) {
  ls.set(panelKey(v), JSON.stringify({
    open: v.panelOpen,
    full: v.panelFull,
    active: v.activeTab,
    // Only browser and file tabs survive a reload. Terminals are owned by the
    // hub (a pty does not outlive the process), so they are rebuilt from the
    // snapshot by reconcileTerms instead.
    tabs: v.tabs.filter((t) => t.kind === "browser" || t.kind === "file").map((t) => t.kind === "browser" ? { kind: "browser", url: t.url } : { kind: "file", rel: t.rel }),
  }));
}
function loadPanelState(v) {
  try {
    const st = JSON.parse(ls.get(panelKey(v)) || "null");
    if (!st) return;
    const files = [];
    for (const t of st.tabs || []) {
      if (t.kind === "browser") {
        const tab = { kind: "browser", url: t.url || "", id: uid() };
        buildBrowserTab(v, tab); v.tabs.push(tab);
      } else if (t.kind === "file" && t.rel) {
        // Re-read from disk, so a tab that was open when the browser closed
        // comes back with current content rather than a stale copy — and a file
        // that has since become unopenable does not come back at all.
        files.push(t.rel);
      }
    }
    if (files.length) restoreFileTabs(v, files);
    v.panelOpen = !!st.open;
    v.panelFull = !!st.full;
    v.activeTab = st.active || (v.tabs[0] && v.tabs[0].id) || null;
  } catch (e) {}
}
// Restoring is the one place where dropping a tab silently would be confusing —
// the user left with it open and would wonder where it went — so the ones that
// cannot come back are named once, together.
function restoreFileTabs(v, rels) {
  const dropped = [];
  Promise.all(rels.map((rel) => readFile(v, rel).then((r) => {
    const problem = fileOpenProblem(r);
    if (problem) { dropped.push(rel + " — " + problem); return; }
    const b = r.body;
    const t = { kind: "file", rel: b.rel || rel, id: uid(), mtimeMs: b.mtimeMs, saved: "", missing: false, binary: false, truncated: false };
    buildFileTab(v, t);
    applyFileBody(v, t, b);
    v.tabs.push(t);
  }))).then(() => {
    if (!dropped.length) return;
    alert("These files could not be reopened:\n\n" + dropped.map((d) => "· " + d.replace(/\.\s*$/, "")).join("\n") + "\n\nTheir tabs were left out.");
    savePanel(v);
    if (v === active) renderPanel();
  });
}
function curTab(v) { return v.tabs.find((t) => t.id === v.activeTab) || v.tabs[0] || null; }
// One place that turns a tab into what its header shows, so the label, the
// tooltip and the aria text never disagree about which file is open.
function tabLabel(t) {
  if (t.kind === "browser") return t.url ? t.url.replace(/^https?:\/\//, "") : "new tab";
  if (t.kind === "term") return "terminal " + t.tid.replace(/^t/, "");
  // Just the name: the tab strip is narrow, and the full path is in the tab body.
  return t.rel ? t.rel.split("/").pop() : "file";
}
function tabTitle(t) {
  if (t.kind === "browser") return t.url || "new browser tab";
  if (t.kind === "term") return "terminal in " + shortPath(t.cwd);
  return t.missing ? t.rel + " (deleted)" : t.rel;
}
function tabIcon(t) {
  if (t.kind === "browser") return "◎";
  if (t.kind === "term") return ">_";
  return t.missing ? "⚠" : "▤";
}
function tabChanged(t) {
  if (t.kind !== "file" || t.missing || t.binary || t.loading || !t.ta) return false;
  return t.ta.value !== t.saved;
}
// A keystroke only changes one thing in the tab bar: the unsaved dot. Redrawing
// the whole strip on every character would also throw away its scroll position.
function refreshFileTab(v, t) {
  if (v !== active) return;
  const dot = tabsEl.querySelector(".ptab[data-tab=" + t.id + "] .dot-unsaved");
  if (dot) dot.hidden = !tabChanged(t);
}
function renderPanel() {
  const v = active;
  const open = !!(v && v.panelOpen && v.tabs.length);
  panelEl.hidden = !open;
  const cur = open ? curTab(v) : null;
  $("btnbrowser").classList.toggle("on", !!(cur && cur.kind === "browser"));
  $("btnterm").classList.toggle("on", !!(cur && cur.kind === "term"));
  $("btnfiles").classList.toggle("on", !!(cur && cur.kind === "file"));
  for (const o of views.values()) o.panelEl.hidden = o !== v || !open;
  if (!open) return;
  // Never let the panel squeeze the chat below ~20% of a small window.
  // Keep this in sync with the 0.8 upper bound in the #panelgrip drag handler,
  // otherwise a switch that calls renderPanel() after dragging past 60% snaps
  // the panel back to a narrower width.
  const pw = Math.min(panelWidth, Math.max(300, window.innerWidth * 0.8));
  // Full width comes from the body.panel-full rules in styles.ts, so the inline
  // width has to get out of the way — the width the user dragged to is still
  // remembered in panelWidth and comes back when they toggle off.
  panelEl.style.width = v.panelFull ? "" : pw + "px";
  document.body.classList.toggle("panel-full", v.panelFull);
  $("panelfull").classList.toggle("on", v.panelFull);
  tabsEl.innerHTML = "";
  for (const t of v.tabs) {
    const b = el("div", "ptab" + (t === cur ? " on" : ""));
    b.dataset.tab = t.id;
    b.appendChild(el("span", "ico", tabIcon(t)));
    b.appendChild(el("span", "lbl", tabLabel(t)));
    if (t.kind === "file") {
      const dot = el("span", "dot-unsaved", "●");
      dot.hidden = !tabChanged(t);
      dot.title = "unsaved changes";
      b.appendChild(dot);
    }
    const x = el("span", "x", "×"); x.title = "close tab";
    x.onclick = (e) => { e.stopPropagation(); closeTab(v, t); };
    b.appendChild(x);
    b.onclick = () => { v.activeTab = t.id; savePanel(v); renderPanel(); if (t.kind === "term" && t.inp) t.inp.focus(); if (t.kind === "file" && t.ta) t.ta.focus(); };
    b.title = tabTitle(t);
    tabsEl.appendChild(b);
  }
  tabsEl.appendChild(el("span", "grow"));
  const nb = el("button", "iconbtn", "+◎"); nb.title = "new browser tab"; nb.onclick = () => openBrowserTab(v);
  const nt = el("button", "iconbtn", "+>_"); nt.title = "new terminal"; nt.onclick = () => openTerminalTab(v);
  const nf = el("button", "iconbtn", "+▤"); nf.title = "open a file in the editor"; nf.onclick = () => openFileTab(v, "");
  const cl = el("button", "iconbtn", "»"); cl.title = "hide panel"; cl.onclick = () => { v.panelOpen = false; savePanel(v); renderPanel(); };
  tabsEl.appendChild(nb); tabsEl.appendChild(nt); tabsEl.appendChild(nf); tabsEl.appendChild(cl);
  for (const t of v.tabs) if (t.el) t.el.hidden = t !== cur;
}
function closeTab(v, t) {
  const i = v.tabs.indexOf(t);
  if (t.kind === "term") { post("/term/close", { sid: v.sid, tid: t.tid }); removeTermTab(v, t.tid); return; }
  if (tabChanged(t) && !confirm("Save your changes to " + t.rel + " before closing it?")) {
    if (!confirm("Close " + t.rel + " anyway and lose the changes?")) return;
  }
  if (i >= 0) v.tabs.splice(i, 1);
  if (t.el) t.el.remove();
  if (v.activeTab === t.id) v.activeTab = (v.tabs[i] || v.tabs[i - 1] || {}).id || null;
  savePanel(v); renderPanel();
}
function togglePanelKind(kind) {
  const v = active;
  if (!v) return;
  const cur = curTab(v);
  if (v.panelOpen && cur && cur.kind === kind) { v.panelOpen = false; savePanel(v); renderPanel(); return; }
  const existing = v.tabs.filter((t) => t.kind === kind).pop();
  if (existing) {
    v.activeTab = existing.id; v.panelOpen = true; savePanel(v); renderPanel();
    if (kind === "term" && existing.inp) existing.inp.focus();
    if (kind === "file" && existing.ta) existing.ta.focus();
  } else if (kind === "browser") openBrowserTab(v);
  else if (kind === "term") openTerminalTab(v);
  else openFileTab(v, "");
}
$("btnbrowser").onclick = () => togglePanelKind("browser");
$("btnterm").onclick = () => togglePanelKind("term");
$("btnfiles").onclick = () => togglePanelKind("file");

// browser tabs
function fillUrls(t, urls) {
  if (!t.dl) return;
  const cur = [...t.dl.options].map((o) => o.value).join("|");
  if (cur === urls.join("|")) return;
  t.dl.innerHTML = "";
  for (const u of urls) { const o = document.createElement("option"); o.value = u; t.dl.appendChild(o); }
  t.urlsEl.innerHTML = "";
  if (urls.length && !t.url) {
    t.urlsEl.appendChild(el("div", "hint", "dev servers the agent started:"));
    for (const u of urls) { const b = el("button", "ghost", u); b.onclick = () => t.nav(u); t.urlsEl.appendChild(b); }
  }
}
function openBrowserTab(v, url) {
  const t = { kind: "browser", url: "", id: uid() };
  buildBrowserTab(v, t);
  v.tabs.push(t); v.activeTab = t.id; v.panelOpen = true;
  const start = url || (v.state.urls && v.state.urls[0]) || "";
  if (start) t.nav(start); else { savePanel(v); renderPanel(); t.urlIn.focus(); }
}
function buildBrowserTab(v, t) {
  const body = el("div", "tabbody browser"); body.hidden = true;
  const bar = el("div", "bar");
  const reload = el("button", "iconbtn", "↻"); reload.title = "reload";
  const urlIn = document.createElement("input"); urlIn.placeholder = "http://localhost:5173"; urlIn.spellcheck = false;
  const dlId = "dl_" + t.id; const dl = document.createElement("datalist"); dl.id = dlId; urlIn.setAttribute("list", dlId);
  const go = el("button", "iconbtn", "→"); go.title = "go";
  const ext = el("a", "iconbtn", "↗"); ext.title = "open in a new browser tab"; ext.target = "_blank"; ext.rel = "noopener";
  bar.appendChild(reload); bar.appendChild(urlIn); bar.appendChild(dl); bar.appendChild(go); bar.appendChild(ext);
  const empty = el("div", "empty");
  empty.appendChild(el("div", "", "Enter a URL to preview it here."));
  const urlsEl = el("div", "urls"); empty.appendChild(urlsEl);
  const frame = document.createElement("iframe"); frame.hidden = true;
  // Games need pointer lock; confirmation dialogs must reach the user.
  // Keep navigation to the harness origin blocked below.
  frame.setAttribute("sandbox", "allow-scripts allow-forms allow-same-origin allow-popups allow-pointer-lock allow-modals");
  frame.referrerPolicy = "no-referrer";
  frame.title = "App preview";
  body.appendChild(bar); body.appendChild(empty); body.appendChild(frame);
  v.panelEl.appendChild(body);
  t.el = body; t.frame = frame; t.urlIn = urlIn; t.dl = dl; t.urlsEl = urlsEl;
  t.nav = (u) => {
    u = (u || "").trim();
    if (!u) return;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) u = "http://" + u;
    let parsed;
    try { parsed = new URL(u); } catch { urlIn.setCustomValidity("Enter a valid http or https URL"); urlIn.reportValidity(); return; }
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.origin === location.origin || (["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) && parsed.port === location.port)) {
      urlIn.setCustomValidity("Preview a separate app using http or https"); urlIn.reportValidity(); return;
    }
    urlIn.setCustomValidity(""); u = parsed.href;
    t.url = u; urlIn.value = u; ext.href = u;
    frame.src = u; frame.hidden = false; empty.hidden = true;
    savePanel(v); renderPanel();
  };
  go.onclick = () => t.nav(urlIn.value);
  urlIn.onkeydown = (e) => { if (e.key === "Enter") t.nav(urlIn.value); };
  reload.onclick = () => { if (t.url) frame.src = t.url; };
  fillUrls(t, v.state.urls || []);
  if (t.url) t.nav(t.url);
}

// file tabs
// A plain textarea, not a code editor: this project takes no runtime
// dependencies, and the file's own content is the point. Text goes in and out
// through .value / textContent only — never innerHTML.
function fileReadOnly(v) {
  return !!(v && v.state && v.state.mode === "ro");
}
// A read-only session still gets a live view of the file: the agent can rewrite
// it, and reload is how you see that. What it does not get is a way to write.
function applyFileMode(v, t) {
  const ro = fileReadOnly(v);
  if (t.badge) t.badge.hidden = !ro;
  if (t.saveBtn) { t.saveBtn.disabled = ro; t.saveBtn.title = ro ? "This session is read-only — files can be opened but not saved." : "save (ctrl/cmd+s)"; }
  if (t.reloadBtn) t.reloadBtn.title = ro ? "re-read from disk" : "re-read from disk, discarding the changes in this tab";
  if (t.ta && !t.missing && !t.binary) t.ta.readOnly = ro;
  if (ro && tabChanged(t)) setFileStatus(t, "read-only session", "err");
}
function setFileStatus(t, msg, kind) {
  if (!t.status) return;
  t.status.textContent = msg || "";
  t.status.className = "fstatus" + (kind ? " " + kind : "");
}
function buildFileTab(v, t) {
  const body = el("div", "tabbody file");
  body.hidden = true;
  const bar = el("div", "fbar");
  const path = el("span", "fpath", t.rel || "(no file)");
  path.title = t.rel || "";
  const badge = el("span", "fbadge", "read-only");
  badge.title = "This session is read-only — files can be opened but not saved.";
  const save = el("button", "iconbtn fsave", "💾");
  save.title = "save (ctrl/cmd+s)";
  const reload = el("button", "iconbtn freload", "↻");
  reload.title = "re-read from disk, discarding the changes in this tab";
  const status = el("span", "fstatus");
  bar.appendChild(path); bar.appendChild(badge); bar.appendChild(el("span", "grow"));
  bar.appendChild(status); bar.appendChild(reload); bar.appendChild(save);
  const ta = document.createElement("textarea");
  ta.className = "feditor";
  ta.spellcheck = false;
  ta.setAttribute("aria-label", "File contents");
  ta.setAttribute("wrap", "off");
  ta.title = "ctrl/cmd+s to save";
  ta.placeholder = "Loading…";
  const note = el("div", "fnote");
  note.hidden = true;
  body.appendChild(bar); body.appendChild(ta); body.appendChild(note);
  v.panelEl.appendChild(body);
  t.el = body; t.ta = ta; t.status = status; t.saveBtn = save; t.reloadBtn = reload; t.note = note; t.pathEl = path; t.badge = badge;
  t.saved = "";

  applyFileMode(v, t);
  ta.oninput = () => refreshFileTab(v, t);
  ta.onkeydown = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); saveFileTab(v, t); }
    // Tab indents instead of leaving the field — this is a text editor.
    else if (e.key === "Tab") { e.preventDefault(); insertAtCursor(ta, "  "); }
  };
  save.onclick = () => saveFileTab(v, t);
  reload.onclick = () => {
    if (tabChanged(t) && !confirm("Re-read " + t.rel + " from disk? The changes in this tab are lost.")) return;
    loadFileInto(v, t);
  };
}
function insertAtCursor(ta, text) {
  const pos = ta.selectionStart == null ? ta.value.length : ta.selectionStart;
  ta.value = ta.value.slice(0, pos) + text + ta.value.slice(ta.selectionEnd == null ? pos : ta.selectionEnd);
  ta.selectionStart = ta.selectionEnd = pos + text.length;
  ta.focus();
}
function setFileNote(t, msg) {
  if (!t.note) return;
  t.note.textContent = msg || "";
  t.note.hidden = !msg;
}
function readFile(v, rel) {
  return fetch("/fs/file?k=" + k + "&sid=" + encodeURIComponent(v.sid) + "&path=" + encodeURIComponent(rel))
    .then((r) => r.json().then((b) => ({ code: r.status, body: b || {} })))
    .catch(() => ({ code: 0, body: { error: "cannot reach the smolcoder server" } }));
}
// Why a read cannot become an editor tab, or "" when it can. A panel with
// nothing to show in it is worse than no panel: it is noise now and a "why is
// this tab here" question later.
function fileOpenProblem(r) {
  if (r.code === 0) return r.body.error || "cannot reach the smolcoder server";
  if (r.code === 404) return "there is no such file in this workspace (it may have been deleted or renamed)";
  if (r.code === 403) return r.body.error || "that path is outside the workspace";
  if (r.code === 400) return r.body.error || "that is a folder, not a file";
  if (r.code !== 200) return r.body.error || "the server said " + r.code;
  if (r.body.error) return r.body.error;
  if (r.body.binary) return "this is a binary file (" + fmtSize(r.body.size) + ") — there is nothing to preview or edit";
  return "";
}
function applyFileBody(v, t, b) {
  t.missing = false;
  t.binary = false;
  t.mtimeMs = b.mtimeMs;
  t.truncated = !!b.truncated;
  applyFileMode(v, t);
  // The file's bytes only ever reach the page as a textarea value, which is
  // never parsed as markup.
  t.ta.value = b.content;
  t.saved = b.content;
  setFileNote(t, b.truncated
    ? "Showing the first " + fmtSize(b.size - b.truncatedBytes) + " of " + fmtSize(b.size) + ". Saving asks first, because it would cut the rest off."
    : "");
  setFileStatus(t, "saved", "");
}
function loadFileInto(v, t) {
  t.ta.value = "Loading…";
  t.saved = "";
  t.loading = true;
  return readFile(v, t.rel)
    .then((r) => {
      // The tab already exists and may hold unsaved edits, so a file that went
      // away is reported in place rather than by closing the tab out from under
      // the user. Only *creating* a tab refuses; see fileOpenProblem.
      if (r.code === 404) {
        t.missing = true;
        t.ta.value = "";
        t.ta.readOnly = true;
        setFileNote(t, "This file was deleted or renamed outside smolcoder. Your text is still here but cannot be saved — copy it somewhere else before closing this tab.");
        setFileStatus(t, "deleted", "err");
        refreshFileTab(v, t);
        return;
      }
      const problem = fileOpenProblem(r);
      if (problem) {
        t.ta.value = "";
        t.ta.readOnly = true;
        setFileNote(t, "Cannot open this file: " + problem);
        setFileStatus(t, "cannot open", "err");
        refreshFileTab(v, t);
        return;
      }
      applyFileBody(v, t, r.body);
      refreshFileTab(v, t);
    })
    .then(() => { t.loading = false; });
}
function saveFileTab(v, t, force) {
  if (t.missing) { setFileStatus(t, "deleted — nothing to save", "err"); return Promise.resolve(); }
  if (fileReadOnly(v)) { setFileStatus(t, "read-only session", "err"); return Promise.resolve(); }
  const content = t.ta.value;
  if (!force && content === t.saved) { setFileStatus(t, "no changes", ""); return Promise.resolve(); }
  // The tab only ever holds the first 512KB of a bigger file, so saving it
  // would silently delete the rest. That is not a thing to do on a reflex.
  if (!force && t.truncated && !confirm(t.rel + " is larger than the editor's limit, so this tab only shows the beginning of it.\n\nSaving will replace the file with just that part and lose the rest.\n\nOK — save the truncated version anyway\nCancel — leave the file alone")) {
    setFileStatus(t, "not saved — would truncate the file", "warn");
    return Promise.resolve();
  }
  t.saveBtn.disabled = true;
  setFileStatus(t, "saving…", "");
  return post("/fs/file", { sid: v.sid, path: t.rel, content, mtimeMs: force ? null : t.mtimeMs })
    .then((r) => {
      t.saveBtn.disabled = false;
      if (r && r.conflict) {
        // The agent (or another editor) touched it. Never silently win.
        const take = confirm(
          t.rel + " changed on disk while you were editing it.\n\n" +
          "OK — overwrite the disk with your version\n" +
          "Cancel — load the disk version and lose your changes"
        );
        if (take) { saveFileTab(v, t, true); return; }
        t.ta.value = r.serverContent;
        t.saved = r.serverContent;
        t.mtimeMs = r.mtimeMs;
        setFileNote(t, "Loaded the version from disk. Your edits were discarded.");
        setFileStatus(t, "reloaded from disk", "warn");
        refreshFileTab(v, t);
        return;
      }
      // post() answers {} when the request never made it, so "no error" is not
      // the same as "saved" — only an explicit ok is.
      if (!r || !r.ok) {
        setFileStatus(t, (r && r.error) || "the server did not answer — nothing was written", "err");
        return;
      }
      t.saved = content;
      t.mtimeMs = r.mtimeMs;
      t.truncated = false;
      setFileStatus(t, "saved", "");
      refreshFileTab(v, t);
    });
}
function openFileTab(v, rel) {
  let r = (rel || "").trim();
  if (!r) {
    r = String(prompt("Open which file? (path relative to the workspace)", "") || "").trim();
    if (!r) return;
  }
  const already = v.tabs.find((t) => t.kind === "file" && t.rel === r);
  if (already) {
    v.activeTab = already.id; v.panelOpen = true; savePanel(v); renderPanel();
    if (already.ta) already.ta.focus();
    return;
  }
  // Read before drawing anything: an unopenable file gets a warning and no
  // tab, rather than a tab that says it cannot be opened.
  return readFile(v, r).then((res) => {
    const problem = fileOpenProblem(res);
    if (problem) { alert(cannotOpen(r, problem)); return; }
    const b = res.body;
    const t = { kind: "file", rel: b.rel || r, id: uid(), mtimeMs: b.mtimeMs, saved: "", missing: false, binary: false, truncated: false };
    buildFileTab(v, t);
    v.tabs.push(t);
    v.activeTab = t.id; v.panelOpen = true;
    applyFileBody(v, t, b);
    savePanel(v); renderPanel();
    t.ta.focus();
  });
}
// The sandbox's own message already ends in a period, so do not add a second.
function cannotOpen(rel, problem) {
  return "Cannot open " + rel + "\n\n" + problem.replace(/\.\s*$/, "") + ".";
}

// terminal tabs
function ensureTermTab(v, tid, cwd) {
  let t = v.terms.get(tid);
  if (t) { if (cwd) setPrompt(t, cwd); return t; }
  t = { kind: "term", tid, id: "t:" + tid, cwd: cwd || "", history: [], hi: 0, lines: 0, cur: null };
  const body = el("div", "tabbody term"); body.hidden = true;
  const out = el("pre", "out");
  const row = el("div", "trow");
  const prompt = el("span", "prompt");
  const inp = document.createElement("input");
  inp.placeholder = "Run a command…"; inp.title = "Enter to run · Ctrl+C to interrupt · Ctrl+L to clear"; inp.setAttribute("aria-label", "Terminal command"); inp.spellcheck = false; inp.autocomplete = "off";
  inp.onkeydown = (e) => {
    if (e.key === "Enter") {
      const text = inp.value;
      if (!text.trim()) return;
      inp.value = "";
      if (t.history[t.history.length - 1] !== text) t.history.push(text);
      t.hi = t.history.length;
      post("/term/input", { sid: v.sid, tid, text });
    } else if (e.key === "c" && e.ctrlKey && !String(window.getSelection())) { e.preventDefault(); post("/term/interrupt", { sid: v.sid, tid }); }
    else if (e.key === "l" && e.ctrlKey) { e.preventDefault(); out.innerHTML = ""; t.cur = null; t.lines = 0; }
    else if (e.key === "ArrowUp") { if (t.hi > 0) { t.hi--; inp.value = t.history[t.hi]; } e.preventDefault(); }
    else if (e.key === "ArrowDown") { if (t.hi < t.history.length - 1) { t.hi++; inp.value = t.history[t.hi]; } else { t.hi = t.history.length; inp.value = ""; } e.preventDefault(); }
  };
  out.onclick = () => { if (!String(window.getSelection())) inp.focus(); };
  row.appendChild(prompt); row.appendChild(inp);
  body.appendChild(out); body.appendChild(row);
  v.panelEl.appendChild(body);
  t.el = body; t.out = out; t.inp = inp; t.promptEl = prompt;
  setPrompt(t, cwd || "");
  v.terms.set(tid, t); v.tabs.push(t);
  if (!v.activeTab) v.activeTab = t.id;
  if (v === active) renderPanel();
  return t;
}
function setPrompt(t, cwd) { t.cwd = cwd; t.promptEl.textContent = (shortPath(cwd) || "…") + " ❯"; t.promptEl.title = cwd; }
function termWrite(v, tid, text) {
  const t = v.terms.get(tid) || ensureTermTab(v, tid, "");
  const out = t.out;
  const nearBottom = out.scrollHeight - out.scrollTop - out.clientHeight < 60;
  const parts = text.split("\n");
  for (let i = 0; i < parts.length; i++) {
    let seg = parts[i];
    if (i > 0) t.cur = null;
    if (!t.cur) { t.cur = el("div", "l"); out.appendChild(t.cur); t.lines++; }
    const cr = seg.lastIndexOf("\r");
    if (cr >= 0) { t.cur.innerHTML = ""; seg = seg.slice(cr + 1); }
    if (seg) t.cur.appendChild(ansiToFrag(seg));
  }
  while (t.lines > 4000 && out.firstChild) { out.removeChild(out.firstChild); t.lines--; }
  if (nearBottom) out.scrollTop = out.scrollHeight;
}
function termDone(v, tid, code, cwd) {
  const t = v.terms.get(tid);
  if (!t) return;
  if (cwd) setPrompt(t, cwd);
  if (t.cur && t.cur.textContent) termWrite(v, tid, "\n");
  if (code) termWrite(v, tid, "\x1b[2m[exit " + code + "]\x1b[0m\n");
}
function removeTermTab(v, tid) {
  const t = v.terms.get(tid);
  if (!t) return;
  v.terms.delete(tid);
  const i = v.tabs.indexOf(t);
  if (i >= 0) v.tabs.splice(i, 1);
  if (t.el) t.el.remove();
  if (v.activeTab === t.id) v.activeTab = (v.tabs[i] || v.tabs[i - 1] || {}).id || null;
  savePanel(v);
  if (v === active) renderPanel();
}
function reconcileTerms(v) {
  const info = sessInfo.get(v.sid);
  const alive = new Set(info && info.live ? info.terminals.map((x) => x.tid) : []);
  for (const tid of [...v.terms.keys()]) if (!alive.has(tid)) removeTermTab(v, tid);
  if (info && info.live) for (const x of info.terminals) ensureTermTab(v, x.tid, x.cwd);
}
function openTerminalTab(v) {
  post("/term/open", { sid: v.sid }).then((r) => {
    if (!r.tid) { if (r.error) alert(r.error); return; }
    const t = ensureTermTab(v, r.tid, r.cwd);
    v.activeTab = t.id; v.panelOpen = true; savePanel(v); renderPanel();
    t.inp.focus();
  });
}

// resize grip
$("panelgrip").onmousedown = (e) => {
  e.preventDefault();
  document.body.classList.add("dragging");
  const move = (ev) => { panelWidth = Math.min(window.innerWidth * 0.8, Math.max(300, window.innerWidth - ev.clientX)); panelEl.style.width = panelWidth + "px"; };
  const up = () => { document.body.classList.remove("dragging"); document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up); ls.set("smol.panel.w", String(Math.round(panelWidth))); };
  document.addEventListener("mousemove", move);
  document.addEventListener("mouseup", up);
};

// ---- sidebar collapse -----------------------------------------------------
function setSide(collapsed) {
  sideEl.classList.toggle("collapsed", collapsed);
  $("sidetoggle").hidden = !collapsed;
  ls.set("smol.side", collapsed ? "1" : "0");
}
function narrow() { return window.matchMedia("(max-width: 1000px)").matches; }
$("sidecollapse").onclick = () => setSide(true);
$("sidetoggle").onclick = () => setSide(false);
setSide(ls.get("smol.side") === "1" || (narrow() && !!location.hash));

// ---- input + slash menu ---------------------------------------------------
let menuIdx = 0;
function menuItems() {
  const v = input.value;
  if (!active || !v.startsWith("/") || v.includes(" ") || v.includes("\n")) return [];
  return (active.state.commands || []).filter((c) => c.name.startsWith(v.slice(1)));
}
function renderMenu() {
  const items = menuItems();
  menu.style.display = items.length ? "block" : "none";
  menu.innerHTML = "";
  if (menuIdx >= items.length) menuIdx = 0;
  items.forEach((c, i) => {
    const d = el("div", "item" + (i === menuIdx ? " sel" : ""));
    d.appendChild(el("span", "nm", "/" + c.name)); d.appendChild(el("span", "ds", c.desc));
    d.onclick = () => { input.value = "/" + c.name; submit(); };
    menu.appendChild(d);
  });
}
function submit() {
  if (!active) return;
  let v = input.value;
  const items = menuItems();
  if (items.length) v = "/" + items[menuIdx].name;
  v = v.trim();
  const pending = pendingOf(active);
  if (pending.some((a) => a.uploading)) return; // let the upload finish first
  const files = pending.filter((a) => a.id).map((a) => a.id);
  if (!v && !files.length) return;
  input.value = ""; active.draft = ""; active.pending = []; renderMenu(); autoGrow(); renderAttachments();
  scrollToBottom();
  post("/msg", { sid: active.sid, text: v, attachments: files }).then((r) => { if (r && r.error) alert(r.error); });
}
function autoGrow() { input.rows = Math.min(6, Math.max(1, input.value.split("\n").length)); }
input.addEventListener("input", () => { menuIdx = 0; renderMenu(); autoGrow(); });
input.addEventListener("keydown", (e) => {
  const items = menuItems();
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
  else if (e.key === "Tab" && e.shiftKey) { e.preventDefault(); if (active) post("/cycle", { sid: active.sid }); }
  else if (e.key === "Tab" && items.length) { e.preventDefault(); input.value = "/" + items[menuIdx].name + " "; renderMenu(); }
  else if (e.key === "ArrowUp" && items.length) { e.preventDefault(); menuIdx = (menuIdx - 1 + items.length) % items.length; renderMenu(); }
  else if (e.key === "ArrowDown" && items.length) { e.preventDefault(); menuIdx = (menuIdx + 1) % items.length; renderMenu(); }
  else if (e.key === "Escape") { if (input.value) { input.value = ""; renderMenu(); autoGrow(); } else if (active) post("/cancel", { sid: active.sid }); }
});
actionBtn.onclick = () => { if (!active) return; if (active.busyLabel) post("/cancel", { sid: active.sid }); else submit(); };

// ---- attachments ----------------------------------------------------------
// Paste a screenshot (ctrl+v or right-click → paste), drop files on the chat,
// or pick them with the paperclip. Each file is uploaded right away and shown
// as a chip; the ids go with the next message.
const attachRow = $("attachrow"), filePick = $("filepick"), mainEl = $("main");
function pendingOf(v) { if (!v.pending) v.pending = []; return v.pending; }
function renderAttachments() {
  attachRow.innerHTML = "";
  const list = active ? pendingOf(active) : [];
  attachRow.hidden = !list.length;
  for (const a of list) {
    const chip = el("span", "attach" + (a.uploading ? " uploading" : "") + (a.warning ? " warn" : ""));
    if (a.kind === "image" && a.url) { const img = el("img", "attach-thumb"); img.src = a.url + "&k=" + k; img.alt = ""; chip.appendChild(img); }
    chip.appendChild(el("span", "attach-name", a.name));
    chip.appendChild(el("span", "dim", a.uploading ? "uploading…" : fmtSize(a.size)));
    if (a.warning) { chip.title = a.warning; chip.appendChild(el("span", "note", "model can't see images")); }
    const x = el("button", "attach-x", "×"); x.type = "button"; x.title = "remove"; x.onclick = () => removeAttachment(a);
    chip.appendChild(x);
    attachRow.appendChild(chip);
  }
}
function addFiles(files) {
  if (!active) return;
  for (const f of files) upload(active, f);
  input.focus();
}
async function upload(v, file) {
  const type = file.type || "application/octet-stream";
  const name = file.name || (type.startsWith("image/") ? "pasted-image." + (type.split("/")[1] || "png").replace("jpeg", "jpg") : "pasted.txt");
  const entry = { id: null, name, size: file.size, kind: type.startsWith("image/") ? "image" : "text", uploading: true };
  pendingOf(v).push(entry); renderAttachments();
  try {
    const r = await fetch("/upload?k=" + k + "&sid=" + v.sid + "&name=" + encodeURIComponent(name), { method: "POST", headers: { "content-type": type }, body: file });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.error) throw new Error(d.error || ("upload failed (" + r.status + ")"));
    Object.assign(entry, d, { uploading: false });
  } catch (err) {
    const list = pendingOf(v); const i = list.indexOf(entry); if (i >= 0) list.splice(i, 1);
    alert(String((err && err.message) || err));
  }
  renderAttachments();
}
function removeAttachment(a) {
  if (!active) return;
  const list = pendingOf(active); const i = list.indexOf(a); if (i >= 0) list.splice(i, 1);
  if (a.id) post("/upload/remove", { sid: active.sid, id: a.id });
  renderAttachments();
}
$("attachbtn").onclick = () => { if (active) filePick.click(); };
filePick.onchange = () => { addFiles([...filePick.files]); filePick.value = ""; };
input.addEventListener("paste", (e) => {
  const files = e.clipboardData && e.clipboardData.files ? [...e.clipboardData.files] : [];
  if (!files.length) return; // plain text pastes as usual
  e.preventDefault();
  addFiles(files);
});
function hasFiles(e) { return !!(e.dataTransfer && [...e.dataTransfer.types].includes("Files")); }
mainEl.addEventListener("dragover", (e) => { if (!active || !hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = "copy"; mainEl.classList.add("dragging"); });
mainEl.addEventListener("dragleave", (e) => { if (e.relatedTarget && mainEl.contains(e.relatedTarget)) return; mainEl.classList.remove("dragging"); });
mainEl.addEventListener("drop", (e) => { mainEl.classList.remove("dragging"); if (!active || !hasFiles(e)) return; e.preventDefault(); addFiles([...e.dataTransfer.files]); });

// ---- global keys ----------------------------------------------------------
$("keys").onclick = () => {
  const dialog = document.createElement("dialog"); dialog.className = "dlg";
  const list = el("div", "shortcut-list");
  ["/  Commands", "Enter  Send", "Shift+Enter  New line", "Ctrl+V  Paste an image or a file", "Shift+Tab  Permission mode", "Esc  Cancel", "Ctrl+B  Sidebar", "Ctrl+\`  Terminal"].forEach((s) => list.appendChild(el("div", "", s)));
  const close = el("button", "ghost", "Close"); close.onclick = () => dialog.close(); list.appendChild(close);
  dialog.appendChild(list); document.body.appendChild(dialog); dialog.onclose = () => dialog.remove(); dialog.showModal();
};
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && document.activeElement !== input) {
    if (!$("modal").hidden) closeDialog();
    else if (active && !(document.activeElement && document.activeElement.closest && document.activeElement.closest(".tabbody.term"))) post("/cancel", { sid: active.sid });
  } else if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && e.key.toLowerCase() === "b") { e.preventDefault(); setSide(!sideEl.classList.contains("collapsed")); }
  else if (e.ctrlKey && e.key === "\`") { e.preventDefault(); togglePanelKind("term"); }
  else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "s") {
    // The file tab handles it when it has focus; this catches every other case
    // (focus in the composer, in the tree, nowhere) so the browser's own
    // "save page" dialog never appears in an app that edits real files.
    if (document.activeElement && document.activeElement.closest && document.activeElement.closest(".feditor")) return;
    const t = active && curTab(active);
    if (!t || t.kind !== "file") return;
    e.preventDefault();
    saveFileTab(active, t);
  }
});

// ---- connect --------------------------------------------------------------
const es = new EventSource("/events?k=" + k);
es.onopen = () => {
  // Everything is replayed on (re)connect: start each view from a clean slate.
  for (const v of views.values()) {
    v.logEl.innerHTML = ""; v.curText = null; v.curThought = null; v.asks.clear();
    for (const t of v.terms.values()) { t.out.innerHTML = ""; t.cur = null; t.lines = 0; }
  }
};
es.onmessage = (e) => handle(JSON.parse(e.data));
es.onerror = () => { $("status").textContent = "reconnecting…"; };
`;
