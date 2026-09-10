// Minimal static server for the docs build (adapter-static, SPA fallback).
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";

const ROOT = new URL("./build/", import.meta.url).pathname;
const PORT = Number(process.env.PORT || 5180);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".manifest": "application/manifest+json",
};

createServer(async (req, res) => {
  try {
    let urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
    if (urlPath === "/") urlPath = "/index.html";
    let filePath = normalize(join(ROOT, urlPath));
    // Prevent path traversal outside ROOT.
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
    if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
      // SPA fallback: serve index.html for client-side routes.
      filePath = join(ROOT, "index.html");
    }
    const type = MIME[extname(filePath)] || "application/octet-stream";
    // Hashed immutable assets under /_app/immutable/ are safe to cache forever
    // (their filename changes on every build). HTML and the OAuth metadata JSON
    // must always be revalidated so the browser never mixes a stale shell with
    // newly-hashed assets — that mismatch is what surfaces as "Unable to
    // preload CSS" / "error loading dynamically imported module" after a deploy.
    const isShell = urlPath.endsWith(".html") || urlPath.endsWith(".json");
    const cacheControl = isShell
      ? "no-cache"
      : "public, max-age=31536000, immutable";
    res.writeHead(200, {
      "Content-Type": type,
      "Cache-Control": cacheControl,
    });
    createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(500);
    res.end("Internal Server Error");
  }
}).listen(PORT, () => {
  console.log(`app-lite static server on :${PORT} (${ROOT})`);
});
