/**
 * Minimal static server for the Playwright visual QA suite. Serves the built
 * admin/dist and maps /s/* to survey.html (the survey entry) so the Web Survey
 * app can be exercised offline; every /api/* request is intercepted by the
 * tests themselves.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, normalize, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../admin/dist", import.meta.url));
const fixturesRoot = fileURLToPath(new URL("../qa/fixtures", import.meta.url));
const port = Number(process.env.PORT ?? 4173);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".json": "application/json",
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = decodeURIComponent(url.pathname);
    const base = pathname.startsWith("/fixtures/") ? fixturesRoot : root;
    const relative = pathname.startsWith("/s/")
      ? "/survey.html"
      : pathname === "/"
        ? "/index.html"
        : pathname.startsWith("/fixtures/")
          ? pathname.slice("/fixtures".length)
          : pathname;
    const safe = normalize(join(base, relative));
    if (!safe.startsWith(base + sep)) {
      res.writeHead(403);
      res.end("forbidden");
      return;
    }
    let body;
    try {
      body = await readFile(safe);
    } catch {
      // SPA fallback: extension-less app routes (/admin/*) must serve the
      // admin entry, or the visual suite screenshots a bare 404 page.
      if (!extname(pathname) && !pathname.startsWith("/fixtures/")) {
        try {
          body = await readFile(join(root, "index.html"));
          res.writeHead(200, { "content-type": MIME[".html"], "cache-control": "no-store" });
          res.end(body);
          return;
        } catch {
          // fall through to 404
        }
      }
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200, {
      "content-type": MIME[extname(safe)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(body);
  } catch (error) {
    res.writeHead(500);
    res.end(String(error));
  }
});

server.listen(port, () => {
  console.log(`visual QA server on http://127.0.0.1:${port}`);
});
