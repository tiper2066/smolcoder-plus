// web_search tool: Brave Search API integration for the agent.
// Port of scripts/search.js (loadDotEnv + fetchWithTimeout + searchBrave + formatting)
// into TypeScript so every new project gets internet search without copying files.

const MAX_OUTPUT_CHARS = 3000;
export const DEFAULT_MAX_RESULTS = 5;
const FETCH_TIMEOUT_MS = 10000;

export interface WebSearchResult {
  title: string;
  snippet: string;
  url: string;
}

/** Load KEY=VALUE pairs from a .env file in the current working directory or any parent
 * directory into process.env, without any npm dependency. Real, already-exported env vars always
 * win — this only fills in values that aren't set yet (matches scripts/search.js). */
async function loadDotEnv(): Promise<void> {
  try {
    const { readFileSync } = await import("node:fs");
    const { join, dirname } = await import("node:path");
    
    let currentDir = process.cwd();
    let envLoaded = false;

    while (currentDir !== dirname(currentDir) && !envLoaded) {
      const envPath = join(currentDir, ".env");
      try {
        if (readFileSync(envPath, "utf8")) {
          const content = readFileSync(envPath, "utf8");
          for (const rawLine of content.split("\n")) {
            const line = rawLine.trim();
            if (!line || line.startsWith("#")) continue;
            const eq = line.indexOf("=");
            if (eq === -1) continue;
            const key = line.slice(0, eq).trim();
            let value = line.slice(eq + 1).trim();
            if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
              value = value.slice(1, -1);
            }
            if (!(key in process.env)) process.env[key] = value;
          }
          envLoaded = true;
        }
      } catch {
        // File not found or unreadable, move up
      }
      currentDir = dirname(currentDir);
    }
  } catch {
    // General failure — fine, just rely on real env vars.
  }
}

/** fetch with a hard timeout; returns null on any failure. */
async function fetchWithTimeout(url: string, options: Record<string, any> = {}): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Truncate at the end (with a short tail note) — used for search output. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 20) + "\n... (truncated)";
}

/** Format raw Brave results into numbered titles, snippets and URLs. */
export function formatWebSearchResults(results: WebSearchResult[]): string {
  if (results.length === 0) {
    return "No results found. (backend: Brave Search)";
  }
  const lines = results.map((r, i) => {
    const title = (r.title || "(no title)").trim();
    const snippet = (r.snippet || "").trim().replace(/\s+/g, " ");
    const url = (r.url || "").trim();
    return `${i + 1}. ${title}\n   ${snippet}\n   ${url}`;
  });
  return `Search results (backend: Brave Search)\n\n${lines.join("\n\n")}`;
}

/** Call the Brave Search API and return up to maxResults items. */
export async function searchBrave(query: string, maxResults: number): Promise<WebSearchResult[]> {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${maxResults}`;
  const res = await fetchWithTimeout(url, {
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": process.env.BRAVE_API_KEY,
    },
  });
  if (!res) throw new Error("Network request failed.");
  if (!res.ok) throw new Error(`Brave API error: ${res.status} ${res.statusText}`);
  const data = (await res.json()) as { web?: { results?: any[] } };
  const items = (data.web && data.web.results) || [];
  return items.slice(0, maxResults).map((r) => ({
    title: r.title,
    snippet: r.description,
    url: r.url,
  }));
}

/** Main entry point used by the tool registry. Returns a formatted string. */
export function webSearch(query: string, maxResults?: number): Promise<string> {
  const limit = Math.max(1, Math.min(8, maxResults ?? DEFAULT_MAX_RESULTS));
  return loadDotEnv()
    .then(() => {
      if (!process.env.BRAVE_API_KEY) {
        return "Error: Missing BRAVE_API_KEY environment variable.";
      }
      return searchBrave(query, limit)
        .then((results) => truncate(formatWebSearchResults(results), MAX_OUTPUT_CHARS))
        .catch((e) => `Error: ${e.message}`);
    });
}
