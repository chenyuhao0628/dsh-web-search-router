import test from "node:test";
import assert from "node:assert/strict";
import {
  canonicalUrl,
  MultiSearchProvider,
  parseBraveQuota,
  parseSerpApiUsage,
  parseTavilyUsage,
  rankProviderIds,
  rrfMerge
} from "../lib/index.js";

test("canonicalUrl removes tracking parameters and fragments", () => {
  assert.equal(
    canonicalUrl("https://example.com/page?utm_source=x&id=4#part"),
    "https://example.com/page?id=4"
  );
});

test("rrfMerge deduplicates and rewards agreement between providers", () => {
  const result = rrfMerge([
    [
      { url: "https://a.example/", title: "A" },
      { url: "https://b.example/", title: "B" }
    ],
    [
      { url: "https://b.example/?utm_source=test", title: "B again", snippet: "match" },
      { url: "https://c.example/", title: "C" }
    ]
  ], 3);
  assert.deepEqual(result.map((item) => item.url), [
    "https://b.example/",
    "https://a.example/",
    "https://c.example/"
  ]);
  assert.equal(result[0].snippet, "match");
});

test("provider ranking blends estimated capacity and observed latency", () => {
  assert.deepEqual(rankProviderIds(["tavily", "exa", "brave", "serpapi"]), [
    "tavily",
    "brave",
    "exa",
    "serpapi"
  ]);
});

test("usage parsers expose only normalized quota fields", () => {
  const tavily = parseTavilyUsage({
    key: { usage: 125, limit: null },
    account: { plan_usage: 125, plan_limit: 1000 }
  });
  assert.equal(typeof tavily.updatedAt, "number");
  assert.deepEqual({ ...tavily, updatedAt: 0 }, {
    remaining: 875,
    limit: 1000,
    source: "live",
    updatedAt: 0
  });
  const serpApi = parseSerpApiUsage({
    api_key: "must-not-leak",
    total_searches_left: 200,
    this_month_usage: 50
  });
  assert.equal(serpApi.remaining, 200);
  assert.equal(serpApi.limit, 250);
  assert.equal(JSON.stringify(serpApi).includes("must-not-leak"), false);
  assert.deepEqual(parseBraveQuota(new Headers({
    "x-ratelimit-limit": "1, 2000",
    "x-ratelimit-remaining": "0, 1742",
    "x-ratelimit-policy": "1;w=1, 2000;w=2592000"
  })).remaining, 1742);
});

test("live remaining quota participates in provider ranking", () => {
  const stats = new Map([
    ["tavily", { latencyMs: 900, uses: 0, quota: { remaining: 10, limit: 1000 } }],
    ["exa", { latencyMs: 1400, uses: 0, quota: { remaining: 1200, limit: 1400 } }]
  ]);
  assert.deepEqual(rankProviderIds(["tavily", "exa"], stats), ["exa", "tavily"]);
});

test("status output never exposes resolved credential values", async () => {
  const provider = new MultiSearchProvider(() => ({
    credentials: { resolve: async () => ({ value: "secret-test-key" }) },
    refs: { tavily: "TAVILY_API_KEY" },
    timeoutMs: 1000,
    maxResultsPerProvider: 8,
    usageRefreshMs: 60000
  }));
  const status = await provider.status(false);
  assert.equal(status.providers.find((item) => item.id === "tavily").configured, true);
  assert.equal(JSON.stringify(status).includes("secret-test-key"), false);
});

test("cascade stops after Parallel supplies enough results", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const results = Array.from({ length: 8 }, (_, index) => ({
      url: `https://example.com/${index}`,
      title: `Result ${index}`,
      excerpts: [`Snippet ${index}`]
    }));
    return new Response(JSON.stringify({
      result: { content: [{ type: "text", text: JSON.stringify({ results }) }] }
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const provider = new MultiSearchProvider(() => ({
      credentials: { resolve: async () => ({ value: "test-key" }) },
      refs: { tavily: "TAVILY_API_KEY", exa: "EXA_API_KEY" },
      timeoutMs: 1000,
      maxResultsPerProvider: 8,
      usageRefreshMs: 60000
    }));
    const result = await provider.search({ query: "test", maxResults: 8 });
    assert.equal(result.sources.length, 8);
    assert.equal(calls.length, 1);
    assert.match(calls[0], /search\.parallel\.ai/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("cascade falls back to the highest-ranked keyed provider and then stops", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes("search.parallel.ai")) {
      return new Response(JSON.stringify({ error: "unavailable" }), {
        status: 503,
        headers: { "content-type": "application/json" }
      });
    }
    if (String(url).endsWith("/usage")) {
      return new Response(JSON.stringify({ key: { usage: 200, limit: 1000 } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    const results = Array.from({ length: 8 }, (_, index) => ({
      url: `https://fallback.example/${index}`,
      title: `Fallback ${index}`,
      content: `Snippet ${index}`
    }));
    return new Response(JSON.stringify({ results }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  try {
    const provider = new MultiSearchProvider(() => ({
      credentials: { resolve: async () => ({ value: "test-key" }) },
      refs: {
        tavily: "TAVILY_API_KEY",
        exa: "EXA_API_KEY"
      },
      timeoutMs: 1000,
      maxResultsPerProvider: 8,
      usageRefreshMs: 60000
    }));
    const result = await provider.search({ query: "test", maxResults: 8 });
    assert.equal(result.sources.length, 8);
    assert.equal(calls.length, 3);
    assert.match(calls[0], /search\.parallel\.ai/);
    assert.match(calls[1], /api\.tavily\.com\/usage/);
    assert.match(calls[2], /api\.tavily\.com\/search/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
