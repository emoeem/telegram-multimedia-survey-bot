(() => {
  "use strict";

  const e = React.createElement;
  const { useState, useEffect, useCallback } = React;

  const NAV_ITEMS = [
    { id: "dashboard", icon: "📊", label: "总览" },
    { id: "surveys", icon: "📝", label: "问卷" },
    { id: "responses", icon: "📥", label: "答卷" },
    { id: "analytics", icon: "📈", label: "统计" },
    { id: "templates", icon: "🎨", label: "结果模板" },
    { id: "users", icon: "👥", label: "用户" },
    { id: "settings", icon: "⚙️", label: "设置" },
  ];
  const STATUS_OPTIONS = ["draft", "published", "closed", "archived"];
  const STATUS_LABELS = { draft: "草稿", published: "已发布", closed: "已关闭", archived: "已归档" };
  const SEARCH_DEBOUNCE_MS = 300;

  const webApp = window.Telegram && window.Telegram.WebApp;
  const initData = (webApp && webApp.initData) || "";
  if (webApp) {
    try {
      webApp.ready();
      webApp.expand();
      if (webApp.setHeaderColor) webApp.setHeaderColor("#111827");
    } catch (error) {
      /* older Telegram clients may not support these calls */
    }
  }

  function authHeaders() {
    return {
      // initData contains non-ASCII characters (e.g. Chinese first names) which
      // are not valid in header values, so it must be percent-encoded.
      "x-telegram-init-data": initData ? encodeURIComponent(initData) : "",
      "x-telegram-user-id": localStorage.getItem("telegramUserId") || "",
    };
  }

  async function api(path) {
    const response = await fetch(path, { headers: authHeaders() });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.message || "请求失败");
      error.status = response.status;
      throw error;
    }
    return data;
  }

  function formatDateTime(value) {
    if (!value) return "-";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    const pad = (part) => String(part).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function StatusBadge({ status }) {
    const known = Object.prototype.hasOwnProperty.call(STATUS_LABELS, status);
    return e("span", { className: "badge badge-" + (known ? status : "unknown") },
      known ? STATUS_LABELS[status] : (status || "-"));
  }

  function SkeletonPanel({ lines = 4 }) {
    const widths = ["40%", "90%", "75%", "85%"];
    return e("section", { className: "panel" },
      e("div", { className: "skeleton skeleton-title" }),
      Array.from({ length: lines }, (_, index) =>
        e("div", { className: "skeleton skeleton-line", key: index, style: { width: widths[index % widths.length] } })));
  }

  function ErrorPanel({ error, onRetry }) {
    const title = error.status === 401 ? "请通过 Telegram 打开管理后台"
      : error.status === 403 ? "403 无权访问"
      : error.status === 404 ? "数据不存在"
      : "加载失败";
    const hint = error.status === 401
      ? "管理后台需要通过 Telegram 身份验证后访问。"
      : (error.message && error.message !== title ? error.message : "");
    return e("section", { className: "panel" },
      e("h2", null, title),
      hint ? e("p", { className: "muted" }, hint) : null,
      e("div", { className: "state-actions" },
        e("button", { className: "btn", onClick: onRetry }, "重试")));
  }

  function EmptyPanel({ icon = "📝", text, actionLabel, onAction }) {
    return e("div", { className: "empty" },
      e("div", { style: { fontSize: "32px", marginBottom: "8px" } }, icon),
      e("div", null, text),
      actionLabel
        ? e("div", { className: "state-actions" },
            e("button", { className: "btn", onClick: onAction }, actionLabel))
        : null);
  }

  // Staging-only identity simulation: /health reports environment=development
  // on staging and local dev, and the x-telegram-user-id fallback is only
  // accepted server-side in those environments.
  function TestBanner({ onIdentityChange }) {
    const [value, setValue] = useState(localStorage.getItem("telegramUserId") || "");
    const [applied, setApplied] = useState(localStorage.getItem("telegramUserId") || "");
    const apply = () => {
      const trimmed = value.trim();
      if (!/^\d+$/.test(trimmed)) return;
      localStorage.setItem("telegramUserId", trimmed);
      setApplied(trimmed);
      onIdentityChange();
    };
    const clear = () => {
      localStorage.removeItem("telegramUserId");
      setValue("");
      setApplied("");
      onIdentityChange();
    };
    return e("div", { className: "test-banner" },
      e("span", { className: "tag" }, "STAGING"),
      e("span", null, "测试身份（仅 Staging / 本地环境可用）"),
      e("input", {
        type: "text",
        inputMode: "numeric",
        placeholder: "Telegram 用户 ID",
        value,
        onChange: (event) => setValue(event.target.value),
        onKeyDown: (event) => { if (event.key === "Enter") apply(); },
      }),
      e("button", { className: "btn", onClick: apply }, "应用"),
      applied
        ? e("button", { className: "btn", onClick: clear }, "清除（当前 " + applied + "）")
        : null);
  }

  function Dashboard({ data }) {
    if (!data) return e(SkeletonPanel, { lines: 6 });
    const metrics = [
      ["users", "用户数量"],
      ["surveys", "问卷数量"],
      ["publishedSurveys", "已发布问卷"],
      ["responses", "答卷数量"],
    ];
    const recentSurveys = data.recentSurveys || [];
    const recentResponses = data.recentResponses || [];
    return e(React.Fragment, null,
      e("div", { className: "cards" },
        metrics.map(([key, label]) => e("div", { className: "card", key: key },
          e("div", { className: "muted" }, label),
          e("div", { className: "metric" }, data[key] || 0)))),
      e("section", { className: "panel" },
        e("h2", null, "最近问卷"),
        recentSurveys.length
          ? e("div", { className: "table-wrap" },
              e("table", null,
                e("tbody", null,
                  recentSurveys.map((item) => e("tr", {
                    key: item.id,
                    onClick: () => { location.href = "/admin/surveys/" + item.id; },
                  },
                    e("td", null, e("strong", null, item.title || "未命名问卷")),
                    e("td", null, e(StatusBadge, { status: item.status })),
                    e("td", null, formatDateTime(item.updatedAt)))))))
          : e(EmptyPanel, { text: "还没有问卷" })),
      recentResponses.length
        ? e("section", { className: "panel" },
            e("h2", null, "最近答卷"),
            e("div", { className: "table-wrap" },
              e("table", null,
                e("tbody", null,
                  recentResponses.map((item) => e("tr", { key: item.id },
                    e("td", null, e("strong", null, item.title || "问卷 " + item.surveyId)),
                    e("td", null, item.status || "-"),
                    e("td", null, formatDateTime(item.updatedAt))))))))
        : null);
  }

  function Surveys({ data, searchInput, status, onSearchInput, onStatus, onClearFilters }) {
    if (!data) return e(SkeletonPanel, { lines: 5 });
    const rows = data.items || [];
    const hasFilters = searchInput.trim() !== "" || status !== "";
    const openDetail = (id) => { location.href = "/admin/surveys/" + id; };

    const surveyRows = rows.map((item) => e("tr", { key: item.id, onClick: () => openDetail(item.id) },
      e("td", null, e("strong", null, item.title || "未命名问卷")),
      e("td", null, e(StatusBadge, { status: item.status })),
      e("td", null, item.questionCount + " 题"),
      e("td", null, item.responseCount + " 答卷"),
      e("td", null, formatDateTime(item.updatedAt))));

    const headerRow = e("tr", null,
      e("th", null, "标题"),
      e("th", null, "状态"),
      e("th", null, "题目"),
      e("th", null, "答卷"),
      e("th", null, "更新时间"));

    const surveyTable = e("table", null,
      e("thead", null, headerRow),
      e("tbody", null, surveyRows));

    const surveyCards = rows.map((item) => e("div", { className: "survey-card", key: item.id, onClick: () => openDetail(item.id) },
      e("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px" } },
        e("strong", null, item.title || "未命名问卷"),
        e(StatusBadge, { status: item.status })),
      e("div", { className: "muted", style: { marginTop: "8px" } },
        item.questionCount + " 题 · " + item.responseCount + " 答卷 · " + formatDateTime(item.updatedAt))));

    let listContent;
    if (rows.length) {
      listContent = [
        e("div", { className: "table-wrap", key: "table" }, surveyTable),
        e("div", { className: "survey-cards", key: "cards" }, surveyCards),
      ];
    } else if (hasFilters) {
      listContent = e(EmptyPanel, { text: "没有符合条件的问卷", actionLabel: "清除筛选", onAction: onClearFilters });
    } else {
      listContent = e(EmptyPanel, { text: "还没有问卷" });
    }

    return e("section", { className: "panel" },
      e("div", { className: "toolbar" },
        e("input", {
          type: "text",
          value: searchInput,
          placeholder: "搜索问卷…",
          onChange: (event) => onSearchInput(event.target.value),
        }),
        e("select", { value: status, onChange: (event) => onStatus(event.target.value) },
          e("option", { value: "" }, "全部状态"),
          STATUS_OPTIONS.map((value) => e("option", { value: value, key: value }, STATUS_LABELS[value])))),
      listContent);
  }

  function Detail({ data }) {
    if (!data) return e(SkeletonPanel, { lines: 6 });
    const owner = data.firstName || data.username || data.owner_id || "-";
    const fields = [
      ["状态", e(StatusBadge, { status: data.status })],
      ["创建者", owner],
      ["题目数量", (data.questionCount ?? 0) + " 题"],
      ["答卷数量", (data.responseCount ?? 0) + " 答卷（完成 " + (data.completedCount ?? 0) + " 份）"],
      ["创建时间", formatDateTime(data.created_at)],
      ["更新时间", formatDateTime(data.updated_at)],
      ["公开状态", data.status === "published" ? "公开" : "未公开"],
      ["密码保护", data.access_code ? "已启用" : "未启用"],
    ];
    return e("section", { className: "panel" },
      e("h2", null, data.title || "未命名问卷"),
      data.description ? e("p", { className: "muted" }, data.description) : null,
      e("div", { className: "cards" },
        fields.map(([label, value]) => e("div", { className: "card", key: label },
          e("div", { className: "muted" }, label),
          e("div", { style: { marginTop: "6px", fontWeight: 600 } }, value)))),
      e("p", { style: { marginTop: "24px" } },
        e("button", { className: "btn", onClick: () => { location.href = "/admin/surveys"; } }, "← 返回问卷")));
  }

  function App() {
    const detailMatch = location.pathname.match(/\/admin\/surveys\/(\d+)/);
    const detailId = detailMatch ? detailMatch[1] : null;
    const [tab, setTab] = useState(detailId || location.pathname.includes("/surveys") ? "surveys" : "dashboard");
    const [data, setData] = useState(null);
    const [error, setError] = useState(null);
    const [drawer, setDrawer] = useState(false);
    const [searchInput, setSearchInput] = useState("");
    const [search, setSearch] = useState("");
    const [status, setStatus] = useState("");
    const [reloadKey, setReloadKey] = useState(0);
    const [environment, setEnvironment] = useState(null);

    useEffect(() => {
      fetch("/health")
        .then((response) => response.json())
        .then((body) => setEnvironment(body.environment || null))
        .catch(() => setEnvironment(null));
    }, []);

    useEffect(() => {
      const timer = setTimeout(() => setSearch(searchInput.trim()), SEARCH_DEBOUNCE_MS);
      return () => clearTimeout(timer);
    }, [searchInput]);

    useEffect(() => {
      let cancelled = false;
      setData(null);
      setError(null);
      const query = new URLSearchParams({ search, status });
      const path = detailId
        ? "/api/admin/surveys/" + detailId
        : tab === "dashboard"
          ? "/api/admin/dashboard"
          : "/api/admin/surveys?" + query;
      api(path)
        .then((result) => { if (!cancelled) setData(result); })
        .catch((requestError) => { if (!cancelled) setError(requestError); });
      return () => { cancelled = true; };
    }, [tab, search, status, detailId, reloadKey]);

    useEffect(() => {
      if (!drawer) return undefined;
      document.body.style.overflow = "hidden";
      const onKeyDown = (event) => { if (event.key === "Escape") setDrawer(false); };
      window.addEventListener("keydown", onKeyDown);
      return () => {
        document.body.style.overflow = "";
        window.removeEventListener("keydown", onKeyDown);
      };
    }, [drawer]);

    const retry = useCallback(() => setReloadKey((key) => key + 1), []);
    const clearFilters = useCallback(() => { setSearchInput(""); setStatus(""); }, []);
    const showTestBanner = environment === "development" && !initData;
    const title = detailId ? "问卷详情"
      : (NAV_ITEMS.find((item) => item.id === tab) || NAV_ITEMS[0]).label;

    const navButtons = NAV_ITEMS.map((item) => e("button", {
      key: item.id,
      className: tab === item.id && !detailId ? "active" : "",
      onClick: () => {
        setDrawer(false);
        location.href = item.id === "surveys" ? "/admin/surveys" : "/admin";
      },
    },
      e("span", { className: "nav-icon" }, item.icon),
      e("span", { className: "nav-label" }, item.label)));

    let content;
    if (error) {
      content = e(ErrorPanel, { error, onRetry: retry });
    } else if (detailId) {
      content = e(Detail, { data });
    } else if (tab === "dashboard") {
      content = e(Dashboard, { data });
    } else if (tab === "surveys") {
      content = e(Surveys, {
        data,
        searchInput,
        status,
        onSearchInput: setSearchInput,
        onStatus: setStatus,
        onClearFilters: clearFilters,
      });
    } else {
      content = e("section", { className: "panel" }, "敬请期待");
    }

    return e(React.Fragment, null,
      showTestBanner ? e(TestBanner, { onIdentityChange: retry }) : null,
      e("div", { className: "shell" },
        e("aside", { className: "sidebar" + (drawer ? " open" : "") },
          e("div", { className: "brand" }, "问卷管理后台"),
          e("nav", null, navButtons)),
        drawer ? e("div", { className: "backdrop", onClick: () => setDrawer(false) }) : null,
        e("main", null,
          e("header", null,
            e("button", { className: "menu", "aria-label": "打开菜单", onClick: () => setDrawer(!drawer) }, "☰"),
            e("h1", null, title)),
          content)));
  }

  ReactDOM.createRoot(document.getElementById("root")).render(e(App));
})();
