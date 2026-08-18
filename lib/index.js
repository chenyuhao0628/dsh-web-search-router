import z from "@deepseek-ai/schemastery";
import { WebError } from "@deepseek-ai/dsh-web";

export const name = "web-search-router";
export const inject = ["web", "webServer"];
export const MULTI_SEARCH_PROVIDER_ID = "multi-search";

const USER_AGENT = "dsh-web-search-router/0.2.0";
const PARALLEL_URL = "https://search.parallel.ai/mcp";
const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_MAX_RESULTS_PER_PROVIDER = 8;
const DEFAULT_USAGE_REFRESH_MS = 10 * 60 * 1000;
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
  usageRefreshMs: z.number().step(1).min(60000).default(DEFAULT_USAGE_REFRESH_MS),
  tavilyApiKeyEnv: z.string().default("TAVILY_API_KEY"),
  exaApiKeyEnv: z.string().default("EXA_API_KEY"),
  serperApiKeyEnv: z.string().default("SERPER_API_KEY"),
  braveApiKeyEnv: z.string().default("BRAVE_SEARCH_API_KEY"),
  serpapiApiKeyEnv: z.string().default("SERPAPI_API_KEY")
});

function positiveInt(value) {
  return Number.isInteger(value) && value > 0;
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function quotaRecord(remaining, limit, source, resetAt) {
  const safeRemaining = finiteNumber(remaining);
  const safeLimit = finiteNumber(limit);
  if (safeRemaining === null || safeLimit === null || safeLimit <= 0) return null;
  const quota = {
    remaining: Math.max(0, safeRemaining),
    limit: safeLimit,
    source,
    updatedAt: Date.now()
  };
  if (typeof resetAt === "string" && resetAt) quota.resetAt = resetAt;
  return quota;
}

function numberAt(data, paths) {
  for (const path of paths) {
    let value = data;
    for (const key of path) value = value?.[key];
    const number = finiteNumber(value);
    if (number !== null) return number;
  }
  return null;
}

export function parseTavilyUsage(data) {
  const keyUsage = numberAt(data, [["key", "usage"], ["api_key", "usage"], ["usage", "current"], ["usage"]]);
  const keyLimit = numberAt(data, [["key", "limit"], ["api_key", "limit"], ["usage", "limit"], ["limit"]]);
  if (keyUsage !== null && keyLimit !== null) return quotaRecord(keyLimit - keyUsage, keyLimit, "live");
  const planUsage = numberAt(data, [["account", "plan_usage"], ["account", "usage"], ["credits", "used"]]);
  const planLimit = numberAt(data, [["account", "plan_limit"], ["account", "limit"], ["credits", "limit"]]);
  if (planUsage !== null && planLimit !== null) return quotaRecord(planLimit - planUsage, planLimit, "live");
  return null;
}

export function parseSerpApiUsage(data) {
  const remaining = finiteNumber(data?.total_searches_left ?? data?.plan_searches_left);
  const used = finiteNumber(data?.this_month_usage);
  const planLimit = finiteNumber(data?.searches_per_month);
  const limit = used !== null && remaining !== null ? used + remaining : planLimit;
  return quotaRecord(remaining, limit, "live", data?.plan_monthly_usage_reset_at);
}

function headerNumbers(headers, name) {
  return String(headers.get(name) ?? "").split(",").map((value) => finiteNumber(value.trim())).filter((value) => value !== null);
}

export function parseBraveQuota(headers) {
  const limits = headerNumbers(headers, "x-ratelimit-limit");
  const remaining = headerNumbers(headers, "x-ratelimit-remaining");
  if (!limits.length || !remaining.length) return null;
  const policies = String(headers.get("x-ratelimit-policy") ?? "").split(",").map((entry) => {
    const match = entry.match(/;\s*w=(\d+)/i);
    return match ? Number(match[1]) : 0;
  });
  const count = Math.min(limits.length, remaining.length);
  let index = count - 1;
  if (policies.length >= count) {
    index = policies.slice(0, count).reduce((best, window, candidate) => window > policies[best] ? candidate : best, 0);
  }
  return quotaRecord(remaining[index], limits[index], "response-header");
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

async function tavilyUsage(key, signal) {
  const response = await fetch("https://api.tavily.com/usage", {
    headers: { authorization: `Bearer ${key}`, "user-agent": USER_AGENT },
    signal
  });
  return parseTavilyUsage(await jsonResponse(response, "Tavily usage", signal));
}

async function serpApiUsage(key, signal) {
  const url = new URL("https://serpapi.com/account.json");
  url.searchParams.set("api_key", key);
  const response = await fetch(url, { headers: { "user-agent": USER_AGENT }, signal });
  return parseSerpApiUsage(await jsonResponse(response, "SerpApi usage", signal));
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
  return {
    results: (Array.isArray(rows) ? rows : []).map((item) => source(item?.url, item?.title, item?.description, item?.age, "Brave")).filter(Boolean),
    quota: parseBraveQuota(response.headers)
  };
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
  const remainingFor = (id) => {
    const meta = PROVIDER_META[id] ?? { capacity: 1 };
    const observed = stats.get(id);
    if (observed?.quota && observed.quota.remaining >= 0) return observed.quota.remaining;
    return Math.max(meta.capacity - (observed?.uses ?? 0), meta.capacity * 0.05);
  };
  const maxCapacity = Math.max(...ids.map(remainingFor), 1);
  const fastest = Math.min(...ids.map((id) => stats.get(id)?.latencyMs ?? PROVIDER_META[id]?.latencyMs ?? 1000), 1000);
  return [...ids].sort((left, right) => {
    const score = (id) => {
      const meta = PROVIDER_META[id] ?? { latencyMs: 1000 };
      const observed = stats.get(id);
      const remaining = remainingFor(id);
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
    return positiveInt(options.timeoutMs) && positiveInt(options.maxResultsPerProvider) && positiveInt(options.usageRefreshMs ?? DEFAULT_USAGE_REFRESH_MS);
  }

  async resolveKeys(options = this.resolveOptions()) {
    const keys = {};
    if (!options.credentials?.resolve) return keys;
    await Promise.all(Object.entries(options.refs).map(async ([id, ref]) => {
      try {
        const resolved = await options.credentials.resolve(ref);
        if (resolved?.value) keys[id] = resolved.value;
      } catch {}
    }));
    return keys;
  }

  setQuota(id, quota) {
    if (!quota) return;
    const previous = this.stats.get(id) ?? { latencyMs: PROVIDER_META[id]?.latencyMs ?? 1000, uses: 0 };
    previous.quota = quota;
    previous.usageError = false;
    this.stats.set(id, previous);
  }

  decrementQuota(id) {
    const observed = this.stats.get(id);
    if (!observed?.quota || observed.quota.remaining <= 0) return;
    observed.quota = { ...observed.quota, remaining: Math.max(0, observed.quota.remaining - 1) };
  }

  async refreshUsage(keys, signal, force = false) {
    const options = this.resolveOptions();
    const refreshMs = options.usageRefreshMs ?? DEFAULT_USAGE_REFRESH_MS;
    const jobs = [];
    for (const id of ["tavily", "serpapi"]) {
      if (!keys[id]) continue;
      const observed = this.stats.get(id);
      if (!force && observed?.quota && Date.now() - observed.quota.updatedAt < refreshMs) continue;
      jobs.push((async () => {
        const timed = withTimeout(signal, options.timeoutMs);
        try {
          const quota = id === "tavily"
            ? await tavilyUsage(keys[id], timed.signal)
            : await serpApiUsage(keys[id], timed.signal);
          if (!quota) throw new Error(`${id} usage response does not contain a supported quota shape`);
          this.setQuota(id, quota);
        } catch {
          const current = this.stats.get(id);
          if (current) current.usageError = true;
        } finally {
          timed.dispose();
        }
      })());
    }
    await Promise.all(jobs);
  }

  quotaAvailable(id) {
    const quota = this.stats.get(id)?.quota;
    return !quota || quota.remaining > 0;
  }

  async status(forceRefresh = false, signal) {
    const options = this.resolveOptions();
    const keys = await this.resolveKeys(options);
    if (forceRefresh) await this.refreshUsage(keys, signal, true);
    const rows = [{
      id: "parallel",
      label: "Parallel",
      configured: true,
      quota: { source: "unknown" },
      cooldownUntil: this.cooldowns.get("parallel") ?? 0
    }];
    for (const id of KEYED_PROVIDER_ORDER) {
      const meta = PROVIDER_META[id];
      const observed = this.stats.get(id) ?? { latencyMs: meta.latencyMs, uses: 0 };
      let quota = null;
      if (keys[id]) {
        quota = observed.quota
          ? { ...observed.quota }
          : {
              remaining: Math.max(0, meta.capacity - observed.uses),
              limit: meta.capacity,
              source: "estimate",
              updatedAt: Date.now()
            };
      }
      rows.push({
        id,
        label: meta.label,
        configured: Boolean(keys[id]),
        latencyMs: observed.latencyMs,
        quota,
        usageError: Boolean(observed.usageError),
        cooldownUntil: this.cooldowns.get(id) ?? 0
      });
    }
    return { providers: rows, refreshedAt: Date.now() };
  }

  async search(request, signal) {
    const options = this.resolveOptions();
    if (!this.available()) throw new WebError("Multi-search provider is not configured", "WEB_PROVIDER_UNAVAILABLE");
    throwIfAborted(signal);
    const keys = await this.resolveKeys(options);
    const maxResults = request.maxResults ?? 8;
    const limit = Math.max(options.maxResultsPerProvider, maxResults);
    const lists = [];
    const failures = [];
    let uniqueCount = 0;

    const runJob = async (id, run) => {
      const cooldownUntil = this.cooldowns.get(id) ?? 0;
      if (cooldownUntil > Date.now()) {
        failures.push(`${PROVIDER_META[id]?.label ?? "Parallel"}: cooldown`);
        return;
      }
      const timed = withTimeout(signal, options.timeoutMs);
      const started = Date.now();
      try {
        const output = await run(timed.signal);
        const list = Array.isArray(output) ? output : output.results;
        lists.push(list);
        const previous = this.stats.get(id) ?? { latencyMs: Date.now() - started, uses: 0 };
        previous.latencyMs = Math.round(previous.latencyMs * 0.7 + (Date.now() - started) * 0.3);
        previous.uses += 1;
        this.stats.set(id, previous);
        if (output?.quota) this.setQuota(id, output.quota);
        else if (id !== "parallel") this.decrementQuota(id);
        uniqueCount = new Set(lists.flat().map((item) => canonicalUrl(item.url))).size;
      } catch (error) {
        failures.push(PROVIDER_META[id]?.label ?? "Parallel");
        this.cooldowns.set(id, Date.now() + cooldownMsFor(error));
      } finally {
        timed.dispose();
      }
    };

    await runJob("parallel", (jobSignal) => parallelSearch(request.query, limit, jobSignal));
    if (uniqueCount < maxResults) {
      await this.refreshUsage(keys, signal);
      const keyedIds = rankProviderIds(
        KEYED_PROVIDER_ORDER.filter((id) => keys[id] && this.quotaAvailable(id)),
        this.stats
      );
      for (const id of keyedIds) {
        if (id === "tavily") await runJob(id, (jobSignal) => tavilySearch(request.query, limit, keys.tavily, jobSignal));
        if (id === "exa") await runJob(id, (jobSignal) => exaSearch(request.query, limit, keys.exa, jobSignal));
        if (id === "serper") await runJob(id, (jobSignal) => serperSearch(request.query, limit, keys.serper, jobSignal));
        if (id === "brave") await runJob(id, (jobSignal) => braveSearch(request.query, limit, keys.brave, jobSignal));
        if (id === "serpapi") await runJob(id, (jobSignal) => serpApiSearch(request.query, limit, keys.serpapi, jobSignal));
        if (uniqueCount >= maxResults) break;
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
    maxResultsPerProvider: config.maxResultsPerProvider ?? DEFAULT_MAX_RESULTS_PER_PROVIDER,
    usageRefreshMs: config.usageRefreshMs ?? DEFAULT_USAGE_REFRESH_MS
  });
  const provider = new MultiSearchProvider(resolveOptions);
  ctx.web.registerSearchProvider({
    id: MULTI_SEARCH_PROVIDER_ID,
    available: () => provider.available(),
    search: (request, signal) => provider.search(request, signal)
  });
  const statusHandler = async (req, res) => {
    if ((req.method ?? "GET").toUpperCase() !== "GET") {
      res.writeHead(405, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "method not allowed" }));
      return;
    }
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const status = await provider.status(url.searchParams.get("refresh") === "1");
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store"
      });
      res.end(JSON.stringify({ ok: true, ...status }));
    } catch {
      res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "usage status unavailable" }));
    }
  };
  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/api/web-search-router/status",
    handler: statusHandler
  }));
}

export default { name, inject, Config, apply };
