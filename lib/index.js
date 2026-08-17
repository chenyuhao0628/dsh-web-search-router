import z from "@deepseek-ai/schemastery";
import { WebError } from "@deepseek-ai/dsh-web";

export const name = "web-search-router";
export const inject = ["web"];
export const MULTI_SEARCH_PROVIDER_ID = "multi-search";

const USER_AGENT = "dsh-web-search-router/0.1.0";
const PARALLEL_URL = "https://search.parallel.ai/mcp";
const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_MAX_RESULTS_PER_PROVIDER = 8;
const RRF_K = 60;

// Capacity is a conservative free-tier estimate, not a live quota counter.
// Runtime latency is updated after every successful call and blended with it
// so a slow source naturally moves down the fallback chain.
const PROVIDER_META = {
  tavily: { label: "Tavily", capacity: 1000, latencyMs: 986 },
  exa: { label: "Exa", capacity: 1400, latencyMs: 1533 },
  brave: { label: "Brave Search", capacity: 1000, latencyMs: 1197 },
  serper: { label: "Serper", capacity: 1000, latencyMs: 1000 },
  serpapi: { label: "SerpApi", capacity: 250, latencyMs: 11705 }
};
const KEYED_PROVIDER_ORDER = ["tavily", "exa", "brave", "serper", "serpapi"];

export const Config = z.object({
  timeoutMs: z.number().step(1).min(1000).default(DEFAULT_TIMEOUT_MS),
  maxResultsPerProvider: z.number().step(1).min(1).default(DEFAULT_MAX_RESULTS_PER_PROVIDER),
  tavilyApiKeyEnv: z.string().default("TAVILY_API_KEY"),
  exaApiKeyEnv: z.string().default("EXA_API_KEY"),
  serperApiKeyEnv: z.string().default("SERPER_API_KEY"),
  braveApiKeyEnv: z.string().default("BRAVE_SEARCH_API_KEY"),
  serpapiApiKeyEnv: z.string().default("SERPAPI_API_KEY")
});

function positiveInt(value) {
  return Number.isInteger(value) && value > 0;
}

function abortError(signal) {
  const error = new Error("Search aborted");
  error.name = "AbortError";
  if (signal?.aborted) throw error;
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError(signal);
}

function withTimeout(signal, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  };
}

export function canonicalUrl(raw) {
  try {
    const url = new URL(raw);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|gclid$|fbclid$|mc_cid$|mc_eid$)/i.test(key)) url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return String(raw);
  }
}

function source(url, title, snippet, publishedAt, provider) {
  if (typeof url !== "string" || url.length === 0) return null;
  const result = { url: canonicalUrl(url) };
  if (typeof title === "string" && title.trim()) result.title = title.trim();
  if (typeof snippet === "string" && snippet.trim()) result.snippet = `[${provider}] ${snippet.trim()}`;
  if (typeof publishedAt === "string" && publishedAt.trim()) result.publishedAt = publishedAt.trim();
  return result;
}

