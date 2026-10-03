// Desktop shell for smolcoder-plus (macOS). Shows the local WebHub in a
// window, so there is no terminal step. One server only: when another
// `smolp --web` (or app) hub is already running, the app opens a window onto
// it instead of starting its own. The agent core is reused as-is: in dev it
// is required from the repo `dist/`, in a packaged app from the bundled
// `core` resources.
//
// Testability: Electron is injected via run() so tests can pass fakes and
// exercise the lifecycle (single instance, join, shutdown) with plain node
// — no display needed.

"use strict";

const path = require("node:path");

const DEFAULT_PORT = 7433;
const MAX_PORT_TRIES = 10;

// This file's own package.json: bundled into app.asar, so it is always
// available — the fallback version source when the core layout differs.
const desktopPkg = require("./package.json");

function coreDir(opts) {
  if (opts.isPackaged) return path.join(opts.resourcesPath, "core");
  return path.resolve(opts.dirname, "..", "..", "dist");
}

/** Core version for the sidebar footer. Packaged layout (Resources/core) has
 * no sibling package.json, so the desktop one (bumped together) applies. */
function resolveVersion(coreRoot) {
  try {
    return require(path.join(coreRoot, "..", "package.json")).version;
  } catch {
    return desktopPkg.version;
  }
}

function loadCore(coreRoot) {
  return {
    hub: require(path.join(coreRoot, "web", "hub")),
    version: resolveVersion(coreRoot),
  };
}

/** Start a hub on one fixed port (tries > 1 keeps the old skip-busy
 * behaviour for tests; the app itself always passes 1). */
async function startHub(coreRoot, port, dataDir, tries = MAX_PORT_TRIES) {
  const { hub, version } = loadCore(coreRoot);
  let lastErr = null;
  for (let p = port; p < port + tries; p++) {
    const h = new hub.WebHub({ port: p, prefs: {}, help: "", version, ...(dataDir ? { dataDir } : {}) });
    try {
      await h.start();
      return h;
    } catch (err) {
      if (err && err.code === "EADDRINUSE") {
        lastErr = err;
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

/** A hub started earlier by `smolp --web` or another app run, if it still
 * answers. Returned URL carries that hub's token, so the window can attach
 * without starting a second server. */
async function findRunningHub(coreRoot, dataDir) {
  const core = loadCore(coreRoot);
  const dir = dataDir ?? require(path.join(coreRoot, "config")).DATA_DIR;
  const rec = core.hub.readHubRecord(dir);
  if (!rec) return null;
  if (!(await core.hub.pingHub(rec))) return null;
  return { port: rec.port, url: `http://127.0.0.1:${rec.port}/?k=${rec.token}` };
}

function run(electron, opts) {
  const { app, BrowserWindow } = electron;
  const dialog = electron.dialog || { showMessageBox: async () => {}, showErrorBox: () => {} };
  const options = opts || {};
  const coreRoot = options.coreRoot || coreDir({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, dirname: __dirname });
  const envPort = Number(process.env.SMOL_DESKTOP_PORT);
  const basePort = options.port ?? (envPort > 0 ? envPort : DEFAULT_PORT);

  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return { started: false };
  }

  let win = null;
  let hub = null;
  // Joined someone else's hub: quitting must not shut it down.
  let ownHub = false;

  const openWindow = async (url) => {
    win = new BrowserWindow({ width: 1280, height: 860, backgroundColor: "#111416", title: "smolcoder-plus" });
    await win.loadURL(url);
  };

  const createWindow = async () => {
    const running = await findRunningHub(coreRoot, options.dataDir);
    if (running) {
      await dialog.showMessageBox({ type: "info", title: "smolcoder-plus", message: `A server is already running on port ${running.port}.`, detail: "This window joined it instead of starting a second one. Quitting the app leaves that server running." });
      await openWindow(running.url);
      return;
    }
    try {
      hub = await startHub(coreRoot, basePort, options.dataDir, 1);
      ownHub = true;
    } catch (err) {
      if (err && err.code === "EADDRINUSE") {
        dialog.showErrorBox("smolcoder-plus: port in use", `Port ${basePort} is occupied by something that is not a smolcoder server. Free the port or set SMOL_DESKTOP_PORT, then reopen the app.`);
      } else {
        console.error("smolcoder-plus: could not start the hub:", err);
      }
      app.quit();
      return;
    }
    await openWindow(hub.url());
  };

  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", () => {
    // Only our own hub: a joined server belongs to its starter and stays up.
    if (!ownHub) return;
    try {
      if (hub) hub.shutdownSync();
    } catch {
      /* best effort */
    }
  });
  app.whenReady().then(() => {
    createWindow();
  });
  return { started: true, getWindow: () => win, getHub: () => hub };
}

if (require.main === module) {
  run(require("electron"));
}

module.exports = { run, startHub, findRunningHub, coreDir, resolveVersion, DEFAULT_PORT };
