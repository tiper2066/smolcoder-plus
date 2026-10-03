// Desktop shell smoke tests: the Electron main process lifecycle with a fake
// `electron` module, so no display is needed. The real WebHub from dist/ is
// used, with scratch data/config dirs so nothing real is touched.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const DIST = path.join(__dirname, "..", "dist");
const main = require("../apps/desktop/main");
const { readHubRecord } = require("../dist/web/hub");

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function fakeElectron(singleInstance = true) {
  const handlers = {};
  const fake = {
    windows: [],
    quitCalled: false,
    dialog: {
      messages: [],
      errors: [],
      showMessageBox: async (o) => {
        fake.dialog.messages.push(o);
      },
      showErrorBox: (title, msg) => {
        fake.dialog.errors.push([title, msg]);
      },
    },
    app: {
      isPackaged: false,
      requestSingleInstanceLock: () => singleInstance,
      quit: () => {
        fake.quitCalled = true;
        for (const fn of handlers["before-quit"] || []) fn();
      },
      on: (ev, fn) => {
        (handlers[ev] = handlers[ev] || []).push(fn);
      },
      whenReady: () => Promise.resolve(),
      fire: (ev) => {
        for (const fn of handlers[ev] || []) fn();
      },
    },
    BrowserWindow: function (opts) {
      const w = { opts, url: null, focused: false };
      w.loadURL = async (u) => {
        w.url = u;
      };
      w.isMinimized = () => false;
      w.restore = () => {};
      w.focus = () => {
        w.focused = true;
      };
      fake.windows.push(w);
      return w;
    },
  };
  return fake;
}

async function until(fn, ms = 5000, label = "condition") {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("timed out waiting for " + label);
    await new Promise((r) => setTimeout(r, 25));
  }
}

test("desktop: coreDir points at the repo dist in dev", () => {
  const dir = main.coreDir({ isPackaged: false, resourcesPath: "/x", dirname: path.join("repo", "apps", "desktop") });
  assert.ok(dir.endsWith(path.join("repo", "dist")), dir);
});

test("desktop: coreDir points at bundled resources when packaged", () => {
  const dir = main.coreDir({ isPackaged: true, resourcesPath: "/App/Resources", dirname: "/x" });
  assert.equal(dir, path.join("/App/Resources", "core"));
});

test("desktop: startHub serves the page and shuts down cleanly", async () => {
  const dataDir = tmpdir("smol-desk-");
  const hub = await main.startHub(DIST, 0, dataDir);
  try {
    assert.match(hub.url(), /\?k=/, "the window URL carries the auth token");
    const page = await (await fetch(hub.url())).text();
    assert.match(page, /id="settings"/, "the served page has the settings button");
    const rec = readHubRecord(dataDir);
    assert.equal(rec.port, hub.port);
  } finally {
    hub.close();
  }
  assert.equal(readHubRecord(dataDir), null, "the running-hub record is removed on shutdown");
});

test("desktop: startHub skips a busy port", async () => {
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const busy = srv.address().port;
  const dataDir = tmpdir("smol-desk-busy-");
  const hub = await main.startHub(DIST, busy, dataDir);
  try {
    assert.notEqual(hub.port, busy, "a port owned by another server is skipped");
  } finally {
    hub.close();
    srv.close();
  }
});

test("desktop: run opens the hub URL and quits cleanly", async () => {
  const dataDir = tmpdir("smol-desk-run-");
  const fake = fakeElectron(true);
  const r = main.run(fake, { coreRoot: DIST, port: 0, dataDir });
  assert.equal(r.started, true);
  try {
    const win = await until(() => (fake.windows[0] && fake.windows[0].url ? fake.windows[0] : null), 5000, "window URL");
    assert.match(win.url, /\?k=/);
    fake.app.fire("second-instance");
    assert.equal(win.focused, true, "a second launch focuses the window");
    fake.app.quit();
    assert.equal(readHubRecord(dataDir), null, "quitting removes the running-hub record");
  } finally {
    const hub = r.getHub();
    if (hub) hub.close();
  }
});

test("desktop: run quits when another instance owns the lock", () => {
  const fake = fakeElectron(false);
  const r = main.run(fake, { coreRoot: DIST, port: 0, dataDir: tmpdir("smol-desk-lock-") });
  assert.equal(r.started, false);
  assert.equal(fake.quitCalled, true);
  assert.equal(fake.windows.length, 0, "no window is opened");
});

test("desktop: run joins a running hub instead of starting a second server", async () => {
  const dataDir = tmpdir("smol-desk-join-");
  const { WebHub, pingHub } = require("../dist/web/hub");
  const first = new WebHub({ port: 0, prefs: {}, help: "h", version: "t", dataDir, factory: async () => { throw new Error("no backend"); }, quiet: true });
  await first.start();
  try {
    const fake = fakeElectron(true);
    const r = main.run(fake, { coreRoot: DIST, port: 0, dataDir });
    assert.equal(r.started, true);
    const win = await until(() => (fake.windows[0] && fake.windows[0].url ? fake.windows[0] : null), 5000, "window URL");
    assert.equal(win.url, first.url(), "the window attaches to the running hub");
    assert.equal(fake.dialog.messages.length, 1, "joining shows the already-running notice");
    assert.match(fake.dialog.messages[0].message, /already running/);
    assert.equal(r.getHub(), null, "no second hub was started");
    fake.app.quit();
    assert.equal(await pingHub({ port: first.port, token: first.authToken }), true, "quitting leaves the joined server running");
  } finally {
    first.close();
  }
});

test("desktop: run quits with a warning when a stranger owns the port", async () => {
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const busy = srv.address().port;
  const dataDir = tmpdir("smol-desk-stranger-");
  try {
    const fake = fakeElectron(true);
    const r = main.run(fake, { coreRoot: DIST, port: busy, dataDir });
    assert.equal(r.started, true, "the app instance itself started");
    await until(() => fake.quitCalled, 5000, "quit after the port warning");
    assert.equal(fake.windows.length, 0, "no window without a server");
    assert.equal(fake.dialog.errors.length, 1, "the port warning is shown");
    assert.match(fake.dialog.errors[0][1], new RegExp(String(busy)));
  } finally {
    srv.close();
  }
});

test("desktop: packaged layout falls back to the desktop version", () => {
  const rootPkg = require("../package.json");
  const deskPkg = require("../apps/desktop/package.json");
  assert.equal(main.resolveVersion(DIST), rootPkg.version, "dev uses the core version");
  assert.equal(main.resolveVersion(tmpdir("smol-desk-noversion-")), deskPkg.version, "packaged layout uses the desktop version");
});
