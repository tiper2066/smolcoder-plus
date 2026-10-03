// web_fetch tool: read a web page as text. Follows web_search — the model
// searches first, then fetches the promising hits instead of shelling out to
// curl (which bot-protected sites like Wikipedia reject).
// No npm dependency: global fetch with a hard timeout, bounded download, and
// a small HTML-to-text converter below.

const FETCH_TIMEOUT_MS = 15000;
/** Never hold more than this of a page in memory; the rest is cut off. */
const DOWNLOAD_CAP = 512 * 1024;
/** What the model sees per call; TOOL_RESULT_CAP in index.ts caps it again. */
const OUTPUT_CAP = 6000;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  copy: "©",
  reg: "®",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "'",
  rsquo: "'",
  ldquo: '"',
  rdquo: '"',
  laquo: "«",
  raquo: "»",
  middot: "·",
  times: "×",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#\d+|#x[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (!Number.isSafeInteger(code) || code < 0 || code > 0x10ffff) return m;
      try {
        return String.fromCodePoint(code);
      } catch {
        return m;
      }
    }
    return NAMED_ENTITIES[e] ?? m;
  });
}

/** Rough HTML-to-text: drops scripts/styles, keeps table cells separated so a
 * medal table reads as rows instead of one glued number. Exported for tests. */
export function htmlToText(html: string): string {
  let s = html;
  s = s.replace(/<script[\s\S]*?<\/script>/gi, " ");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, " ");
  s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  // Table cells first (td/th share the <t prefix with tr, so order matters).
  s = s.replace(/<\/t[dh]>/gi, " | ");
  // Block tags open a line. The whole opening tag (attributes included) is
  // replaced — matching only "<div " would leave `class="..." ...>` behind.
  s = s.replace(/<(br|p|div|li|tr|h1|h2|h3|h4|h5|h6|table|section|article)(\s[^>]*)?>/gi, "\n");
  s = s.replace(/<\/(p|div|li|tr|h1|h2|h3|h4|h5|h6|table|section|article)>/gi, "\n");
  s = s.replace(/<[^>]*>/g, " ");
  s = decodeEntities(s);
  return s
    .split("\n")
    .map((line) => line.replace(/[ \t\u00a0]+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

function pageTitle(html: string): string {
  const m = /<title[^>]*>([\s\S]{1,300})<\/title>/i.exec(html);
  return m ? decodeEntities(m[1]).replace(/\s+/g, " ").trim() : "";
}

/** Read at most `cap` bytes, then cancel the stream instead of buffering a
 * whole huge page. Works on the web stream Node's fetch returns. */
async function readCapped(res: Response, cap: number): Promise<{ text: string; cut: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) {
    const text = await res.text();
    return text.length > cap ? { text: text.slice(0, cap), cut: true } : { text, cut: false };
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  let cut = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) {
      const keep = value.byteLength - (size - cap);
      if (keep > 0) chunks.push(value.subarray(0, keep));
      cut = true;
      try {
        await reader.cancel();
      } catch {
        /* already closed */
      }
      break;
    }
    chunks.push(value);
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const buf = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    buf.set(c, at);
    at += c.length;
  }
  return { text: new TextDecoder().decode(buf), cut };
}

/** Fetch one URL and return readable text. Never throws: failures come back
 * as an "Error: ..." string, like webSearch. */
export async function fetchPageText(rawUrl: string, maxChars = OUTPUT_CAP): Promise<string> {
  const input = (rawUrl || "").trim();
  if (!input) return 'Error: url is required. Example: {"url": "https://example.com/page"}';
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return `Error: not a URL: "${input.slice(0, 120)}".`;
  }
  // Only http(s): fetch would otherwise reach file:/data: targets, and the
  // agent already has local file tools for those.
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return `Error: only http(s) URLs can be fetched (got "${url.protocol}").`;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url.toString(), {
      signal: controller.signal,
      headers: {
        // A browser UA: bare curl/undici agents are the ones that get a 403
        // or a dropped connection from bot-protected sites.
        "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
        accept: "text/html,application/xhtml+xml,text/plain,*/*",
      },
    });
    if (!res.ok) return `Error: ${res.status} ${res.statusText} — "${url}".`;
    const kind = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    const { text, cut } = await readCapped(res, DOWNLOAD_CAP);
    const body = kind === "text/html" || kind === "" || kind.includes("xml") ? htmlToText(text) : text;
    const title = kind === "text/html" ? pageTitle(text) : "";
    const head = title ? `Page: ${title}\nURL: ${res.url || url.toString()}\n\n` : `URL: ${res.url || url.toString()}\n\n`;
    const limit = Math.max(500, Math.min(OUTPUT_CAP, maxChars || OUTPUT_CAP));
    const out = head + body;
    return out.length > limit ? out.slice(0, limit) + "\n... (truncated)" : out;
  } catch (err: any) {
    if (err?.name === "AbortError") return `Error: timed out fetching "${url}" (15s).`;
    return `Error: cannot fetch "${url}": ${err?.message ?? err}`;
  } finally {
    clearTimeout(timer);
  }
}
