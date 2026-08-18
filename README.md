# dsh-web-search-router

A free multi-provider web search router for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/DeepSeek-Harness).

The plugin keeps DSH's built-in `web_search` tool and registers a `multi-search`
provider. It starts with the keyless Parallel endpoint, then falls back through
configured search APIs only when more results are needed or a provider fails.

## Features

- Keyless Parallel search as the first route.
- Optional Tavily, Exa, Brave Search, Serper, and SerpApi fallbacks.
- Dynamic fallback order balancing estimated free capacity and observed latency.
- Live Tavily and SerpApi quota refreshes, plus Brave response-header quotas.
- Early exit as soon as enough unique results have been collected.
- URL canonicalization, deduplication, and reciprocal rank fusion (RRF).
- Provider cooldowns after rate-limit, quota, authentication, or transient errors.
- Write-only API key controls in the DSH Settings page.
- No dependency on the paid DeepSeek web search provider.

## Routing

Each request follows this sequence:

1. Query Parallel without an API key.
2. Stop immediately if enough unique results were returned.
3. Rank configured keyed providers by remaining estimated free capacity and
   exponentially weighted observed latency.
4. Query one provider at a time and stop as soon as the requested result count
   is reached.
5. Deduplicate and merge all collected results with RRF.

The initial keyed-provider estimates currently favor Tavily, Exa, Brave Search,
Serper, and SerpApi according to the capacity/latency score. Runtime measurements
can change that order automatically.

Before entering the keyed fallback chain, the router refreshes Tavily and
SerpApi account usage when their ten-minute cache has expired. Brave quota is
learned from the normal search response headers without an extra request. Exa
and Serper currently use process-local estimates because they do not expose a
documented public balance endpoint. A provider with a known zero balance is
skipped until its usage snapshot changes.

Cooldowns are 10 minutes for HTTP 429, 6 hours for quota or credit exhaustion,
1 hour for authentication failures, and 1 minute for other transient failures.
These are process-local health hints, not live quota counters.

## Installation

From the DSH web profile directory, install the GitHub repository:

```bash
cd ~/.dsh/profiles/web
pnpm add github:chenyuhao0628/dsh-web-search-router
```

Add `dsh-web-search-router` to `dsh.profile.bundles` in that profile's
`package.json`, then restart DSH. Select `multi-search` as the web search provider
if it is not already selected.

For local development, a link dependency also works:

```json
{
  "dependencies": {
    "dsh-web-search-router": "link:/absolute/path/to/dsh-web-search-router"
  }
}
```

## API Keys

Open DSH Settings and choose **网络搜索**. Each field writes directly to DSH's
credential service and never reads the stored secret back into the page.
The same page shows live, response-header, estimated, and cooldown states. Use
**刷新额度** to force a new Tavily and SerpApi account-usage check.

| Provider | Credential reference | Required |
| --- | --- | --- |
| Parallel | None | No |
| Tavily | `TAVILY_API_KEY` | No |
| Exa | `EXA_API_KEY` | No |
| Brave Search | `BRAVE_SEARCH_API_KEY` | No |
| Serper | `SERPER_API_KEY` | No |
| SerpApi | `SERPAPI_API_KEY` | No |

API keys are not stored in Cordis configuration or this repository. Do not put
credentials in `package.json`, commits, issue reports, or screenshots.
The browser status endpoint receives only normalized quota metadata; third-party
account payloads and resolved credential values never cross that boundary.

## Development

Requires Node.js 20 or newer and pnpm.

```bash
pnpm install
pnpm check
pnpm test
```

The tests cover URL normalization, RRF merging, and provider ranking. The plugin
targets the Cordis and DSH web APIs declared in `peerDependencies`.

## License

MIT
