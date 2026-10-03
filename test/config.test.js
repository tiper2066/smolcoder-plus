// Unit tests for Settings-backed config (Phase 1: braveApiKey).
const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");

function withScratchConfig() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "smol-cfg-"));
  const file = path.join(tmp, "config.json");
  const saved = process.env.SMOLCODER_CONFIG;
  process.env.SMOLCODER_CONFIG = file;
  // Require fresh so CONFIG_PATH picks up the scratch file.
  delete require.cache[require.resolve("../dist/config")];
  const mod = require("../dist/config");
  return {
    mod,
    file,
    restore() {
      if (saved !== undefined) process.env.SMOLCODER_CONFIG = saved;
      else delete process.env.SMOLCODER_CONFIG;
      delete require.cache[require.resolve("../dist/config")];
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

test("config: braveApiKey round-trip", () => {
  const { mod, file, restore } = withScratchConfig();
  try {
    mod.saveConfig({ braveApiKey: "  test-key " });
    const loaded = mod.loadConfig();
    assert.equal(loaded.braveApiKey, "test-key");
    assert.ok(fs.existsSync(file));
  } finally {
    restore();
  }
});

test("config: empty braveApiKey is dropped", () => {
  const { mod, restore } = withScratchConfig();
  try {
    mod.saveConfig({ braveApiKey: "   " });
    assert.equal(mod.loadConfig().braveApiKey, undefined);
  } finally {
    restore();
  }
});

test("config: other fields survive a key update", () => {
  const { mod, restore } = withScratchConfig();
  try {
    mod.saveConfig({ lastModel: "qwen3:8b", braveApiKey: "k1" });
    mod.updateConfig({ braveApiKey: "k2" });
    const loaded = mod.loadConfig();
    assert.equal(loaded.braveApiKey, "k2");
    assert.equal(loaded.lastModel, "qwen3:8b");
  } finally {
    restore();
  }
});
