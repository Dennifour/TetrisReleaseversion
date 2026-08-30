// Test-only static server: the page needs a real origin for EventSource.
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

export function startServe({ root, port = 0 }) {
  const server = http.createServer(async (req, res) => {
    const rel = decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/+/, "");
    const file = path.resolve(root, rel);
    if (!file.startsWith(path.resolve(root))) { res.writeHead(403).end(); return; }
    try {
      const buf = await readFile(file);
      res.writeHead(200, {
        "Content-Type": TYPES[path.extname(file)] || "application/octet-stream",
      }).end(buf);
    } catch { res.writeHead(404).end(); }
  });
  return new Promise(resolve => {
    server.listen(port, "127.0.0.1", () => resolve({
      url: "http://127.0.0.1:" + server.address().port,
      close: () => new Promise(r => server.close(r)),
    }));
  });
}
