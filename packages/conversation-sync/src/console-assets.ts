import { readFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ASSETS: Record<string, string> = {
  "index.html": "text/html; charset=utf-8", "app.js": "text/javascript; charset=utf-8",
  "app.css": "text/css; charset=utf-8", "icon.svg": "image/svg+xml", "mark.svg": "image/svg+xml",
  LICENSE: "text/plain; charset=utf-8", "NOTICE.md": "text/plain; charset=utf-8",
};
/** Fixed asset names only; URL paths never become arbitrary filesystem paths. */
export function serveConsole(url: URL, res: ServerResponse): boolean {
  const path = url.pathname;
  if (path === "/app" || path === "/console") {
    res.writeHead(302, { location: `/app/${url.search}`, "cache-control": "no-cache" });
    res.end();
    return true;
  }
  const name = path === "/" || path === "/app/" ? "index.html" : path.startsWith("/app/") ? path.slice(5) : path.slice(1);
  if (!Object.hasOwn(ASSETS, name)) return false;
  const body = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "console", name));
  res.writeHead(200, { "content-type": ASSETS[name], "content-length": body.length,
    "cache-control": "no-cache", "x-content-type-options": "nosniff" });
  res.end(body);
  return true;
}
