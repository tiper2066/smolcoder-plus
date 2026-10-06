// The web hub and its parts: session channel semantics (input, approvals,
// cancel, close), on-disk session/workspace stores, the folder picker
// listing, the embedded terminal (a real shell), and the hub's HTTP surface
// driven with a fake session factory (no model backend needed).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { SessionChannel } = require("../dist/web/channel");
const { SessionStore, WorkspaceStore, workspaceKey } = require("../dist/web/store");
const { Terminal, stripControl, toOsPath } = require("../dist/web/terminal");
const { WebHub, browseDir, readFsFile, writeFsFile, readHubRecord, getSettingsStatus, saveSettingsKey, saveSettingsNotes } = require("../dist/web/hub");
const { cleanTitle, suggestTitle } = require("../dist/session");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 4000, label = "condition") {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("timed out waiting for " + label);
    await sleep(25);
  }
}
function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ---- client bundle (browser JS that ships as one string) ---------------------
// client.ts is a String.raw template, so `tsc` only ever sees a string: a plain
// JS syntax error inside it (a missing brace, say) builds fine and then kills
// the whole page in the browser. These two tests are the guard for that — they
// cover the failure modes nothing else here can see.

const { CLIENT_JS } = require("../dist/web/client");
const { PAGE_HTML } = require("../dist/web/page");

test("web: the client bundle compiles as JavaScript", () => {
  // Compiles without running, so no DOM is needed: a SyntaxError is all we want.
  assert.doesNotThrow(() => new Function(CLIENT_JS));
});

test("web: every element the client looks up by id exists in the page", () => {
  const wanted = [...new Set([...CLIENT_JS.matchAll(/\$\("([A-Za-z0-9_-]+)"\)/g)].map((m) => m[1]))];
  const missing = wanted.filter((id) => !PAGE_HTML.includes(`id="${id}"`));
  assert.deepEqual(missing, [], `client.ts looks up ids the page does not define: ${missing.join(", ")}`);
});

test("web: every question drops the panel out of full width so the chat shows", () => {
  // Regression: only the approval handler bailed out of full width. A picker
  // (/models, /effort) or a text prompt went into the chat, which
  // `body.panel-full #main { display: none }` had already taken off screen —
  // the box was in the DOM at zero height, so its buttons could not be
  // clicked and the options looked like they never appeared.
  const fn = CLIENT_JS.slice(CLIENT_JS.indexOf("function revealChat"), CLIENT_JS.indexOf("function handle(m)"));
  assert.match(fn, /v !== active/, "only the session the user is looking at");
  assert.match(fn, /v\.panelFull = false/, "full width is dropped");
  assert.match(fn, /renderPanel\(\)/, "and the panel is re-rendered");

  // Every kind of ask goes through it, and each one adds its box to the chat.
  for (const kind of ["confirm", "select", "prompt"]) {
    const idx = CLIENT_JS.indexOf(`case "${kind}"`);
    assert.ok(idx > 0, `the ${kind} handler is present`);
    const tail = CLIENT_JS.slice(idx, CLIENT_JS.indexOf("break;", idx));
    assert.match(tail, /revealChat\(v\)/, `${kind} reveals the chat before adding its box`);
    // It has to happen before the box is appended, not after.
    assert.ok(
      tail.indexOf("revealChat(v)") < tail.indexOf("add(v, box)"),
      `${kind} reveals the chat before the box joins the transcript`
    );
  }
  // The ask handlers must not each grow their own copy of the bail-out.
  assert.equal(
    [...CLIENT_JS.matchAll(/panelFull = false/g)].length,
    1,
    "the full-width bail-out lives in revealChat only"
  );
});

test("web: a new picker closes the stale one, so options always go away", () => {
  // Regression: a session waiting on a picker could end up with two boxes on
  // screen (a duplicate command, or a replay). Only the newest one is live, so
  // a box the user cannot dismiss reads as "my choice did not take effect".
  assert.match(CLIENT_JS, /function closeAsk\(v, kind\)/, "there is one place that drops a stale ask box");
  const close = CLIENT_JS.slice(CLIENT_JS.indexOf("function closeAsk"), CLIENT_JS.indexOf("function handle(m)"));
  assert.match(close, /box\._ask !== kind/, "only boxes of the same kind are closed");
  assert.match(close, /box\.remove\(\)/, "the stale box leaves the transcript");
  assert.match(close, /v\.asks\.delete\(id\)/, "and stops being the live ask for that id");
  for (const kind of ["select", "prompt", "confirm"]) {
    const idx = CLIENT_JS.indexOf(`case "${kind}"`);
    const tail = CLIENT_JS.slice(idx, CLIENT_JS.indexOf("break;", idx));
    assert.match(tail, /box\._ask = "([a-z]+)"/, `the ${kind} box is tagged with its kind`);
  }
  const sel = CLIENT_JS.slice(CLIENT_JS.indexOf('case "select"'), CLIENT_JS.indexOf('case "prompt"'));
  assert.match(sel, /closeAsk\(v, "select"\)/, "a new select closes the previous one");
  // The approvals are the one kind that can legitimately stack up, so they are
  // not swept by another picker arriving.
  assert.ok(!/closeAsk\(v, "confirm"\)/.test(CLIENT_JS), "approvals are never closed by a picker");
});

