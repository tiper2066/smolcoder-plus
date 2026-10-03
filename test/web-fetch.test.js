// Unit tests for the web_fetch tool. Network is mocked: only parsing,
// guards and the fetch pipeline are covered here.
const test = require("node:test");
const assert = require("node:assert/strict");
const { decodeEntities, htmlToText, fetchPageText } = require("../dist/tools/web-fetch");

function withMockedFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => handler(url, options);
  return async () => {
    globalThis.fetch = original;
  };
}

test("web-fetch: decodeEntities handles named, decimal and hex entities", () => {
  assert.equal(decodeEntities("a &amp; b &lt;c&gt;"), "a & b <c>");
  assert.equal(decodeEntities("&#65;&#x42;"), "AB");
  assert.equal(decodeEntities("&mdash;&nbsp;&unknown;"), "— &unknown;");
});

test("web-fetch: htmlToText drops scripts and keeps table cells apart", () => {
  const html = [
    "<html><head><title>Medal table</title><style>.x{}</style></head><body>",
    "<script>alert(1)</script>",
    "<h1>Standings</h1>",
    "<table><tr><th>Team</th><th>Gold</th></tr>",
    "<tr><td>South Korea</td><td>10</td></tr></table>",
    "</body></html>",
  ].join("");
  const out = htmlToText(html);
  assert.ok(!out.includes("alert"), "scripts are dropped");
  assert.ok(!out.includes(".x{}"), "styles are dropped");
  assert.match(out, /Standings/);
  assert.match(out, /South Korea \| 10/, "cells stay separated, not glued");
});

test("web-fetch: tag attributes never leak into the text", () => {
  // Regression: matching only "<div " left `class="..." ...>` tails behind.
  const out = htmlToText('<div id="a" class="x y" title="t">Hi</div><p class="z">Bye</p>');
  assert.ok(!out.includes("class="), "no attribute junk");
  assert.ok(!out.includes('id="a"'), "no attribute junk");
  assert.match(out, /Hi/);
  assert.match(out, /Bye/);
});

test("web-fetch: fetches an HTML page with title, URL and a browser UA", async () => {
  let seenUa = null;
  const cleanup = await withMockedFetch(async (url, options) => {
    seenUa = options?.headers?.["user-agent"];
    return new Response("<html><head><title>Hi</title></head><body><p>Hello world</p></body></html>", {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  });
  try {
    const out = await fetchPageText("https://example.com/page");
    assert.match(out, /Page: Hi/);
    assert.match(out, /URL: https:\/\/example\.com\/page/);
    assert.match(out, /Hello world/);
    assert.match(seenUa, /Mozilla/, "a browser UA is sent so bot filters pass");
  } finally {
    await cleanup();
  }
});

test("web-fetch: passes plain text through", async () => {
  const cleanup = await withMockedFetch(async () => {
    return new Response("just text\nsecond line", { status: 200, headers: { "content-type": "text/plain" } });
  });
  try {
    const out = await fetchPageText("https://example.com/robots.txt");
    assert.match(out, /just text/);
    assert.ok(!out.startsWith("Page:"), "no title line for non-HTML");
  } finally {
    await cleanup();
  }
});

test("web-fetch: reports HTTP errors without throwing", async () => {
  const cleanup = await withMockedFetch(async () => {
    return new Response("nope", { status: 404, statusText: "Not Found" });
  });
  try {
    assert.match(await fetchPageText("https://example.com/gone"), /Error: 404/);
  } finally {
    await cleanup();
  }
});

test("web-fetch: reports network failures without throwing", async () => {
  const cleanup = await withMockedFetch(async () => {
    throw new Error("boom");
  });
  try {
    assert.match(await fetchPageText("https://example.com/"), /Error: cannot fetch/);
  } finally {
    await cleanup();
  }
});

test("web-fetch: refuses empty, malformed and non-http URLs", async () => {
  assert.match(await fetchPageText(""), /url is required/);
  assert.match(await fetchPageText("not a url"), /not a URL/);
  assert.match(await fetchPageText("file:///etc/passwd"), /only http\(s\)/);
});

test("web-fetch: truncates long pages", async () => {
  const cleanup = await withMockedFetch(async () => {
    return new Response("<html><body><p>" + "x".repeat(50000) + "</p></body></html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    });
  });
  try {
    const out = await fetchPageText("https://example.com/big");
    assert.ok(out.length <= 7000, `bounded output (${out.length})`);
    assert.match(out, /\.\.\. \(truncated\)$/);
  } finally {
    await cleanup();
  }
});
