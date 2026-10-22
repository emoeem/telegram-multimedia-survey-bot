/**
 * 后台浏览器验收共用的桩服务：静态发 `admin/dist`，并把后台用到的几个接口
 * 固定成可预测的数据。
 *
 * 抽出来的原因很实际：`admin-batch-bc-check.mjs` 与 `admin-chart-check.mjs`
 * 需要完全相同的报告列表与仪表盘数字，否则「同一个页面」在两份脚本里给出
 * 不同截图，比对就没有意义。两份各自维护一份桩，是最容易悄悄漂移的那种重复。
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";

const DIST = join(process.cwd(), "admin", "dist");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
};

const delivery = (id, status, extra = {}) => ({
  id,
  deliveryId: `d-${id}`,
  responseId: 100 + id,
  surveyId: 7,
  surveyTitle: `测试问卷 ${id}`,
  status,
  attempts: status === "failed" ? 3 : 1,
  lastError: status === "failed" ? "Bad Request: chat not found" : null,
  deliveredAt: status === "delivered" ? "2026-10-22T09:00:00Z" : null,
  updatedAt:
    status === "delivering"
      ? new Date(Date.now() - 24 * 60000).toISOString() // 已卡 24 分钟
      : new Date(Date.now() - 60000).toISOString(),
  ...extra,
});

export const ITEMS = [
  delivery(1, "failed"),
  delivery(2, "failed"),
  delivery(3, "delivering"),
  delivery(4, "pending"),
  delivery(5, "delivered"),
];

export const dashboard = {
  users: 933,
  surveys: 88,
  publishedSurveys: 87,
  responses: 2070,
  todayResponses: 47,
  reportDeliveries: { pending: 0, delivering: 0, delivered: 230, failed: 0 },
  recentSurveys: [{ id: 7, title: "情景大尺度剧情（学校社团）", status: "published", updatedAt: "2026-10-22T08:48:00Z" }],
  recentResponses: [
    {
      id: 101,
      surveyId: 7,
      title: "情景大尺度剧情（学校社团）",
      respondent: { firstName: "阿", lastName: "七", username: null, telegramUserId: 1000000000039 },
      participantKey: null,
      updatedAt: "2026-10-22T09:59:00Z",
    },
  ],
  recentActions: [{ id: 1, action: "survey.publish", entityType: "survey", entityId: 7, createdAt: "2026-10-22T08:48:00Z" }],
};

export const pack = {
  version: 1,
  themes: [
    {
      id: "worker",
      name: "打工人执业认证",
      cardLabel: "执业资格证",
      issuer: "认证中心",
      subtitle: "CERTIFICATE OF EMPLOYMENT",
      sealText: "专用章",
      palette: { primary: "#1e3a8a", primary2: "#2563eb", accent: "#f59e0b", ink: "#0f172a", muted: "#64748b", paper: "#f7f9fc" },
      tags: ["摸鱼时长超标"],
      groups: [{ name: "职场日常", emoji: "💼", tags: ["摸鱼时长超标"] }],
      ranks: [
        { min: 0, max: 33, name: "青铜" },
        { min: 34, max: 100, name: "王者" },
      ],
    },
  ],
};

/**
 * @returns {Promise<{origin: string, requests: string[], state: {lastPut: unknown}, close: () => void}>}
 */
export async function startAdminStub() {
  const requests = [];
  const state = { lastPut: null };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    requests.push(`${req.method} ${url.pathname}${url.search}`);

    const json = (body) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };

    if (url.pathname === "/health") return json({ ok: true, environment: "test" });
    if (url.pathname === "/api/admin/session") return json({ ok: true, role: "admin" });
    if (url.pathname === "/api/admin/deployment") return json({ ok: true, licenseCenter: false });
    if (url.pathname === "/api/admin/dashboard") return json(dashboard);

    if (url.pathname === "/api/admin/report-deliveries" && req.method === "GET") {
      const status = url.searchParams.get("status") ?? "";
      const items = status ? ITEMS.filter((item) => item.status === status) : ITEMS;
      return json({
        items,
        page: 1,
        pageSize: 20,
        total: items.length,
        totalPages: 1,
        statusSummary: { pending: 1, delivering: 1, delivered: 1, failed: 2 },
      });
    }

    if (/^\/api\/admin\/report-deliveries\/\d+\/retry$/.test(url.pathname) && req.method === "POST") {
      return json({ ok: true });
    }

    if (url.pathname === "/api/admin/cert-content") {
      if (req.method === "PUT") {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        state.lastPut = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        return json({ ok: true, pack: state.lastPut });
      }
      return json({ ok: true, pack });
    }

    if (url.pathname.startsWith("/api/")) return json({ ok: true });

    let filePath = url.pathname;
    if (!extname(filePath)) filePath = "/index.html";
    try {
      const body = await readFile(join(DIST, filePath));
      res.writeHead(200, { "content-type": MIME[extname(filePath)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      const body = await readFile(join(DIST, "index.html"));
      res.writeHead(200, { "content-type": MIME[".html"] });
      res.end(body);
    }
  });

  const port = await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });

  return { origin: `http://127.0.0.1:${port}`, requests, state, close: () => server.close() };
}
