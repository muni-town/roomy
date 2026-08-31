// Minimal static server for the storybook-static build (Storybook 9 output).
// Mirrors packages/app-lite/serve-static.mjs (same MIME/security approach),
// minus the SPA fallback — Storybook has no client-side routes, so unknown
// paths 404 instead of masking the error.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";

const ROOT = new URL("./storybook-static/", import.meta.url).pathname;
const PORT = Number(process.env.PORT || 3000);

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
};

const server = createServer(async (req, res) => {
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
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const type = MIME[extname(filePath)] || "application/octet-stream";
    // Hashed immutable assets (/assets/*) cache forever; HTML must revalidate
    // so a stale shell never mixes with newly-hashed assets.
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
    res.end("Internal server error");
  }
});

server.listen(PORT, "0.0.0.0", () => {
  process.stdout.write(`storybook-static server on port ${PORT}\n`);
});