test("web: a picker is driven by the keyboard, like the terminal one", () => {
  // Regression: the web picker had nothing but per-button onclick handlers, so
  // the arrow keys did nothing there while the TUI has had ↑↓/filter/enter since
  // the beginning. It read as "the options will not respond".
  const sel = CLIENT_JS.slice(CLIENT_JS.indexOf('case "select"'), CLIENT_JS.indexOf('case "prompt"'));

  // The box has to take focus, or the keys belong to the composer textarea.
  assert.match(sel, /box\.tabIndex = 0/, "the picker is focusable");
  assert.match(sel, /if \(v === active\) box\.focus\(\)/, "and it is focused when it opens");
  // Exactly one focus call, and it is the guarded one — a picker opening in a
  // background session must not steal focus from the session being read.
  assert.equal([...sel.matchAll(/box\.focus\(\)/g)].length, 1, "focus is called once, inside the active-session guard");

  // The keys the terminal picker answers to.
  const keys = CLIENT_JS.slice(CLIENT_JS.indexOf("box.onkeydown"), CLIENT_JS.indexOf('case "prompt":'));
  assert.match(keys, /ArrowDown/, "down moves");
  assert.match(keys, /ArrowUp/, "up moves");
  assert.match(keys, /key === "Tab"/, "tab moves too");
  assert.match(keys, /key === "Enter"/, "enter selects");
  assert.match(keys, /key === "Escape"/, "escape cancels");
  assert.match(keys, /key === "Backspace"/, "backspace edits the filter");
  assert.match(keys, /key\.length === 1/, "typing filters");
  // Wrap-around at both ends, as keySelect does in the TUI.
  assert.match(keys, /\(box\._sel\.idx \+ 1\) % vis\.length/, "down wraps");
  assert.match(keys, /\(box\._sel\.idx - 1 \+ vis\.length\) % vis\.length/, "up wraps");

  // Enter and Escape must not reach the page-level handlers: Enter would send a
  // message from the composer, Escape would abort the whole turn.
  const enter = keys.slice(keys.indexOf('key === "Enter"'), keys.indexOf('key === "Escape"'));
  assert.match(enter, /e\.preventDefault\(\)/, "enter is swallowed");
  assert.match(enter, /e\.stopPropagation\(\)/, "and does not reach the composer");
  const esc = keys.slice(keys.indexOf('key === "Escape"'), keys.indexOf('key === "Backspace"'));
  assert.match(esc, /e\.stopPropagation\(\)/, "escape does not abort the turn");
  assert.match(esc, /answer\(null\)/, "escape cancels the picker");

  // The index sent must be the option's own, not its position in the filtered
  // list — that is how a wrong index gets chosen after typing a filter.
  assert.match(sel, /rows\.push\(\{ row: row, btn: b, o: o, i: i \}\)/, "each row remembers its real index");
  assert.match(keys, /const cur = vis\[box\._sel\.idx\];\s*\n\s*answer\(cur \? cur\.i : null\)/, "enter sends the row's own index");
  assert.match(sel, /o\.label\.toLowerCase\(\)\.includes\(f\)/, "the filter matches labels");

  // A stale cursor class on a hidden row is what the user sees after clearing
  // a filter, so every row is cleared before one is marked.
  const paint = CLIENT_JS.slice(CLIENT_JS.indexOf("const paint = ()"), CLIENT_JS.indexOf("box.onkeydown"));
  assert.match(paint, /rows\.forEach\(\(r\) => r\.btn\.classList\.remove\("cursor"\)\)/, "the cursor is cleared everywhere first");
  assert.match(paint, /r\.row\.hidden = vis\.indexOf\(r\) < 0/, "non-matching rows are hidden");
  assert.match(paint, /none\.hidden = vis\.length > 0/, "an empty result says so");

  // Mouse stays: the keyboard is an addition.
  assert.match(sel, /b\.onclick = \(\) => answer\(i\)/, "clicking an option still answers");
  assert.match(sel, /cancel\.onclick = \(\) => answer\(null\)/, "and the cancel button still cancels");

  const { STYLES } = require("../dist/web/styles");
  assert.match(STYLES, /\.ask \.opt\.cursor \{/, "the cursor row is styled");
  assert.match(STYLES, /\.ask \.askrow\[hidden\] \{ display: none; \}/, "a hidden row leaves the layout");
});

test("web: the terminal picker and the web picker answer the same keys", () => {
  // The two UIs share one SessionUI contract, so a key one of them supports and
  // the other does not is a defect the user feels as "the web UI is worse".
  const fs2 = require("fs");
  const tui = fs2.readFileSync(path.join(__dirname, "..", "src", "tui", "tui.ts"), "utf8");
  const keySelect = tui.slice(tui.indexOf("private keySelect"), tui.indexOf("private endSelect"));
  for (const [name, re] of [
    ["up", /case "up"/],
    ["down", /case "down"/],
    ["tab", /case "tab"/],
    ["enter", /case "enter"/],
    ["escape", /case "esc"/],
    ["filter text", /case "text"/],
    ["backspace", /case "backspace"/],
  ]) {
    assert.match(keySelect, re, `the terminal picker handles ${name}`);
  }
  assert.match(keySelect, /\(s\.index - 1 \+ filtered\.length\) % filtered\.length/, "and wraps at the top");
  assert.match(keySelect, /s\.options\.indexOf\(/, "and sends the option's real index, not the filtered position");
});

test("web: the sidebar tab switch matches .side-tab and hides the other panel", () => {
  // Regression: the click handler looked for ".tab" while the page ships
  // ".side-tab", so the tabs did nothing and both panels stayed visible —
  // the file tree appeared stacked under the session list.
  assert.ok(!/closest\("\.tab"\)/.test(CLIENT_JS), "no stale .tab selector");
  assert.ok(!/querySelectorAll\("\.tab\.on"\)/.test(CLIENT_JS), "no stale .tab.on selector");
  assert.match(CLIENT_JS, /closest\("\.side-tab"\)/, "the tab click is bound to .side-tab");
  const { STYLES } = require("../dist/web/styles");
  assert.match(STYLES, /\.side-panel:not\(\.on\)\s*\{\s*display:\s*none/, "the inactive panel is hidden");
  // The panels are toggled through the .on class the page already ships.
  assert.match(CLIENT_JS, /\$\("sessions-panel"\)\.classList\.toggle\("on"/);
  assert.match(CLIENT_JS, /\$\("tree-panel"\)\.classList\.toggle\("on"/);
});

test("web: workspace session lists collapse per workspace", () => {
  // Each workspace box can be folded so its sessions leave the list. The
  // state is keyed by workspace path, so one workspace stays open while
  // another is folded, and it survives the periodic sidebar re-render.
  assert.match(CLIENT_JS, /smol\.ws\.collapsed/, "the collapsed state is persisted");
  assert.match(CLIENT_JS, /function isWsCollapsed\(p\)/, "one place reads the state");
  assert.match(CLIENT_JS, /function setWsCollapsed\(p, c\)/, "one place writes the state");
  const side = CLIENT_JS.slice(CLIENT_JS.indexOf("function renderSidebar"), CLIENT_JS.indexOf("function removeWorkspace"));
  assert.match(side, /isWsCollapsed\(w\.path\)/, "collapsed by workspace path, not by session");
  assert.match(side, /"ws" \+ \(collapsed \? " collapsed" : ""\)/, "the box carries the collapsed class");
  assert.match(side, /ws-toggle/, "a chevron toggles the workspace");
  assert.match(side, /setWsCollapsed\(w\.path, !isWsCollapsed\(w\.path\)\)/, "toggling flips only that workspace");
  assert.match(side, /renderSidebar\(\)/, "the list re-renders after toggling");
  assert.match(side, /stopPropagation\(\)/, "the toggle does not start a session or remove the workspace");
  assert.match(side, /aria-expanded/, "the chevron is exposed to assistive tech");
  const { STYLES } = require("../dist/web/styles");
  assert.match(STYLES, /\.ws\.collapsed \.sessions \{[^}]*display: none/, "a collapsed workspace hides its sessions");
  assert.match(STYLES, /\.wshdr \.ws-toggle \{[^}]*visibility: visible/, "the chevron is always visible, unlike the hover-only actions");
  assert.match(STYLES, /\.wshdr \.ws-toggle \{[^}]*font-size: 16px/, "the chevron is large enough to hit");
});

test("web: the file tree is fetched over GET and rendered as a nested tree", () => {
  // Regression: the tree was loaded with post(), but the hub only serves
  // GET /fs/tree — the sidebar stayed empty no matter what.
  assert.ok(!/post\("\/fs\/tree"/.test(CLIENT_JS), "the tree is not POSTed");
  assert.match(CLIENT_JS, /fetch\("\/fs\/tree\?k=" \+ k \+ "&sid="/, "the tree is fetched with the auth token");
  // Regression: the old renderer flattened every directory into one fragment
  // and attached an empty child container, so nothing ever nested.
  assert.match(CLIENT_JS, /function fillTree\(host, x\)/, "children are rendered into their parent's body");
  assert.match(CLIENT_JS, /body\.hidden = true/, "directories start collapsed");
  // A session switch must not keep showing the previous session's workspace.
  const show = CLIENT_JS.slice(CLIENT_JS.indexOf("function show(sid)"), CLIENT_JS.indexOf("function newSession"));
  assert.match(show, /loadTree\(\)/, "switching sessions refreshes the tree");
});

test("web: the file tree never depends on state.workspace to find the folder", () => {
  // Regression: the workspace was read from state.workspace, which the server
  // only sends once the model has started. Until then (or if the backend
  // failed) the Files tab said "This session has no workspace folder" even
  // though the session does have one. The hub snapshot has it from frame one.
  const fn = CLIENT_JS.slice(CLIENT_JS.indexOf("function currentWorkspace"), CLIENT_JS.indexOf("function switchTab"));
  assert.match(fn, /sessInfo\.get\(sid\)/, "reads the workspace from the hub snapshot");
  const tree = fn + CLIENT_JS.slice(CLIENT_JS.indexOf("function loadTree"), CLIENT_JS.indexOf("function renderTreeMessage"));
  assert.ok(
    !/if \(!ws\) \{ renderTreeMessage/.test(tree),
    "the fetch is not gated on having a workspace (the server resolves it from the sid)"
  );
  // The folder picker had the same latent bug.
  assert.ok(!/active && active\.state\.workspace/.test(CLIENT_JS.replace(fn, "")), "no bare state.workspace read left");
});

test("web: the relative path the composer gets is derived from the server's root", () => {
  // The server resolves "~" and normalises the path, so the client must strip
  // the root the response carried rather than re-deriving one.
  assert.match(CLIENT_JS, /treeRoot = x\.path \|\| ""/, "the rendered root is remembered");
  assert.match(CLIENT_JS, /function relOf\(p\)/, "one place turns an absolute path into a workspace-relative one");
  assert.match(CLIENT_JS, /const root = treeRoot \|\| currentWorkspace\(\)/);
  const ins = CLIENT_JS.slice(CLIENT_JS.indexOf("function insertFile"));
  assert.match(ins, /const rel = relOf\(p\)/, "insertFile goes through relOf");
});

// ---- channel -----------------------------------------------------------------

function makeChannel(id = "s1") {
  const sent = [];
  const changes = [];
  const ch = new SessionChannel(id, { send: (ev) => sent.push(ev), changed: () => changes.push(ch.phase), touched() {} });
  return { ch, sent, changes };
}

test("channel: a message resolves readInput, is echoed with the session id, and titles the session", async () => {
  const { ch, sent } = makeChannel();
  const p = ch.readInput();
  assert.equal(ch.phase, "idle");
  ch.handleMessage("  build the game  ");
  assert.equal(await p, "build the game");
  assert.equal(ch.phase, "busy");
  assert.equal(ch.title, "build the game");
  const user = sent.find((e) => e.t === "user");
  assert.deepEqual({ t: user.t, s: user.s, sid: user.sid }, { t: "user", s: "build the game", sid: "s1" });
  assert.ok(ch.replay.some((e) => e.t === "user"), "user events are replayed");
  assert.ok(!ch.replay.some((e) => e.t === "state"), "state events are not replayed");
});

test("channel: a repeated slash command is dropped while the first is queued or running", async () => {
  // Regression: /models and /effort take seconds to open their picker (the
  // backends are probed first), so clicking twice queued the command twice.
  // The second copy opened its picker right after the first was answered, so
  // the options never seemed to go away.
  const { ch, sent } = makeChannel();
  const p = ch.readInput();
  ch.handleMessage("/models");
  ch.handleMessage("/models");
  ch.handleMessage("/effort");
  ch.handleMessage("build the thing");
  assert.equal(await p, "/models");
  assert.equal(await ch.readInput(), "/effort", "a different command still queues");
  assert.equal(await ch.readInput(), "build the thing");

  // Same while the command is running with its picker open.
  const { ch: c2, sent: sent2 } = makeChannel("s2");
  const p2 = c2.readInput();
  c2.handleMessage("/models");
  assert.equal(await p2, "/models");
  const picker = c2.select("Select model", [{ label: "m1" }, { label: "m2" }]);
  c2.handleMessage("/Models"); // same command, different case
  c2.handleAnswer(sent2.filter((e) => e.t === "select").pop().id, 1);
  assert.equal(await picker, 1);
  c2.refresh(); // the session loop ends the command here
  c2.handleMessage("next");
  assert.equal(await c2.readInput(), "next", "the duplicate never reached the queue");

  // Once the command is over the same one is welcome again.
  c2.handleMessage("/models");
  assert.equal(await c2.readInput(), "/models");
  assert.ok(sent.some((e) => e.t === "user" && e.s === "/models"), "the first copy is still echoed");
});

test("channel: messages sent while busy queue up and a slash command does not become the title", async () => {
  const { ch } = makeChannel();
  ch.handleMessage("/models");
  ch.handleMessage("second");
  assert.equal(await ch.readInput(), "/models");
  assert.equal(ch.title, "");
  assert.equal(await ch.readInput(), "second");
  assert.equal(ch.title, "second");
});

test("channel: approvals flip the phase to waiting and resolve through handleAnswer", async () => {
  const { ch, sent } = makeChannel();
  const p = ch.confirmCommand("rm -rf /tmp/x", "reaches outside the workspace");
  assert.equal(ch.phase, "waiting");
  const ask = sent.find((e) => e.t === "confirm");
  ch.handleAnswer(ask.id, "always");
  assert.equal(await p, "always");
  assert.equal(ch.phase, "busy");
  assert.ok(sent.some((e) => e.t === "answered" && e.id === ask.id), "the settled prompt is recorded for replay");
  assert.ok(ch.replay.some((e) => e.t === "line" && /always allow — rm -rf \/tmp\/x/.test(e.s)), "and so is the answer");
  const sel = ch.select("Pick", [{ label: "a" }, { label: "b" }]);
  ch.handleAnswer(sent.find((e) => e.t === "select").id, 1);
  assert.equal(await sel, 1);
});

test("channel: a text prompt resolves with the typed line, null when empty or cancelled, and is not replayed live", async () => {
  const { ch, sent } = makeChannel();
  const p = ch.prompt("Address of the machine", "192.168.1.50");
  assert.equal(ch.phase, "waiting");
  const ask = sent.find((e) => e.t === "prompt");
  assert.deepEqual({ title: ask.title, placeholder: ask.placeholder }, { title: "Address of the machine", placeholder: "192.168.1.50" });
  ch.handleAnswer(ask.id, "  gpu-box.local ");
  assert.equal(await p, "gpu-box.local");
  assert.ok(ch.replay.some((e) => e.t === "line" && e.s === "Address of the machine: gpu-box.local"), "the answer is kept in the transcript");

  const empty = ch.prompt("Name");
  ch.handleAnswer(sent.filter((e) => e.t === "prompt")[1].id, "   ");
  assert.equal(await empty, null);
  const open = ch.prompt("Name");
  ch.cancel();
  assert.equal(await open, null);

  const { ch: restored } = makeChannel("s2");
  restored.restoreReplay(ch.replay);
  assert.ok(!restored.replay.some((e) => e.t === "prompt"), "a saved session does not come back with a live text box");
});

test("channel: cancel answers an open prompt with no/null before aborting the turn", async () => {
  const { ch } = makeChannel();
  let cancelled = 0;
  ch.onCancel = () => cancelled++;
  const conf = ch.confirmCommand("npm i -g x");
  const sel = ch.select("Pick", [{ label: "a" }]);
  ch.cancel();
  assert.equal(await conf, "no");
  assert.equal(await sel, null);
  assert.equal(cancelled, 1);
});

test("channel: requestExit hands the loop /exit silently, now and on later reads", async () => {
  const { ch, sent } = makeChannel();
  const p = ch.readInput();
  ch.requestExit();
  assert.equal(await p, "/exit");
  assert.equal(await ch.readInput(), "/exit");
  assert.ok(!sent.some((e) => e.t === "user"), "no user echo for the synthetic /exit");
});

test("channel: the state event carries the busy label so a reconnecting page restores its spinner", () => {
  const { ch } = makeChannel();
  ch.getState = () => ({ mode: "edit" });
  ch.startSpinner("thinking");
  assert.deepEqual(ch.stateEvent().s, { mode: "edit", busy: "thinking", title: "" });
  ch.stopSpinner();
  assert.equal(ch.stateEvent().s.busy, null);
});

// ---- stores ------------------------------------------------------------------

test("store: session meta/body round trip, listing and delete", async () => {
  const dir = tmpdir("smol-store-");
  const store = new SessionStore(dir);
  const meta = { id: "ab12", workspace: dir, title: "hello", createdAt: 1, updatedAt: 2, model: "m", backend: "ollama" };
  store.saveMeta(meta);
  await store.saveBody("ab12", { snapshot: { messages: [{ role: "user", content: "hi" }], plan: [] }, events: [{ t: "user", s: "hi" }] });
  assert.deepEqual(store.listMetas(), [meta]);
  const body = store.loadBody("ab12");
  assert.equal(body.snapshot.messages[0].content, "hi");
  assert.equal(body.events.length, 1);
  assert.equal(store.loadBody("nope"), null);
  fs.writeFileSync(path.join(dir, "sessions", "broken.meta.json"), "{not json");
  assert.equal(store.listMetas().length, 1, "broken files are skipped");
  store.delete("ab12");
  assert.equal(store.listMetas().length, 0);
  assert.equal(store.loadBody("ab12"), null);
});

test("store: workspaces dedupe by normalized path and survive a reload", () => {
  const dir = tmpdir("smol-ws-");
  const ws = new WorkspaceStore(dir);
  const p = path.join(dir, "proj");
  fs.mkdirSync(p);
  ws.add(p + path.sep);
  ws.add(p);
  assert.equal(ws.list().length, 1);
  assert.ok(ws.has(p));
  assert.equal(workspaceKey(p + path.sep), workspaceKey(p));
  const again = new WorkspaceStore(dir);
  assert.equal(again.list().length, 1);
  again.remove(p);
  assert.equal(again.list().length, 0);
});

// ---- folder picker -----------------------------------------------------------

test("browseDir lists subfolders, flags projects, hides dot folders and reports errors", () => {
  const dir = tmpdir("smol-fs-");
  fs.mkdirSync(path.join(dir, "app"));
  fs.writeFileSync(path.join(dir, "app", "package.json"), "{}");
  fs.mkdirSync(path.join(dir, "notes"));
  fs.mkdirSync(path.join(dir, ".hidden"));
  fs.writeFileSync(path.join(dir, "file.txt"), "x");
  const d = browseDir(dir);
  assert.equal(d.error, undefined);
  assert.deepEqual(d.dirs.map((x) => [x.name, x.project]), [["app", true], ["notes", false]]);
  assert.equal(d.parent, path.dirname(dir));
  assert.ok(Array.isArray(d.roots) && d.roots.length > 0);
  assert.match(browseDir(path.join(dir, "missing")).error, /not a folder/);
  assert.match(browseDir(path.join(dir, "file.txt")).error, /not a folder/);
  assert.equal(browseDir("").path, os.homedir());
});

// ---- terminal ----------------------------------------------------------------

test("terminal helpers: control sequences are stripped but colors kept; msys paths map back", () => {
  assert.equal(stripControl("\x1b[32mok\x1b[0m \x1b[2J\x1b[H\x1b]0;title\x07x"), "\x1b[32mok\x1b[0m x");
  if (process.platform === "win32") assert.equal(toOsPath("/c/Projects/x"), "C:\\Projects\\x");
  else assert.equal(toOsPath("/home/x"), "/home/x");
});

test("terminal: input while busy answers a stdin prompt", async () => {
  const dir = fs.realpathSync(tmpdir("smol-term-in-"));
  let out = "";
  const plain = () => out.replace(/\x1b\[[0-9;]*m/g, "");
  const dones = [];
  const term = new Terminal("t-in", dir, { output: (s) => (out += s), done: (code, cwd) => dones.push({ code, cwd }) });
  if (/powershell|pwsh/i.test(term.shell.exe)) {
    term.close();
    return; // `read` is a posix builtin; sudo-style prompting is posix anyway
  }
  try {
    term.write("read -r line; echo PROMPT_GOT:$line");
    // `read` blocks on the pipe (no /dev/null redirect); the next input
    // answers it instead of starting a new command.
    await new Promise((r) => setTimeout(r, 800));
    term.input("hello-prompt-answer");
    await until(() => plain().includes("PROMPT_GOT:hello-prompt-answer"), 15000, "prompt answered");
  } finally {
    term.close();
  }
});

test("terminal: hidden input is masked in the stream", async () => {
  const dir = fs.realpathSync(tmpdir("smol-term-mask-"));
  let out = "";
  const plain = () => out.replace(/\x1b\[[0-9;]*m/g, "");
  const term = new Terminal("t-mask", dir, { output: (s) => (out += s), done: () => {} });
  try {
    term.write("sleep 8");
    await until(() => plain().includes("❯ sleep 8"), 15000, "command echo");
    term.input(":", true);
    await until(() => plain().includes("•"), 15000, "masked echo");
    assert.ok(!plain().includes("❯ :"), "the real text never appears, not even as an echo");
  } finally {
    term.interrupt();
    term.close();
  }
});

test("terminal: input while idle runs a command", async () => {
  const dir = fs.realpathSync(tmpdir("smol-term-idle-"));
  let out = "";
  const dones = [];
  const term = new Terminal("t-idle", dir, { output: (s) => (out += s), done: (code, cwd) => dones.push({ code, cwd }) });
  try {
    term.input("echo IDLE_MARKER");
    await until(() => dones.length >= 1, 15000, "idle input runs");
    assert.match(out, /IDLE_MARKER/);
  } finally {
    term.close();
  }
});

test("terminal: runs commands in a persistent shell, reports exit codes and tracks cwd", async () => {
  const dir = fs.realpathSync(tmpdir("smol-term-"));
  fs.mkdirSync(path.join(dir, "sub"));
  let out = "";
  const dones = [];
  const term = new Terminal("t1", dir, { output: (s) => (out += s), done: (code, cwd) => dones.push({ code, cwd }) });
  try {
    term.write("echo hello-from-shell");
    await until(() => dones.length >= 1, 15000, "first command");
    assert.equal(dones[0].code, 0);
    assert.match(out, /hello-from-shell/);
    assert.match(out.replace(/\x1b\[[0-9;]*m/g, ""), /❯ echo hello-from-shell\n/, "the command is echoed into the stream");
    term.write("cd sub");
    await until(() => dones.length >= 2, 15000, "cd");
    assert.equal(path.basename(dones[1].cwd), "sub");
    assert.equal(path.basename(term.cwd), "sub");
    term.write("exit 3");
    await until(() => /starting a new one/.test(out), 15000, "respawn after exit");
    term.write("echo again");
    await until(() => /again\n/.test(out) || dones.length >= 3, 15000, "command after respawn");
    assert.ok(term.buffer.includes("hello-from-shell"), "the replay buffer keeps output");
  } finally {
    term.close();
  }
});

// ---- hub -------------------------------------------------------------------------

/** A stand-in for Session: echoes each input back, honours /exit. */
function fakeFactory(log) {
  return async (ui, workspace, prefs) => {
    log.push({ workspace, prefs });
    const session = {
      chosen: { id: "fake-model", backend: "ollama" },
      workspace,
      onExit: null,
      restored: null,
      taskManager: { killAll() {}, runningSummary: () => [], recentUrls: () => ["http://localhost:5173"] },
      state: () => ({ mode: prefs.mode || "edit", model: "fake-model", backend: "ollama", workspace, urls: ["http://localhost:5173"], commands: [] }),
      announce() { ui.status("· fake session ready"); },
      restore(s) { session.restored = s; },
      snapshot: () => ({ messages: [{ role: "user", content: "x" }], plan: [], filesTouched: [], commandsRun: [], originalRequest: "x", currentRequest: "x", mode: "edit", effort: null, model: "fake-model", backend: "ollama" }),
      // The "model" takes a moment to name the session, like a real one.
      async suggestTitle() { await sleep(300); return "Hello Session"; },
      async run() {
        for (;;) {
          const input = await ui.readInput();
          if (input === "/exit") { ui.close(); session.onExit && session.onExit(); return; }
          ui.startSpinner("thinking");
          ui.token("echo: " + input);
          ui.stopSpinner();
          ui.turnEnd("done");
          if (session.onTurnDone) session.onTurnDone();
        }
      },
    };
    return session;
  };
}

function request(hub, method, p, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: hub.port, method, path: p, headers: { "content-type": "application/json" } },
      (res) => {
        let data = "";
        res.on("data", (d) => (data += d));
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      }
    );
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

/** Read SSE events from /events until one satisfies `stopWhen` (or 3s pass). */
function readEvents(hub, stopWhen) {
  return new Promise((resolve, reject) => {
    const events = [];
    const req = http.get({ host: "127.0.0.1", port: hub.port, path: "/events?k=" + hub.authToken }, (res) => {
      let buf = "";
      const finish = () => { req.destroy(); resolve(events); };
      const timer = setTimeout(finish, 3000);
      res.on("data", (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
          if (chunk.startsWith("data: ")) events.push(JSON.parse(chunk.slice(6)));
        }
        if (events.some(stopWhen)) { clearTimeout(timer); finish(); }
      });
    });
    req.on("error", (e) => (e.code === "ECONNRESET" ? resolve(events) : reject(e)));
  });
}

test("hub: token guard, page, ping, folder listing, and the running-hub record", async () => {
  const dataDir = tmpdir("smol-hub-");
  const hub = new WebHub({ port: 0, prefs: {}, help: "help", version: "9.9.9", dataDir, factory: fakeFactory([]), quiet: true });
  await hub.start();
  try {
    assert.equal((await request(hub, "GET", "/")).status, 403);
    assert.equal((await request(hub, "GET", "/?k=wrong")).status, 403);
    const page = await request(hub, "GET", "/?k=" + hub.authToken);
    assert.equal(page.status, 200);
    assert.match(page.body, /id="side"/);
    assert.match(page.body, /id="panel"/);
    const ping = JSON.parse((await request(hub, "GET", "/ping?k=" + hub.authToken)).body);
    assert.equal(ping.ok, true);
    const rec = readHubRecord(dataDir);
    assert.equal(rec.port, hub.port);
    assert.equal(rec.token, hub.authToken);
    const fsr = JSON.parse((await request(hub, "GET", "/fs?k=" + hub.authToken + "&path=" + encodeURIComponent(dataDir))).body);
    assert.deepEqual(fsr.dirs.map((d) => d.name), ["sessions"]);
    const bad = await request(hub, "POST", "/nope?k=" + hub.authToken, {});
    assert.equal(bad.status, 400);
  } finally {
    hub.close();
  }
  assert.equal(readHubRecord(dataDir), null, "the record is removed on shutdown");
});

test("hub: /fs/tree returns the workspace directory tree for a session", async () => {
  const dataDir = tmpdir("smol-hub-tree-");
  const ws = path.join(dataDir, "proj");
  fs.mkdirSync(ws);
  fs.mkdirSync(path.join(ws, "app"));
  fs.writeFileSync(path.join(ws, "app", "package.json"), "{}");
  fs.mkdirSync(path.join(ws, "notes"));
  fs.mkdirSync(path.join(ws, ".github"), { recursive: true });
  fs.writeFileSync(path.join(ws, ".github", "workflow.yml"), "on: push");
  fs.mkdirSync(path.join(ws, ".git"));
  fs.writeFileSync(path.join(ws, ".git", "HEAD"), "ref");
  fs.writeFileSync(path.join(ws, ".gitignore"), "*.log");
  fs.writeFileSync(path.join(ws, ".env.example"), "KEY=");
  fs.writeFileSync(path.join(ws, ".DS_Store"), "junk");
  fs.mkdirSync(path.join(ws, "node_modules"), { recursive: true });
  fs.mkdirSync(path.join(ws, "node_modules", "left-pad"));
  fs.mkdirSync(path.join(ws, "dist"));
  fs.writeFileSync(path.join(ws, "file.txt"), "x");
  const hub = new WebHub({ port: 0, prefs: {}, help: "help", version: "9.9.9", dataDir, factory: fakeFactory([]), quiet: true });
  await hub.start();
  const k = "?k=" + hub.authToken;
  try {
    const { id } = JSON.parse((await request(hub, "POST", "/sessions/new" + k, { workspace: ws })).body);
    const res = await request(hub, "GET", "/fs/tree" + k + "&sid=" + id);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    const t = body.tree;
    assert.equal(t.name, "proj");
    assert.deepEqual(t.files.sort(), [".env.example", ".gitignore", "file.txt"], "dot files are listed");
    const childNames = t.children.map((c) => c.name).sort();
    assert.deepEqual(childNames, [".github", "app", "notes"], "dot folders are listed too");
    const app = t.children.find((c) => c.name === "app");
    assert.deepEqual(app.files, ["package.json"]);
    assert.equal(app.children.length, 0);
    assert.equal(t.children.find((c) => c.name === ".git"), undefined, ".git stays hidden (history is not project files)");
    assert.equal(t.files.includes(".DS_Store"), false, ".DS_Store stays hidden");
    assert.equal(t.children.find((c) => c.name === "node_modules"), undefined, "node_modules is skipped");
    assert.equal(t.children.find((c) => c.name === "dist"), undefined, "build output is skipped");
    const bad = await request(hub, "GET", "/fs/tree" + k + "&sid=zzz");
    assert.equal(JSON.parse(bad.body).tree, null, "unknown session yields no tree");
  } finally {
    hub.close();
  }
});

test("readFsFile: returns text, and refuses anything outside the workspace", () => {
  const dataDir = tmpdir("smol-read-");
  const ws = path.join(dataDir, "proj");
  fs.mkdirSync(path.join(ws, "src"), { recursive: true });
  fs.writeFileSync(path.join(ws, "src", "a.ts"), "export const a = 1;\n");
  fs.writeFileSync(path.join(ws, "secret.txt"), "do not read me");
  fs.writeFileSync(path.join(dataDir, "outside.txt"), "nope");
  fs.symlinkSync(path.join(dataDir, "outside.txt"), path.join(ws, "link.txt"));

  const ok = readFsFile(ws, "src/a.ts");
  assert.equal(ok.ok, undefined, "a successful read carries no error");
  assert.equal(ok.content, "export const a = 1;\n");
  assert.equal(ok.rel, "src/a.ts", "rel is workspace-relative with forward slashes");
  assert.equal(ok.binary, false);
  assert.equal(ok.truncated, false);
  assert.ok(ok.mtimeMs > 0, "mtimeMs comes from disk so the editor can detect a later change");

  assert.equal(readFsFile(ws, "../outside.txt").forbidden, true, "climbing out is refused");
  assert.equal(readFsFile(ws, "/etc/passwd").forbidden, true, "an absolute path elsewhere is refused");
  assert.equal(readFsFile(ws, "link.txt").forbidden, true, "a symlink pointing out is refused");
  assert.equal(readFsFile(ws, "src").badTarget, true, "a folder is not a file");
  assert.equal(readFsFile(ws, "gone.txt").notFound, true, "a missing file is reported, not thrown");
  assert.equal(readFsFile(ws, "").forbidden, true, "an empty path is refused");

  // Binary is decided by content, not by the extension: a NUL byte means no
  // preview, and a .ts file full of escapes must still read as text.
  fs.writeFileSync(path.join(ws, "blob.bin"), Buffer.from([0x89, 0x50, 0x00, 0x01]));
  const bin = readFsFile(ws, "blob.bin");
  assert.equal(bin.binary, true);
  assert.equal(bin.content, undefined, "binary content is not sent to the browser");
  fs.writeFileSync(path.join(ws, "esc.ts"), "const s = \"a\\u0000b\";\n");
  assert.equal(readFsFile(ws, "esc.ts").binary, false, "an escaped NUL in source is still text");

  // Over the cap the tab gets a truncated head plus the size it is missing.
  fs.writeFileSync(path.join(ws, "big.txt"), "x".repeat(5000));
  const cut = readFsFile(ws, "big.txt", 1000);
  assert.equal(cut.truncated, true);
  assert.equal(cut.content.length, 1000);
  assert.equal(cut.truncatedBytes, 4000);
  assert.equal(cut.size, 5000, "the real size is still reported");

  const empty = readFsFile(ws, "src/a.ts", 0);
  assert.equal(empty.content, "", "a zero cap yields an empty head, not a crash");
});

test("writeFsFile: writes atomically and refuses to clobber a newer file", () => {
  const dataDir = tmpdir("smol-write-");
  const ws = path.join(dataDir, "proj");
  fs.mkdirSync(ws);
  fs.writeFileSync(path.join(ws, "a.txt"), "one");
  fs.writeFileSync(path.join(dataDir, "outside.txt"), "nope");

  const first = writeFsFile(ws, "a.txt", "two");
  assert.equal(first.ok, true);
  assert.equal(first.rel, "a.txt");
  assert.equal(fs.readFileSync(path.join(ws, "a.txt"), "utf8"), "two");
  // The temp file the atomic write used must not be left behind.
  assert.deepEqual(fs.readdirSync(ws), ["a.txt"]);

  // Same mtime we were handed: the write goes through.
  const again = writeFsFile(ws, "a.txt", "three", first.mtimeMs);
  assert.equal(again.ok, true);
  assert.equal(fs.readFileSync(path.join(ws, "a.txt"), "utf8"), "three");

  // A different mtime means something else touched it: refuse, and hand back
  // what is actually on disk so the user can choose. Age the file explicitly —
  // two writes a millisecond apart are not a reliable conflict.
  fs.writeFileSync(path.join(ws, "a.txt"), "theirs");
  const old = Date.now() / 1000 - 60;
  fs.utimesSync(path.join(ws, "a.txt"), old, old);
  const onDisk = fs.statSync(path.join(ws, "a.txt")).mtimeMs;
  const stale = writeFsFile(ws, "a.txt", "mine", onDisk - 5000);
  assert.equal(stale.conflict, true);
  assert.equal(stale.serverContent, "theirs");
  assert.equal(fs.readFileSync(path.join(ws, "a.txt"), "utf8"), "theirs", "a conflict writes nothing");
  // Forcing it is an explicit choice, and then it lands.
  assert.equal(writeFsFile(ws, "a.txt", "mine", null).ok, true, "no mtime means no conflict check");
  assert.equal(fs.readFileSync(path.join(ws, "a.txt"), "utf8"), "mine");

  assert.equal(writeFsFile(ws, "../outside.txt", "x").forbidden, true, "climbing out is refused");
  assert.equal(fs.readFileSync(path.join(dataDir, "outside.txt"), "utf8"), "nope", "the outside file is untouched");
  assert.equal(writeFsFile(ws, "a.txt", 123).badTarget, true, "content must be a string");
  assert.equal(writeFsFile(ws, "", "x").forbidden, true, "an empty path is refused");

  const made = writeFsFile(ws, "deep/new/file.txt", "hi");
  assert.equal(made.ok, true, "writing into a new folder creates it");
  assert.equal(fs.readFileSync(path.join(ws, "deep", "new", "file.txt"), "utf8"), "hi");
});

test("hub: /fs/file reads and saves, and answers 403/404/409 with reasons", async () => {
  const dataDir = tmpdir("smol-hub-file-");
  const ws = path.join(dataDir, "proj");
  fs.mkdirSync(ws);
  fs.writeFileSync(path.join(ws, "a.txt"), "one");
  fs.writeFileSync(path.join(dataDir, "outside.txt"), "nope");
  const hub = new WebHub({ port: 0, prefs: {}, help: "help", version: "9.9.9", dataDir, factory: fakeFactory([]), quiet: true });
  await hub.start();
  const k = "?k=" + hub.authToken;
  try {
    const { id } = JSON.parse((await request(hub, "POST", "/sessions/new" + k, { workspace: ws })).body);
    const get = (p, sid = id) => request(hub, "GET", "/fs/file" + k + "&sid=" + sid + "&path=" + encodeURIComponent(p));

    const read = await get("a.txt");
    assert.equal(read.status, 200);
    const body = JSON.parse(read.body);
    assert.equal(body.content, "one");
    assert.equal(body.rel, "a.txt");

    assert.equal((await get("../outside.txt")).status, 403, "escaping the workspace is forbidden");
    assert.equal((await get("missing.txt")).status, 404, "a deleted file is not found, not empty");
    assert.equal((await get("a.txt", "zzz")).status, 403, "an unknown session gets no file");

    const saved = await request(hub, "POST", "/fs/file" + k, { sid: id, path: "a.txt", content: "two", mtimeMs: body.mtimeMs });
    assert.equal(saved.status, 200);
    const after = JSON.parse(saved.body);
    assert.equal(after.ok, true);
    assert.equal(fs.readFileSync(path.join(ws, "a.txt"), "utf8"), "two", "the file on disk really changed");

    const conflict = await request(hub, "POST", "/fs/file" + k, { sid: id, path: "a.txt", content: "clobber", mtimeMs: body.mtimeMs });
    assert.equal(conflict.status, 409, "a stale mtime is a conflict");
    assert.equal(JSON.parse(conflict.body).serverContent, "two", "the conflict carries the disk content");
    assert.equal(fs.readFileSync(path.join(ws, "a.txt"), "utf8"), "two", "a conflict writes nothing");

    const forced = await request(hub, "POST", "/fs/file" + k, { sid: id, path: "a.txt", content: "forced", mtimeMs: null });
    assert.equal(forced.status, 200, "an explicit overwrite is allowed");
    assert.equal(fs.readFileSync(path.join(ws, "a.txt"), "utf8"), "forced");

    assert.equal((await request(hub, "POST", "/fs/file" + k, { sid: id, path: "../outside.txt", content: "x" })).status, 403);
    assert.equal(fs.readFileSync(path.join(dataDir, "outside.txt"), "utf8"), "nope", "the outside file is untouched");
    assert.equal((await request(hub, "POST", "/fs/file" + k, { sid: "zzz", path: "a.txt", content: "x" })).status, 403);
  } finally {
    hub.close();
  }
});

test("hub: /fs/file refuses to save in a read-only session", async () => {
  const dataDir = tmpdir("smol-hub-ro-");
  const ws = path.join(dataDir, "proj");
  fs.mkdirSync(ws);
  fs.writeFileSync(path.join(ws, "a.txt"), "one");
  // A stand-in session that reports read-only, the way a real Session does.
  const factory = fakeFactory([]);
  const wrapped = async (ui, workspace, prefs) => {
    const s = await factory(ui, workspace, prefs);
    s.agent = { mode: "ro" };
    return s;
  };
  const hub = new WebHub({ port: 0, prefs: { mode: "ro" }, help: "help", version: "9.9.9", dataDir, factory: wrapped, quiet: true });
  await hub.start();
  const k = "?k=" + hub.authToken;
  try {
    const { id } = JSON.parse((await request(hub, "POST", "/sessions/new" + k, { workspace: ws })).body);
    // The mode is read off the live session, so wait until one is running.
    await until(() => hub.snapshot().workspaces[0].sessions[0].status === "idle", 2000, "idle session");
    const saved = await request(hub, "POST", "/fs/file" + k, { sid: id, path: "a.txt", content: "two" });
    assert.equal(saved.status, 403, "a read-only session cannot save");
    assert.equal(JSON.parse(saved.body).mode, "ro", "the response says why");
    assert.equal(fs.readFileSync(path.join(ws, "a.txt"), "utf8"), "one", "the file is untouched");
    // Reading is still allowed — read-only means read-only, not blind.
    const read = await request(hub, "GET", "/fs/file" + k + "&sid=" + id + "&path=" + encodeURIComponent("a.txt"));
    assert.equal(read.status, 200);
  } finally {
    hub.close();
  }
});

test("web: full-width panel takes the whole row instead of overlaying the chat", () => {
  // Regression: full width was position: absolute + width: var(--fw-panel) (the
  // width the panel already had, ~520px) with z-index 15, so it floated over the
  // chat and covered it while never being wider than half the screen. It also
  // hardcoded `inset: 48px 0 0`, which drifts from #top's real height.
  const { STYLES } = require("../dist/web/styles");
  const rules = STYLES.slice(STYLES.indexOf("body.panel-full"));
  assert.match(rules, /body\.panel-full #main \{ display: none; \}/, "the chat steps aside");
  assert.match(rules, /body\.panel-full #panel \{[^}]*flex: 1 1 auto;[^}]*width: auto !important;[^}]*max-width: none;/,
    "the panel grows in the normal flow — no overlay, no width cap");
  assert.match(rules, /body\.panel-full #panelgrip \{ display: none; \}/, "no dragging while full width");
  assert.ok(!/--fw-panel/.test(STYLES) && !/--fw-panel/.test(CLIENT_JS), "the capped-width variable is gone");
  // The narrow window still floats the panel, so full width has to be restated
  // for that layout or it would shrink back on a small screen.
  const narrowFull = STYLES.slice(STYLES.lastIndexOf("@media (max-width: 1000px)"));
  assert.match(narrowFull, /body\.panel-full #panel \{[^}]*width: 100% !important;/, "narrow windows keep full width too");
  // Toggling off restores the dragged width rather than the CSS default.
  assert.match(CLIENT_JS, /panelEl\.style\.width = v\.panelFull \? "" : pw \+ "px"/);
});

test("web: a file that cannot be opened never becomes a tab", () => {
  // A panel with nothing to show in it is noise now and a "why is this tab
  // here" question later, so the read happens before the tab is built.
  const open = CLIENT_JS.slice(CLIENT_JS.indexOf("function openFileTab"), CLIENT_JS.indexOf("// terminal tabs"));
  const problemIdx = open.indexOf("fileOpenProblem(res)");
  const alertIdx = open.indexOf("alert(", problemIdx);
  const buildIdx = open.indexOf("buildFileTab(v, t)");
  const tail = open.slice(alertIdx, buildIdx);
  assert.ok(problemIdx > 0 && alertIdx > 0 && buildIdx > 0, "openFileTab reads, alerts and builds");
  assert.ok(problemIdx < alertIdx && alertIdx < buildIdx, "the warning comes before the tab exists");
  assert.match(tail, /return;/, "and it returns without building the tab — no empty panel is left behind");

  // Every way a read can fail has to be named, not swallowed.
  const problem = CLIENT_JS.slice(CLIENT_JS.indexOf("function fileOpenProblem"), CLIENT_JS.indexOf("function applyFileBody"));
  for (const [code, why] of [[404, "no such file"], [403, "outside the workspace"], [400, "not a file"], ["binary", "binary file"]])
    assert.ok(problem.includes(String(code)) || problem.includes(why), why + " is reported, not silently ignored");

  // A tab that already exists must never be closed by a failed reload — it can
  // hold unsaved edits, and the user has to be able to copy them out.
  const reload = CLIENT_JS.slice(CLIENT_JS.indexOf("function loadFileInto"), CLIENT_JS.indexOf("function saveFileTab"));
  assert.ok(!/closeTab\(/.test(reload), "a failed reload reports in place instead of closing the tab");
  assert.match(reload, /Your text is still here but cannot be saved/, "and says the text is recoverable");
  // Restoring says which tabs it left out, once, instead of dropping them quietly.
  assert.match(CLIENT_JS, /function restoreFileTabs\(v, rels\)/);
  assert.match(CLIENT_JS, /These files could not be reopened/);
  // Saving a file bigger than the read cap would delete the rest of it.
  assert.match(CLIENT_JS, /if \(!force && t\.truncated && !confirm/, "a truncated save asks first");
});

test("web: nothing static lives inside #paneltabs, which renderPanel empties", () => {
  // Regression: #panelfull shipped as a child of #paneltabs, and renderPanel
  // starts with tabsEl.innerHTML = "". The first render destroyed the button and
  // every later render threw on `$("panelfull").classList` — so the panel died
  // after its first repaint (adding a second tab, switching sessions, ...).
  assert.match(CLIENT_JS, /tabsEl\.innerHTML = ""/, "renderPanel rebuilds the strip");
  const start = PAGE_HTML.indexOf('id="paneltabs">');
  assert.ok(start > 0, "the page has a #paneltabs");
  const strip = PAGE_HTML.slice(start + 'id="paneltabs">'.length, PAGE_HTML.indexOf("</div>", start));
  assert.equal(strip.trim(), "", `#paneltabs must be empty in the markup, found: ${strip}`);
  assert.ok(PAGE_HTML.includes('id="panelfull"'), "the full-width toggle still ships");
  const bar = PAGE_HTML.slice(PAGE_HTML.indexOf('id="panelbar"'), PAGE_HTML.indexOf('id="panelviews"'));
  assert.ok(bar.includes('id="panelfull"'), "it lives in the surrounding bar instead");
});

test("web: the editor tab is a textarea whose content never goes through innerHTML", () => {
  const tab = CLIENT_JS.slice(CLIENT_JS.indexOf("function buildFileTab"), CLIENT_JS.indexOf("function insertAtCursor"));
  assert.match(tab, /createElement\("textarea"\)/, "the editor is a plain textarea (no runtime dependency)");
  assert.ok(!/innerHTML/.test(tab), "nothing in the file tab is ever written as markup");
  const body = CLIENT_JS.slice(CLIENT_JS.indexOf("function applyFileBody"), CLIENT_JS.indexOf("function loadFileInto"));
  assert.match(body, /t\.ta\.value = b\.content/, "file bytes arrive as a textarea value");
  assert.ok(!/innerHTML/.test(body), "loading a file never builds markup out of it");

  // The tab header used to branch on browser-vs-everything; a file tab needs a
  // third case or it shows up labelled "terminal".
  assert.match(CLIENT_JS, /function tabLabel\(t\)/);
  assert.match(CLIENT_JS, /function tabIcon\(t\)/);
  const labels = CLIENT_JS.slice(CLIENT_JS.indexOf("function tabLabel"), CLIENT_JS.indexOf("function tabChanged"));
  for (const kind of ["browser", "term", "file"]) assert.ok(labels.includes('"' + kind + '"'), kind + " has its own label");

  // A failed save must never read as a successful one: post() answers {} when
  // the request did not land.
  const save = CLIENT_JS.slice(CLIENT_JS.indexOf("function saveFileTab"), CLIENT_JS.indexOf("function openFileTab"));
  assert.match(save, /if \(!r \|\| !r\.ok\)/, "only an explicit ok counts as saved");
  assert.match(save, /r\.conflict/, "a 409 asks before overwriting");
  assert.match(save, /saveFileTab\(v, t, true\)/, "and an explicit overwrite drops the mtime check");
  assert.match(CLIENT_JS, /e\.key\.toLowerCase\(\) === "s"/, "ctrl/cmd+s saves");
  // Read-only sessions get a view but not a way to write.
  assert.match(CLIENT_JS, /function applyFileMode\(v, t\)/);
  assert.match(CLIENT_JS, /t\.saveBtn\.disabled = ro/);
  assert.match(CLIENT_JS, /applyFileMode\(o, t\)/, "a /mode switch reaches every open file tab");

  // Unsaved changes are marked, and closing asks first.
  assert.match(CLIENT_JS, /function tabChanged\(t\)/);
  assert.match(CLIENT_JS, /dot-unsaved/);
  const close = CLIENT_JS.slice(CLIENT_JS.indexOf("function closeTab"), CLIENT_JS.indexOf("function togglePanelKind"));
  assert.match(close, /tabChanged\(t\) && !confirm/, "closing an edited file asks");
  // A tree click opens the file, like every other editor. Mentioning the path in
  // the composer is the secondary action and lives behind a hover button.
  const tree = CLIENT_JS.slice(CLIENT_JS.indexOf("function fillTree"), CLIENT_JS.indexOf("function setTreeExpanded"));
  assert.match(tree, /openFileTab\(active, rel\)/, "a plain click opens the file");
  assert.match(tree, /el\("button", "tri-mention"/, "mentioning the path is a visible affordance, not a hidden modifier");
  assert.match(tree, /if \(e\.altKey\) \{ insertFile\(p\)/, "alt-click still mentions, for the keyboard");
  // File tabs survive a reload, terminals do not (their pty belongs to the hub).
  const save1 = CLIENT_JS.slice(CLIENT_JS.indexOf("function savePanel"), CLIENT_JS.indexOf("function curTab"));
  assert.match(save1, /t\.kind === "browser" \|\| t\.kind === "file"/);
  assert.match(save1, /kind: "file", rel: t\.rel/);
});

test("web: file editor shows line numbers in a synced gutter", () => {
  // The editor stays a plain textarea (no runtime dependency), so the numbers
  // live in a separate gutter next to it rather than inside it.
  assert.match(CLIENT_JS, /function refreshGutter\(t\)/, "one place rebuilds the numbers");
  const gutter = CLIENT_JS.slice(CLIENT_JS.indexOf("function refreshGutter"), CLIENT_JS.indexOf("function readFile"));
  assert.match(gutter, /t\.gutter\.textContent/, "numbers are plain text, never markup");
  assert.ok(!/innerHTML/.test(gutter), "file content never becomes markup through the gutter");
  assert.match(gutter, /charCodeAt\(i\) === 10/, "lines are counted from newlines (wrap is off)");
  assert.match(gutter, /t\.gutter\.scrollTop = t\.ta\.scrollTop/, "scrolling the file scrolls the numbers");
  assert.match(gutter, /t\.missing \|\| t\.binary/, "a deleted or binary tab hides the gutter");
  assert.match(gutter, /t\._lines !== n/, "the gutter is only rebuilt when the line count changes");
  const build = CLIENT_JS.slice(CLIENT_JS.indexOf("function buildFileTab"), CLIENT_JS.indexOf("function insertAtCursor"));
  assert.match(build, /el\("div", "fwrap"\)/, "textarea and gutter share a row");
  assert.match(build, /el\("div", "gutter"/, "the gutter is built with the text-only helper");
  assert.match(build, /t\.gutter = gutter/, "the tab remembers its gutter");
  assert.match(build, /ta\.onscroll/, "a scroll hook keeps the two in sync");
  assert.match(build, /refreshGutter\(t\)/, "typing refreshes the numbers");
  const applied = CLIENT_JS.slice(CLIENT_JS.indexOf("function applyFileBody"), CLIENT_JS.indexOf("function loadFileInto"));
  assert.match(applied, /refreshGutter\(t\)/, "loading a file refreshes the numbers");
  const { STYLES } = require("../dist/web/styles");
  assert.match(STYLES, /\.tabbody\.file \.fwrap \{[^}]*display: flex/, "gutter and editor sit side by side");
  assert.match(STYLES, /\.tabbody\.file \.gutter \{[^}]*white-space: pre/, "each number keeps its own line");
  assert.match(STYLES, /\.tabbody\.file \.gutter \{[^}]*line-height: 1\.5/, "gutter rows use the editor's metrics");
  assert.match(STYLES, /\.tabbody\.file \.gutter \{[^}]*border-right/, "the gutter stays visually separate while scrolling sideways");
});

test("hub: /fs/file refuses a body too large to be a file save", async () => {
  const dataDir = tmpdir("smol-hub-big-");
  const ws = path.join(dataDir, "proj");
  fs.mkdirSync(ws);
  const hub = new WebHub({ port: 0, prefs: {}, help: "help", version: "9.9.9", dataDir, factory: fakeFactory([]), quiet: true });
  await hub.start();
  const k = "?k=" + hub.authToken;
  try {
    const { id } = JSON.parse((await request(hub, "POST", "/sessions/new" + k, { workspace: ws })).body);
    // A file the editor would actually offer still saves.
    const ok = await request(hub, "POST", "/fs/file" + k, { sid: id, path: "big.txt", content: "x".repeat(400 * 1024) });
    assert.equal(ok.status, 200, "a 400KB file is under the ceiling");
    // Past the ceiling the hub answers instead of dropping the connection, so
    // the browser can say why rather than reporting a mystery network error.
    const huge = await request(hub, "POST", "/fs/file" + k, { sid: id, path: "huge.txt", content: "x".repeat(5 * 1024 * 1024) });
    assert.equal(huge.status, 413);
    assert.match(JSON.parse(huge.body).error, /too large/);
    assert.equal(fs.existsSync(path.join(ws, "huge.txt")), false, "nothing was written");
  } finally {
    hub.close();
  }
});

test("hub: sessions start, echo, save, close, resume, delete; workspaces add and remove", async () => {
  const dataDir = tmpdir("smol-hub2-");
  const ws = path.join(dataDir, "proj");
  fs.mkdirSync(ws);
  const calls = [];
  const hub = new WebHub({ port: 0, prefs: { effort: "off" }, help: "help", version: "9.9.9", dataDir, factory: fakeFactory(calls), quiet: true });
  await hub.start();
  const k = "?k=" + hub.authToken;
  try {
    // add a workspace without starting anything
    const added = JSON.parse((await request(hub, "POST", "/workspaces/add" + k, { path: ws })).body);
    assert.equal(added.path, ws);
    assert.equal(added.id, undefined);
    let snap = hub.snapshot();
    assert.equal(snap.workspaces.length, 1);
    assert.equal(snap.workspaces[0].sessions.length, 0);
    assert.match((await request(hub, "POST", "/workspaces/add" + k, { path: path.join(dataDir, "missing") })).body, /not a folder/);

    // start a session and talk to it
    const { id } = JSON.parse((await request(hub, "POST", "/sessions/new" + k, { workspace: ws })).body);
    assert.ok(id);
    await until(() => calls.length === 1, 2000, "factory call");
    assert.equal(calls[0].prefs.effort, "off");
    await until(() => hub.snapshot().workspaces[0].sessions[0].status === "idle", 2000, "idle session");
    await request(hub, "POST", "/msg" + k, { sid: id, text: "hello there" });
    await until(() => hub.snapshot().workspaces[0].sessions[0].title === "hello there", 2000, "verbatim title");
    await until(() => hub.snapshot().workspaces[0].sessions[0].title === "Hello Session", 2000, "model-written title");
    const events = await readEvents(hub, (e) => e.t === "state" && e.sid === id);
    assert.equal(events[0].t, "hub");
    assert.ok(events.some((e) => e.t === "user" && e.sid === id && e.s === "hello there"), "replay includes the user message");
    assert.ok(events.some((e) => e.t === "token" && e.s === "echo: hello there"), "replay includes the reply");
    assert.ok(events.some((e) => e.t === "state" && e.sid === id && e.s.model === "fake-model"), "state follows the replay");

    // a terminal on the session shows up in the snapshot and is replayed to new pages
    const term = JSON.parse((await request(hub, "POST", "/term/open" + k, { sid: id })).body);
    assert.ok(term.tid);
    assert.equal(hub.snapshot().workspaces[0].sessions[0].terminals[0].tid, term.tid);
    await request(hub, "POST", "/term/close" + k, { sid: id, tid: term.tid });
    assert.equal(hub.snapshot().workspaces[0].sessions[0].terminals.length, 0);

    // saved to disk after the debounce
    const metaFile = path.join(dataDir, "sessions", id + ".meta.json");
    await until(() => fs.existsSync(metaFile) && fs.existsSync(path.join(dataDir, "sessions", id + ".json")), 4000, "save");
    assert.equal(JSON.parse(fs.readFileSync(metaFile, "utf8")).title, "Hello Session");

    // close: it stays listed as a stored session
    await request(hub, "POST", "/sessions/close" + k, { id });
    await until(() => hub.snapshot().workspaces[0].sessions[0].live === false, 2000, "closed");
    assert.equal(hub.snapshot().workspaces[0].sessions[0].status, "stored");

    // resume: the factory runs again with the saved prefs and the transcript is restored
    await request(hub, "POST", "/sessions/resume" + k, { id });
    await until(() => calls.length === 2, 2000, "second factory call");
    assert.equal(calls[1].prefs.model, "fake-model");
    await until(() => hub.snapshot().workspaces[0].sessions[0].status === "idle", 2000, "resumed idle");
    const events2 = await readEvents(hub, (e) => e.t === "state" && e.sid === id);
    assert.ok(events2.some((e) => e.t === "user" && e.s === "hello there"), "old transcript replays after resume");

    // rename, then delete while live: gone from disk and from the list
    await request(hub, "POST", "/sessions/rename" + k, { id, title: "renamed" });
    assert.equal(hub.snapshot().workspaces[0].sessions[0].title, "renamed");
    await request(hub, "POST", "/sessions/delete" + k, { id });
    await until(() => hub.snapshot().workspaces[0].sessions.length === 0, 2000, "deleted");
    await sleep(100);
    assert.equal(fs.existsSync(metaFile), false);

    // remove the workspace
    await request(hub, "POST", "/workspaces/remove" + k, { path: ws });
    assert.equal(hub.snapshot().workspaces.length, 0);
    assert.match((await request(hub, "POST", "/sessions/resume" + k, { id: "zzz" })).body, /unknown session/);
  } finally {
    hub.close();
  }
});

// ---- titles ----------------------------------------------------------------------

test("titles: cleanTitle normalizes what a model writes", () => {
  assert.equal(cleanTitle('"Fix login bug".\n'), "Fix login bug");
  assert.equal(cleanTitle("Title: Add dark mode toggle"), "Add dark mode toggle");
  assert.equal(cleanTitle("<think>hmm, what to call it</think>\nRefactor session loop"), "Refactor session loop");
  assert.equal(cleanTitle("  **Snake game in canvas**  "), "Snake game in canvas");
  assert.equal(cleanTitle(""), null);
  assert.equal(cleanTitle("<not a title>"), null);
  const long = cleanTitle("word ".repeat(30));
  assert.ok(long.length <= 60 && !/\s$/.test(long), "long titles are cut at a word boundary");
});

test("titles: suggestTitle asks with thinking off and a small cap, and falls back to null", async () => {
  const calls = [];
  const provider = { async chat(messages, tools, opts) { calls.push({ messages, opts }); return { content: " 'Sidebar Session Titles' ", toolCalls: [] }; } };
  const msgs = [
    { role: "system", content: "s" },
    { role: "user", content: "add titles to the sidebar" },
    { role: "assistant", content: "Done: titles added." },
  ];
  assert.equal(await suggestTitle(msgs, provider), "Sidebar Session Titles");
  assert.equal(calls[0].opts.effortOverride, "off");
  assert.ok(calls[0].opts.maxTokens <= 40);
  assert.match(calls[0].messages[1].content, /add titles to the sidebar/);
  assert.match(calls[0].messages[1].content, /Done: titles added/);
  assert.equal(await suggestTitle([{ role: "system", content: "s" }], provider), null, "no user message, no call");
  assert.equal(calls.length, 1);
  const failing = { async chat() { throw new Error("backend down"); } };
  assert.equal(await suggestTitle(msgs, failing), null);
});

test("hub: a manual rename is never overwritten by the model-written title", async () => {
  const dataDir = tmpdir("smol-hub4-");
  const hub = new WebHub({ port: 0, prefs: {}, help: "help", version: "9.9.9", dataDir, factory: fakeFactory([]), quiet: true });
  await hub.start();
  const k = "?k=" + hub.authToken;
  try {
    const { id } = JSON.parse((await request(hub, "POST", "/sessions/new" + k, { workspace: dataDir })).body);
    await until(() => hub.snapshot().workspaces[0].sessions[0].status === "idle", 2000, "idle");
    await request(hub, "POST", "/msg" + k, { sid: id, text: "first message" });
    await until(() => hub.snapshot().workspaces[0].sessions[0].title === "first message", 2000, "verbatim title");
    await request(hub, "POST", "/sessions/rename" + k, { id, title: "My Name" });
    await sleep(600); // past the fake model's naming delay
    assert.equal(hub.snapshot().workspaces[0].sessions[0].title, "My Name");
  } finally {
    hub.close();
  }
});

test("hub: a session that fails to start shows the error and can be retried", async () => {
  const dataDir = tmpdir("smol-hub3-");
  let attempts = 0;
  const factory = async (ui, workspace, prefs) => {
    attempts++;
    if (attempts === 1) throw new Error("No local model backend found.");
    return fakeFactory([])(ui, workspace, prefs);
  };
  const hub = new WebHub({ port: 0, prefs: {}, help: "help", version: "9.9.9", dataDir, factory, quiet: true });
  await hub.start();
  const k = "?k=" + hub.authToken;
  try {
    const { id } = JSON.parse((await request(hub, "POST", "/sessions/new" + k, { workspace: dataDir })).body);
    await until(() => hub.snapshot().workspaces[0].sessions[0].status === "error", 2000, "error status");
    const events = await readEvents(hub, (e) => e.t === "line" && e.kind === "error");
    assert.ok(events.some((e) => e.t === "line" && e.kind === "error" && /No local model/.test(e.s)));
    await request(hub, "POST", "/sessions/resume" + k, { id });
    await until(() => hub.snapshot().workspaces[0].sessions[0].status === "idle", 2000, "retried");
    assert.equal(attempts, 2);
  } finally {
    hub.close();
  }
});

test("hub: settings get/save round-trip", () => {
  const cfgDir = tmpdir("smol-settings-");
  const dataDir = tmpdir("smol-settings-data-");
  const savedConfig = process.env.SMOLCODER_CONFIG;
  const savedEnv = process.env.BRAVE_API_KEY;
  process.env.SMOLCODER_CONFIG = path.join(cfgDir, "config.json");
  delete process.env.BRAVE_API_KEY;
  try {
    assert.deepEqual(getSettingsStatus(dataDir), { braveApiKeySet: false, envOverride: false, globalAgentsMd: "" });
    const saved = saveSettingsKey("  test-key-1234 ");
    assert.equal(saved.ok, true);
    assert.equal(saved.braveApiKeySet, true);
    assert.ok(!JSON.stringify(saved).includes("test-key-1234"), "the full key is never returned");
    const status = getSettingsStatus(dataDir);
    assert.equal(status.braveApiKeySet, true);
    assert.equal(status.envOverride, false);
    assert.match(status.braveApiKeyHint, /^test/, "a short hint is shown");
    assert.ok(!JSON.stringify(status).includes("test-key-1234"), "GET never leaks the full key");
    const cleared = saveSettingsKey("   ");
    assert.equal(cleared.braveApiKeySet, false);
    assert.deepEqual(getSettingsStatus(dataDir), { braveApiKeySet: false, envOverride: false, globalAgentsMd: "" });
    assert.throws(() => saveSettingsKey(123), /must be a string/);
    assert.throws(() => saveSettingsKey("x".repeat(201)), /too long/);
  } finally {
    if (savedConfig !== undefined) process.env.SMOLCODER_CONFIG = savedConfig;
    else delete process.env.SMOLCODER_CONFIG;
    if (savedEnv !== undefined) process.env.BRAVE_API_KEY = savedEnv;
    fs.rmSync(cfgDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("hub: settings notes save, read and clear", () => {
  const dataDir = tmpdir("smol-settings-notes-");
  try {
    assert.equal(getSettingsStatus(dataDir).globalAgentsMd, "");
    const saved = saveSettingsNotes("  Answer in Korean. ", dataDir);
    assert.equal(saved.ok, true);
    assert.equal(getSettingsStatus(dataDir).globalAgentsMd, "Answer in Korean.");
    assert.ok(fs.existsSync(path.join(dataDir, "AGENTS.md")), "stored as a plain file next to the sessions");
    const cleared = saveSettingsNotes("   ", dataDir);
    assert.equal(cleared.cleared, true);
    assert.equal(getSettingsStatus(dataDir).globalAgentsMd, "");
    assert.throws(() => saveSettingsNotes(123, dataDir), /must be a string/);
    assert.throws(() => saveSettingsNotes("x".repeat(4001), dataDir), /too long/);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("hub: settings endpoints require a token and validate input", async () => {
  const dataDir = tmpdir("smol-hub-settings-");
  const cfgDir = tmpdir("smol-settings-http-");
  const savedConfig = process.env.SMOLCODER_CONFIG;
  const savedEnv = process.env.BRAVE_API_KEY;
  process.env.SMOLCODER_CONFIG = path.join(cfgDir, "config.json");
  delete process.env.BRAVE_API_KEY;
  const hub = new WebHub({ port: 0, prefs: {}, help: "help", version: "9.9.9", dataDir, factory: fakeFactory([]), quiet: true });
  await hub.start();
  const k = "?k=" + hub.authToken;
  try {
    assert.equal((await request(hub, "POST", "/settings/get", {})).status, 403);
    assert.equal((await request(hub, "POST", "/settings/save", { braveApiKey: "x" })).status, 403);
    const empty = JSON.parse((await request(hub, "POST", "/settings/get" + k, {})).body);
    assert.equal(empty.braveApiKeySet, false);
    const saved = JSON.parse((await request(hub, "POST", "/settings/save" + k, { braveApiKey: "http-key-9999" })).body);
    assert.equal(saved.ok, true);
    const status = JSON.parse((await request(hub, "POST", "/settings/get" + k, {})).body);
    assert.equal(status.braveApiKeySet, true);
    assert.ok(!(await request(hub, "POST", "/settings/get" + k, {})).body.includes("http-key-9999"));
    const bad = await request(hub, "POST", "/settings/save" + k, { braveApiKey: 123 });
    assert.equal(bad.status, 400);
    assert.match(bad.body, /must be a string/);
    process.env.BRAVE_API_KEY = "env-key";
    const over = JSON.parse((await request(hub, "POST", "/settings/get" + k, {})).body);
    assert.equal(over.envOverride, true);
    assert.equal(over.braveApiKeyHint, undefined, "an env override shadows the stored hint");
  } finally {
    hub.close();
    if (savedConfig !== undefined) process.env.SMOLCODER_CONFIG = savedConfig;
    else delete process.env.SMOLCODER_CONFIG;
    if (savedEnv !== undefined) process.env.BRAVE_API_KEY = savedEnv;
    else delete process.env.BRAVE_API_KEY;
    fs.rmSync(cfgDir, { recursive: true, force: true });
  }
});

test("hub: settings save accepts notes alone and rejects empty saves", async () => {
  const dataDir = tmpdir("smol-hub-notes-");
  const cfgDir = tmpdir("smol-notes-cfg-");
  const savedConfig = process.env.SMOLCODER_CONFIG;
  const savedEnv = process.env.BRAVE_API_KEY;
  process.env.SMOLCODER_CONFIG = path.join(cfgDir, "config.json");
  delete process.env.BRAVE_API_KEY;
  const hub = new WebHub({ port: 0, prefs: {}, help: "help", version: "9.9.9", dataDir, factory: fakeFactory([]), quiet: true });
  await hub.start();
  const k = "?k=" + hub.authToken;
  try {
    const saved = JSON.parse((await request(hub, "POST", "/settings/save" + k, { globalAgentsMd: "Be brief." })).body);
    assert.equal(saved.ok, true);
    const status = JSON.parse((await request(hub, "POST", "/settings/get" + k, {})).body);
    assert.equal(status.globalAgentsMd, "Be brief.");
    assert.equal(status.braveApiKeySet, false, "saving notes alone leaves the key alone");
    const empty = await request(hub, "POST", "/settings/save" + k, {});
    assert.equal(empty.status, 400);
    assert.match(empty.body, /nothing to save/);
  } finally {
    hub.close();
    if (savedConfig !== undefined) process.env.SMOLCODER_CONFIG = savedConfig;
    else delete process.env.SMOLCODER_CONFIG;
    if (savedEnv !== undefined) process.env.BRAVE_API_KEY = savedEnv;
    else delete process.env.BRAVE_API_KEY;
    fs.rmSync(cfgDir, { recursive: true, force: true });
  }
});

test("web: terminal input has a one-shot mask for passwords", () => {
  // The lock button and the waiting hint live in ensureTermTab; everything is
  // built with el()/createElement so no new page ids are needed.
  const fn = CLIENT_JS.slice(CLIENT_JS.indexOf("function ensureTermTab"), CLIENT_JS.indexOf("function setPrompt"));
  assert.ok(fn.length > 100, "the terminal tab section is present");
  assert.match(fn, /maskNext/, "a one-shot mask flag");
  assert.match(fn, /hidden: masked/, "the flag travels to /term/input");
  assert.match(fn, /••••••••/, "masked input echoes bullets");
  assert.match(fn, /sudo needs -S/, "the waiting hint names the sudo form that works");
  // Only the lock block is asserted here: the tab's Ctrl+L handler below it
  // clears with out.innerHTML = "" (pre-existing, no user data in it).
  const lock = fn.slice(fn.indexOf("const lock ="), fn.indexOf("inp.onkeydown"));
  assert.ok(lock.length > 100, "the lock block is present");
  assert.ok(!lock.includes("innerHTML"), "no HTML interpolation around the masked input");
});

test("web: settings dialog is wired to the settings endpoints", () => {
  assert.ok(PAGE_HTML.includes('id="settings"'), "the sidebar has a settings button");
  assert.ok(CLIENT_JS.includes('$("settings")'), "the client looks up the settings button");
  assert.ok(CLIENT_JS.includes("/settings/get"), "the client reads the settings");
  assert.ok(CLIENT_JS.includes("/settings/save"), "the client saves the settings");
});

test("web: settings dialog never puts user input through innerHTML", () => {
  // The dialog shows a server hint and takes a key: both must travel via
  // textContent (the el() helper) and input.value, never innerHTML.
  const fn = CLIENT_JS.slice(CLIENT_JS.indexOf("function openSettings"), CLIENT_JS.indexOf("// ---- global keys"));
  assert.ok(fn.length > 100, "the settings section is present");
  assert.ok(!fn.includes("innerHTML"), "no HTML interpolation in the settings dialog");
  assert.match(fn, /createElement\("input"\)/, "the key field is a created input");
  assert.match(fn, /\.type = "password"/, "the key field masks its content");
  assert.match(fn, /createElement\("textarea"\)/, "global instructions are a created textarea");
  assert.match(fn, /globalAgentsMd/, "the notes travel under their own field");
});
