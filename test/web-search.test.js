// Unit tests for the web_search tool implementation. These cover the logic that
// does not require network access (key handling + formatting); live search is
// validated manually via the .env key.
const test = require("node:test");
const assert = require("node:assert/strict");
const { formatWebSearchResults, truncate, webSearch } = require("../dist/tools/web-search");

test("formatWebSearchResults returns empty-state message when there are no results", () => {
  const out = formatWebSearchResults([]);
  assert.match(out, /No results found/);
});

test("formatWebSearchResults renders numbered titles, snippets and URLs", () => {
  const results = [
    { title: "Example Title", snippet: "hello   world\n\ttab", url: "https://example.com" },
  ];
  const out = formatWebSearchResults(results);
  assert.match(out, /1\. Example Title/);
  assert.ok(out.startsWith("Search results (backend: Brave Search)"));
  assert.match(out, /hello world tab/); // whitespace collapsed to single spaces
  assert.ok(out.endsWith("https://example.com"));
});

test("truncate keeps full text under the cap and appends a tail note over it", () => {
  assert.equal(truncate("short", 100), "short");
  const long = "x".repeat(500);
  const out = truncate(long, 300);
  assert.ok(out.length <= 320);
  assert.match(out, /\.\.\. \(truncated\)$/);
});

test("webSearch returns a clear error when BRAVE_API_KEY is missing", async () => {
  // Simulate the key not being available to this process.
  const saved = process.env.BRAVE_API_KEY;
  delete process.env.BRAVE_API_KEY;
  try {
    const out = await webSearch("anything");
    assert.equal(out, "Error: Missing BRAVE_API_KEY environment variable.");
  } finally {
    if (saved !== undefined) process.env.BRAVE_API_KEY = saved;
  }
});

// --- End-to-end pipeline tests (no network): mock global fetch ---------------

/** Mock the global `fetch` so we can exercise webSearch() without hitting Brave,
 *  and restore it afterwards. Returns a function that runs the callback while
 *  fetch is mocked. */
function withMockedFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => handler(url, options);
  return async () => {
    globalThis.fetch = original;
  };
}

test("webSearch runs the full pipeline (fetch -> parse -> format) with a mocked Brave response", async () => {
  const cleanup = await withMockedFetch(async () => {
    // Mirror Brave's JSON shape: { web: { results: [ {title, description, url}, ... ] } }
    return new Response(
      JSON.stringify({
        web: {
          results: [
            { title: "Example Title", description: "hello   world\n\ttab", url: "https://example.com" },
            { title: "Second Result", description: "a second snippet", url: "https://second.example.org" },
          ],
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });

  process.env.BRAVE_API_KEY = "test-key"; // ensure key is present
  try {
    const out = await webSearch("example query", 2);
    assert.ok(out.startsWith("Search results (backend: Brave Search)"), "output should be the search header");
    assert.match(out, /1\. Example Title/);
    assert.match(out, /2\. Second Result/);
    assert.match(out, /hello world tab/); // whitespace collapsed
    assert.ok(out.includes("https://example.com"));
    assert.ok(out.includes("https://second.example.org"));
    assert.equal(out.split("\n\n").length, 3, "two results -> three sections (header + 2)");
  } finally {
    await cleanup();
    delete process.env.BRAVE_API_KEY;
  }
});

test("webSearch reports a friendly error when the Brave API returns a non-ok status", async () => {
  const cleanup = await withMockedFetch(async () => {
    return new Response("forbidden", { status: 403, statusText: "Forbidden" });
  });

  process.env.BRAVE_API_KEY = "test-key";
  try {
    const out = await webSearch("example query");
    assert.match(out, /Error: Brave API error: 403 Forbidden/);
  } finally {
    await cleanup();
    delete process.env.BRAVE_API_KEY;
  }
});

test("webSearch caps output length and appends a truncation note on large responses", async () => {
  const cleanup = await withMockedFetch(async () => {
    return new Response(
      JSON.stringify({ web: { results: [{ title: "Big Title", description: "x".repeat(5000), url: "https://big.example" }] } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });

  process.env.BRAVE_API_KEY = "test-key";
  try {
    const out = await webSearch("example query");
    assert.ok(out.includes("... (truncated)"), "large snippet should be truncated with a note");
    // MAX_OUTPUT_CHARS is 3000 in web-search.ts; allow a small tail-note slack.
    assert.ok(out.length <= 3050, `output should stay near the cap (${out.length})`);
  } finally {
    await cleanup();
    delete process.env.BRAVE_API_KEY;
  }
});

test("webSearch returns a network-failure error when fetch throws", async () => {
  const cleanup = await withMockedFetch(async () => {
    throw new Error("Network request failed.");
  });

  process.env.BRAVE_API_KEY = "test-key";
  try {
    const out = await webSearch("example query");
    assert.match(out, /Error: Network request failed\./);
  } finally {
    await cleanup();
    delete process.env.BRAVE_API_KEY;
  }
});
