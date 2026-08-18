window.__ModuleLoader__.load({
  id: "dsh-web-search-router",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    const React = require("react");

    const STYLE_ID = "dsh-web-search-router-style";
    const CSS = [
      ".cyh-search-page{max-width:760px;color:var(--dsw-alias-label-primary);font-size:13px;}",
      ".cyh-search-page h2{margin:0 0 8px;font-size:18px;font-weight:600;}",
      ".cyh-search-intro{margin:0 0 16px;color:var(--dsw-alias-label-tertiary);line-height:1.55;}",
      ".cyh-search-card{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:14px 16px;margin:0 0 10px;background:var(--dsw-alias-bg-layer-1);}",
      ".cyh-search-row{display:flex;align-items:center;gap:10px;min-width:0;}",
      ".cyh-search-name{font-weight:600;flex:1;min-width:0;}",
      ".cyh-search-state{font-size:12px;color:var(--dsw-alias-label-tertiary);}",
      ".cyh-search-state.ok{color:var(--dsw-alias-state-success-primary);}",
      ".cyh-search-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:0 0 14px;}",
      ".cyh-search-updated{color:var(--dsw-alias-label-tertiary);font-size:12px;min-width:0;}",
      ".cyh-search-quota{margin:7px 0 0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.45;}",
      ".cyh-search-field{display:flex;gap:8px;margin-top:12px;}",
      ".cyh-search-input{flex:1;min-width:0;height:34px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);padding:0 10px;font:inherit;}",
      ".cyh-search-input:focus{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px;}",
      ".cyh-search-btn{height:34px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);padding:0 12px;font:inherit;cursor:pointer;white-space:nowrap;}",
      ".cyh-search-btn:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary);}",
      ".cyh-search-btn:disabled{opacity:.5;cursor:default;}",
      ".cyh-search-note{margin:8px 0 0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.45;}",
      ".cyh-search-error{margin:0 0 12px;color:var(--dsw-alias-state-error-primary);}",
      ".cyh-search-footer{margin-top:16px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5;}"
    ].join("");

    function ensureStyle() {
      if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = CSS;
      document.head.appendChild(style);
    }

    const SOURCES = [
      { id: "parallel", name: "Parallel", ref: null, note: "默认启用，无需 API Key。" },
      { id: "tavily", name: "Tavily", ref: "TAVILY_API_KEY", note: "用于通用网页和 AI 研究搜索。" },
      { id: "exa", name: "Exa", ref: "EXA_API_KEY", note: "适合语义搜索、技术资料和论文。" },
      { id: "serper", name: "Serper", ref: "SERPER_API_KEY", note: "Google 结果补充源。" },
      { id: "brave", name: "Brave Search", ref: "BRAVE_SEARCH_API_KEY", note: "独立索引补充源。" },
      { id: "serpapi", name: "SerpApi", ref: "SERPAPI_API_KEY", note: "Google 结果备用源。" }
    ];

    function messageOf(error) {
      return error && typeof error.message === "string" ? error.message : String(error);
    }

    function quotaText(source, usage) {
      if (source.id === "parallel") return "匿名免费入口，账户额度未知。";
      if (!usage?.configured) return "配置密钥后可参与后备路由。";
      if (usage.cooldownUntil > Date.now()) return "当前处于冷却期，将暂时跳过。";
      const quota = usage.quota;
      if (!quota || typeof quota.remaining !== "number") return "额度未知，将按本地容量估算排序。";
      const prefix = quota.source === "estimate" ? "本地估算" : quota.source === "response-header" ? "响应头额度" : "实时额度";
      const latency = typeof usage.latencyMs === "number" ? ` · ${usage.latencyMs} ms` : "";
      const warning = usage.usageError ? " · 本次刷新失败，沿用缓存" : "";
      return `${prefix}：剩余 ${Math.floor(quota.remaining)} / ${Math.floor(quota.limit)}${latency}${warning}`;
    }

    function SearchCard({ source, status, usage, onSave, onRemove, busy }) {
      const [draft, setDraft] = React.useState("");
      const isParallel = source.ref === null;
      return React.createElement("div", { className: "cyh-search-card" },
        React.createElement("div", { className: "cyh-search-row" },
          React.createElement("div", { className: "cyh-search-name" }, source.name),
          React.createElement("div", { className: `cyh-search-state${status?.configured ? " ok" : ""}` },
            isParallel ? "可用" : status?.configured ? "已配置" : "未配置"
          )
        ),
        React.createElement("p", { className: "cyh-search-note" }, source.note),
        React.createElement("p", { className: "cyh-search-quota" }, quotaText(source, usage)),
        isParallel ? null : React.createElement("div", { className: "cyh-search-field" },
          React.createElement("input", {
            className: "cyh-search-input",
            type: "password",
            value: draft,
            "aria-label": `${source.name} API Key`,
            placeholder: status?.configured ? "已配置，留空保持不变" : "粘贴 API Key",
            autoComplete: "new-password",
            onChange: (event) => setDraft(event.target.value),
            disabled: busy
          }),
          React.createElement("button", {
            className: "cyh-search-btn",
            type: "button",
            "aria-label": `保存 ${source.name} API Key`,
            disabled: busy || draft.trim().length === 0,
            onClick: async () => {
              const ok = await onSave(source.ref, draft.trim());
              if (ok) setDraft("");
            }
          }, busy ? "保存中…" : "保存"),
          status?.configured ? React.createElement("button", {
            className: "cyh-search-btn",
            type: "button",
            "aria-label": `清除 ${source.name} API Key`,
            disabled: busy || status?.writable === false,
            onClick: () => onRemove(source.ref)
          }, "清除") : null
        )
      );
    }

    function SearchSettingsPage({ api }) {
      const [statuses, setStatuses] = React.useState({});
      const [usageStatuses, setUsageStatuses] = React.useState({});
      const [refreshedAt, setRefreshedAt] = React.useState(null);
      const [busy, setBusy] = React.useState(null);
      const [error, setError] = React.useState(null);

      const load = React.useCallback(async (refreshUsage = false) => {
        const refs = SOURCES.filter((source) => source.ref).map((source) => source.ref);
        try {
          const [response, usageResponse] = await Promise.all([
            api.credentials.describe({ refs }),
            fetch(`/api/web-search-router/status${refreshUsage ? "?refresh=1" : ""}`, { cache: "no-store" })
          ]);
          if (!response.result.ok) throw new Error(response.result.error.message);
          if (!usageResponse.ok) throw new Error("无法读取额度状态");
          const usageData = await usageResponse.json();
          if (!usageData.ok) throw new Error(usageData.error || "无法读取额度状态");
          setStatuses(response.result.value.credentials || {});
          setUsageStatuses(Object.fromEntries((usageData.providers || []).map((provider) => [provider.id, provider])));
          setRefreshedAt(usageData.refreshedAt || Date.now());
        } catch (cause) {
          setError(messageOf(cause));
        }
      }, [api]);

      React.useEffect(() => { load(true); }, [load]);

      async function save(ref, value) {
        setBusy(ref);
        setError(null);
        try {
          const response = await api.credentials.set({ ref, value });
          if (!response.result.ok) throw new Error(response.result.error.message);
          await load(true);
          return true;
        } catch (cause) {
          setError(messageOf(cause));
          return false;
        } finally {
          setBusy(null);
        }
      }

      async function remove(ref) {
        setBusy(ref);
        setError(null);
        try {
          const response = await api.credentials.unset({ ref });
          if (!response.result.ok) throw new Error(response.result.error.message);
          await load(false);
        } catch (cause) {
          setError(messageOf(cause));
        } finally {
          setBusy(null);
        }
      }

      return React.createElement("div", { className: "cyh-search-page" },
        React.createElement("h2", null, "网络搜索"),
        React.createElement("p", { className: "cyh-search-intro" }, "管理级联网页搜索。Parallel 优先；只有结果不足或服务失败时，才按额度容量与响应速度综合排序调用下一个服务。密钥只写入 DSH 凭据存储，保存后不会回显。"),
        React.createElement("div", { className: "cyh-search-toolbar" },
          React.createElement("span", { className: "cyh-search-updated" }, refreshedAt ? `额度状态更新于 ${new Date(refreshedAt).toLocaleTimeString()}` : "正在读取额度状态"),
          React.createElement("button", {
            className: "cyh-search-btn",
            type: "button",
            disabled: busy !== null,
            onClick: async () => {
              setBusy("__refresh__");
              setError(null);
              try { await load(true); } finally { setBusy(null); }
            }
          }, busy === "__refresh__" ? "刷新中…" : "刷新额度")
        ),
        error ? React.createElement("p", { className: "cyh-search-error", role: "alert" }, error) : null,
        SOURCES.map((source) => React.createElement(SearchCard, {
          key: source.id,
          source,
          status: source.ref ? statuses[source.ref] : { configured: true },
          usage: usageStatuses[source.id],
          busy: busy === source.ref,
          onSave: save,
          onRemove: remove
        })),
        React.createElement("p", { className: "cyh-search-footer" }, "同一次搜索不会消耗所有账号额度。额度错误会进入冷却期；重复 URL 会去重并按多源排名合并。")
      );
    }

    const inject = ["slots", "connection"];

    function apply(ctx) {
      ensureStyle();
      ctx.effect(() => () => document.getElementById(STYLE_ID)?.remove(), "multi-search settings styles");
      const api = ctx.get("connection")?.api;
      if (!api?.credentials) return;
      ctx.slots.inject("settings.section", () => ctx.slots.register(
        { name: "settings.section", id: "web-search-router", order: 25, label: () => "网络搜索" },
        () => React.createElement(SearchSettingsPage, { api })
      ));
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