async function jsonResponse(response, label, signal) {
  if (!response.ok) {
    let detail = "";
    try {
      const body = await response.json();
      detail = typeof body?.message === "string" ? body.message : typeof body?.error === "string" ? body.error : "";
    } catch {}
    throw new Error(`${label} HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
  }
  throwIfAborted(signal);
  return response.json();
}

async function parallelSearch(query, limit, signal) {
  const body = {
    jsonrpc: "2.0",
    id: Date.now(),
    method: "tools/call",
    params: { name: "web_search", arguments: { objective: query, search_queries: [query] } }
  };
  const response = await fetch(PARALLEL_URL, {
    method: "POST",
    redirect: "error",
    headers: { "content-type": "application/json", accept: "application/json", "user-agent": USER_AGENT },
    body: JSON.stringify(body),
    signal
  });
  const payload = await jsonResponse(response, "Parallel", signal);
  const text = payload?.result?.content?.find?.((item) => item?.type === "text" && typeof item.text === "string")?.text;
  if (!text) throw new Error("Parallel returned no structured result");
  const data = JSON.parse(text);
  const rows = Array.isArray(data?.results) ? data.results : [];
  return rows.slice(0, limit).map((item) => source(item?.url, item?.title, Array.isArray(item?.excerpts) ? item.excerpts.join("\n") : "", item?.publish_date, "Parallel")).filter(Boolean);
}

async function tavilySearch(query, limit, key, signal) {
  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": USER_AGENT },
    body: JSON.stringify({ api_key: key, query, search_depth: "basic", max_results: limit, include_answer: false }),
    signal
  });
  const data = await jsonResponse(response, "Tavily", signal);
  return (Array.isArray(data?.results) ? data.results : []).map((item) => source(item?.url, item?.title, item?.content, item?.published_date, "Tavily")).filter(Boolean);
}

async function exaSearch(query, limit, key, signal) {
  const response = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "user-agent": USER_AGENT },
    body: JSON.stringify({ query, numResults: limit, contents: { highlights: { maxCharacters: 1200 } } }),
    signal
  });
  const data = await jsonResponse(response, "Exa", signal);
  return (Array.isArray(data?.results) ? data.results : []).map((item) => source(item?.url, item?.title, Array.isArray(item?.highlights) ? item.highlights.join("\n") : item?.text, item?.publishedDate, "Exa")).filter(Boolean);
}

async function serperSearch(query, limit, key, signal) {
  const response = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "user-agent": USER_AGENT },
    body: JSON.stringify({ q: query, num: limit }),
    signal
  });
  const data = await jsonResponse(response, "Serper", signal);
  return (Array.isArray(data?.organic) ? data.organic : []).map((item) => source(item?.link, item?.title, item?.snippet, item?.date, "Serper")).filter(Boolean);
}

async function braveSearch(query, limit, key, signal) {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(limit));
  const response = await fetch(url, {
    headers: { accept: "application/json", "x-subscription-token": key, "user-agent": USER_AGENT },
    signal
  });
  const data = await jsonResponse(response, "Brave", signal);
  const rows = data?.web?.results;
  return (Array.isArray(rows) ? rows : []).map((item) => source(item?.url, item?.title, item?.description, item?.age, "Brave")).filter(Boolean);
}

async function serpApiSearch(query, limit, key, signal) {
  const url = new URL("https://serpapi.com/search.json");
  url.searchParams.set("q", query);
  url.searchParams.set("num", String(limit));
  url.searchParams.set("api_key", key);
  const response = await fetch(url, { headers: { "user-agent": USER_AGENT }, signal });
  const data = await jsonResponse(response, "SerpApi", signal);
  return (Array.isArray(data?.organic_results) ? data.organic_results : []).map((item) => source(item?.link, item?.title, item?.snippet, item?.date, "SerpApi")).filter(Boolean);
}

export function rankProviderIds(ids, stats = new Map()) {
  const maxCapacity = Math.max(...ids.map((id) => PROVIDER_META[id]?.capacity ?? 1), 1);
  const fastest = Math.min(...ids.map((id) => stats.get(id)?.latencyMs ?? PROVIDER_META[id]?.latencyMs ?? 1000), 1000);
  return [...ids].sort((left, right) => {
    const score = (id) => {
      const meta = PROVIDER_META[id] ?? { capacity: 1, latencyMs: 1000 };
      const observed = stats.get(id);
      const used = observed?.uses ?? 0;
      const remaining = Math.max(meta.capacity - used, meta.capacity * 0.05);
      const capacityScore = Math.log1p(remaining) / Math.log1p(maxCapacity);
      const latency = observed?.latencyMs ?? meta.latencyMs;
      const speedScore = fastest / Math.max(latency, 1);
      return (capacityScore + speedScore) / 2;
    };
    return score(right) - score(left);
  });
}

function cooldownMsFor(error) {
  const message = String(error?.message ?? "").toLowerCase();
  if (message.includes("429")) return 10 * 60 * 1000;
  if (message.includes("402") || /quota|credit|billing|limit exceeded/.test(message)) return 6 * 60 * 60 * 1000;
  if (message.includes("401") || message.includes("403")) return 60 * 60 * 1000;
  return 60 * 1000;
}

export function rrfMerge(lists, maxResults) {
  const merged = new Map();
  lists.forEach((list) => list.forEach((item, index) => {
    const key = canonicalUrl(item.url);
    const existing = merged.get(key);
    const score = 1 / (RRF_K + index + 1);
    if (existing) {
      existing.score += score;
      if (!existing.item.snippet && item.snippet) existing.item.snippet = item.snippet;
      if (!existing.item.title && item.title) existing.item.title = item.title;
    } else {
      merged.set(key, { item: { ...item, url: key }, score });
    }
  }));
  return [...merged.values()].sort((a, b) => b.score - a.score).slice(0, maxResults).map((entry) => entry.item);
}

export class MultiSearchProvider {
  constructor(resolveOptions) {
    this.resolveOptions = resolveOptions;
    this.cooldowns = new Map();
    this.stats = new Map();
    for (const [id, meta] of Object.entries(PROVIDER_META)) this.stats.set(id, { latencyMs: meta.latencyMs, uses: 0 });
  }

  available() {
    const options = this.resolveOptions();
    return positiveInt(options.timeoutMs) && positiveInt(options.maxResultsPerProvider);
  }

  async search(request, signal) {
    const options = this.resolveOptions();
    if (!this.available()) throw new WebError("Multi-search provider is not configured", "WEB_PROVIDER_UNAVAILABLE");
    throwIfAborted(signal);
    const credentials = options.credentials;
    const refs = options.refs;
    const keys = {};
    if (credentials?.resolve) {
      await Promise.all(Object.entries(refs).map(async ([id, ref]) => {
        try {
          const resolved = await credentials.resolve(ref);
          if (resolved?.value) keys[id] = resolved.value;
        } catch {}
      }));
    }
    const maxResults = request.maxResults ?? 8;
    const limit = Math.max(options.maxResultsPerProvider, maxResults);
    const jobs = [["parallel", (jobSignal) => parallelSearch(request.query, limit, jobSignal)]];
    const keyedIds = rankProviderIds(KEYED_PROVIDER_ORDER.filter((id) => keys[id]), this.stats);
    for (const id of keyedIds) {
      if (id === "tavily") jobs.push([id, (jobSignal) => tavilySearch(request.query, limit, keys.tavily, jobSignal)]);
      if (id === "exa") jobs.push([id, (jobSignal) => exaSearch(request.query, limit, keys.exa, jobSignal)]);
      if (id === "serper") jobs.push([id, (jobSignal) => serperSearch(request.query, limit, keys.serper, jobSignal)]);
      if (id === "brave") jobs.push([id, (jobSignal) => braveSearch(request.query, limit, keys.brave, jobSignal)]);
      if (id === "serpapi") jobs.push([id, (jobSignal) => serpApiSearch(request.query, limit, keys.serpapi, jobSignal)]);
    }
    const lists = [];
    const failures = [];
    let uniqueCount = 0;
    for (const [id, run] of jobs) {
      const cooldownUntil = this.cooldowns.get(id) ?? 0;
      if (cooldownUntil > Date.now()) {
        failures.push(`${PROVIDER_META[id]?.label ?? "Parallel"}: cooldown`);
        continue;
      }
      const timed = withTimeout(signal, options.timeoutMs);
      const started = Date.now();
      try {
        const list = await run(timed.signal);
        lists.push(list);
        const previous = this.stats.get(id) ?? { latencyMs: Date.now() - started, uses: 0 };
        previous.latencyMs = Math.round(previous.latencyMs * 0.7 + (Date.now() - started) * 0.3);
        previous.uses += 1;
        this.stats.set(id, previous);
        uniqueCount = new Set(lists.flat().map((item) => canonicalUrl(item.url))).size;
        if (uniqueCount >= maxResults) break;
      } catch (error) {
        failures.push(PROVIDER_META[id]?.label ?? "Parallel");
        this.cooldowns.set(id, Date.now() + cooldownMsFor(error));
      } finally {
        timed.dispose();
      }
    }
    throwIfAborted(signal);
    const sources = rrfMerge(lists, maxResults);
    if (sources.length === 0) throw new WebError(`All web search providers failed: ${failures.join(", ")}`, "WEB_PROVIDER_ERROR");
    return { sources, truncated: uniqueCount > maxResults };
  }
}

export function apply(ctx, config) {
  config ??= {};
  const refs = {
    tavily: config.tavilyApiKeyEnv ?? "TAVILY_API_KEY",
    exa: config.exaApiKeyEnv ?? "EXA_API_KEY",
    serper: config.serperApiKeyEnv ?? "SERPER_API_KEY",
    brave: config.braveApiKeyEnv ?? "BRAVE_SEARCH_API_KEY",
    serpapi: config.serpapiApiKeyEnv ?? "SERPAPI_API_KEY"
  };
  const resolveOptions = () => ({
    credentials: ctx.get("credentials"),
    refs,
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxResultsPerProvider: config.maxResultsPerProvider ?? DEFAULT_MAX_RESULTS_PER_PROVIDER
  });
  const provider = new MultiSearchProvider(resolveOptions);
  ctx.web.registerSearchProvider({
    id: MULTI_SEARCH_PROVIDER_ID,
    available: () => provider.available(),
    search: (request, signal) => provider.search(request, signal)
  });
}

export default { name, inject, Config, apply };
