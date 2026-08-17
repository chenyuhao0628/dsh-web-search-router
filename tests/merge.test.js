import test from "node:test";
import assert from "node:assert/strict";
import { canonicalUrl, MultiSearchProvider, rankProviderIds, rrfMerge } from "../lib/index.js";

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
      maxResultsPerProvider: 8
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
        exa: "EXA_API_KEY",
        brave: "BRAVE_SEARCH_API_KEY",
        serpapi: "SERPAPI_API_KEY"
      },
      timeoutMs: 1000,
      maxResultsPerProvider: 8
    }));
    const result = await provider.search({ query: "test", maxResults: 8 });
    assert.equal(result.sources.length, 8);
    assert.equal(calls.length, 2);
    assert.match(calls[0], /search\.parallel\.ai/);
    assert.match(calls[1], /api\.tavily\.com/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
