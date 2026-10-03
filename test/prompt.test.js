// Unit tests for global + workspace AGENTS.md resolution.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { loadAgentsMd, loadGlobalAgentsMd, resolveAgentsMd, buildSystemPrompt } = require("../dist/prompt");

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("prompt: resolveAgentsMd uses the global file when the workspace has none", () => {
  const dataDir = tmpdir("smol-agents-g-");
  const ws = tmpdir("smol-agents-w-");
  try {
    fs.writeFileSync(path.join(dataDir, "AGENTS.md"), "Answer in Korean.");
    const r = resolveAgentsMd(ws, path.join(dataDir, "AGENTS.md"));
    assert.equal(r.text, "Answer in Korean.");
    assert.equal(r.fromGlobal, true);
    assert.equal(r.fromWorkspace, false);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test("prompt: resolveAgentsMd puts global first, then the project file", () => {
  const dataDir = tmpdir("smol-agents-g2-");
  const ws = tmpdir("smol-agents-w2-");
  try {
    fs.writeFileSync(path.join(dataDir, "AGENTS.md"), "Global tone.");
    fs.writeFileSync(path.join(ws, "AGENTS.md"), "Project rules.");
    const r = resolveAgentsMd(ws, path.join(dataDir, "AGENTS.md"));
    assert.equal(r.text, "Global tone.\n\nProject rules.");
    assert.equal(r.fromGlobal, true);
    assert.equal(r.fromWorkspace, true);
    assert.ok(r.text.indexOf("Global") < r.text.indexOf("Project"), "general before specific");
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test("prompt: resolveAgentsMd is null when neither exists", () => {
  const r = resolveAgentsMd(tmpdir("smol-agents-w3-"), path.join(tmpdir("smol-agents-g3-"), "AGENTS.md"));
  assert.equal(r.text, null);
  assert.equal(r.fromGlobal, false);
  assert.equal(r.fromWorkspace, false);
});

test("prompt: the global file is capped", () => {
  const dataDir = tmpdir("smol-agents-g4-");
  try {
    fs.writeFileSync(path.join(dataDir, "AGENTS.md"), "x".repeat(5000));
    const text = loadGlobalAgentsMd(path.join(dataDir, "AGENTS.md"));
    assert.ok(text.length <= 4100, `bounded (${text.length})`);
    assert.match(text, /truncated here/);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("prompt: resolved instructions land in the system prompt", () => {
  const sys = buildSystemPrompt({ workspace: "/w", mode: "edit", shellLabel: "sh", agentsMd: "Global tone.\n\nProject rules." });
  assert.match(sys, /Workspace instructions from AGENTS\.md/);
  assert.match(sys, /Global tone/);
  const bare = buildSystemPrompt({ workspace: "/w", mode: "edit", shellLabel: "sh", agentsMd: null });
  assert.ok(!bare.includes("Workspace instructions"), "no section without instructions");
});

test("prompt: loadAgentsMd keeps its workspace-only behaviour", () => {
  const ws = tmpdir("smol-agents-w5-");
  try {
    assert.equal(loadAgentsMd(ws), null);
    fs.writeFileSync(path.join(ws, "AGENTS.md"), "  Rules.  ");
    assert.equal(loadAgentsMd(ws), "Rules.");
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
