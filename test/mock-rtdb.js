// Test-only stand-in for Firebase RTDB's REST surface. Never shipped.
import http from "node:http";

const clone = v => (v === null || typeof v !== "object" ? v : JSON.parse(JSON.stringify(v)));
const segs = p => p.split("/").filter(Boolean);

export function startMock({ port = 0 } = {}) {
  let tree = {};
  let rev = 0;
  const streams = new Set();

  const read = path => {
    let n = tree;
    for (const s of segs(path)) {
      if (n === null || typeof n !== "object" || !(s in n)) return null;
      n = n[s];
    }
    return n === undefined ? null : n;
  };

  // Firebase has no empty containers: a node whose children all went away goes too.
  const prune = () => {
    const walk = n => {
      if (n === null || typeof n !== "object") return n;
      for (const k of Object.keys(n)) {
        const v = walk(n[k]);
        if (v === null || (typeof v === "object" && Object.keys(v).length === 0)) delete n[k];
        else n[k] = v;
      }
      return n;
    };
    walk(tree);
  };

  const emit = (path, merge) => {
    const abs = "/" + segs(path).join("/");
    for (const s of streams) {
      const root = "/" + segs(s.path).join("/");
      if (abs !== root && !abs.startsWith(root === "/" ? "/" : root + "/")) continue;
      const rel = abs === root ? "/" : abs.slice(root.length) || "/";
      s.send(merge ? "patch" : "put", { path: rel, data: read(path) });
    }
  };

  const write = (path, val, merge) => {
    const parts = segs(path);
    if (!parts.length) {
      tree = merge ? Object.assign(tree, clone(val)) : (clone(val) ?? {});
    } else {
      let n = tree;
      for (const s of parts.slice(0, -1)) {
        if (n[s] === null || typeof n[s] !== "object") n[s] = {};
        n = n[s];
      }
      const last = parts[parts.length - 1];
      if (val === null) delete n[last];
      else if (merge && n[last] && typeof n[last] === "object") Object.assign(n[last], clone(val));
      else n[last] = clone(val);
    }
    prune();
    rev++;
    emit(path, merge);
  };

  const etagOf = path => '"' + rev + ":" + JSON.stringify(read(path)).length + '"';

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    if (!url.pathname.endsWith(".json")) { res.writeHead(404).end(); return; }
    const path = url.pathname.slice(0, -5);
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,PUT,PATCH,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Expose-Headers": "ETag",
    };
    if (req.method === "OPTIONS") { res.writeHead(204, cors).end(); return; }

    if (req.method === "GET" && (req.headers.accept || "").includes("text/event-stream")) {
      res.writeHead(200, {
        ...cors,
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      const s = {
        path,
        send: (event, data) => res.write("event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n"),
      };
      streams.add(s);
      s.send("put", { path: "/", data: read(path) });
      req.on("close", () => streams.delete(s));
      return;
    }

    let body = "";
    for await (const c of req) body += c;

    if (req.method === "GET") {
      const h = { ...cors, "Content-Type": "application/json" };
      if (String(req.headers["x-firebase-etag"]) === "true") h.ETag = etagOf(path);
      res.writeHead(200, h).end(JSON.stringify(read(path)));
      return;
    }

    const ifMatch = req.headers["if-match"];
    if (ifMatch && ifMatch !== "*" && ifMatch !== etagOf(path)) {
      res.writeHead(412, cors).end('{"error":"mismatch"}');
      return;
    }

    if (req.method === "PUT") write(path, JSON.parse(body || "null"), false);
    else if (req.method === "PATCH") write(path, JSON.parse(body || "null"), true);
    else if (req.method === "DELETE") write(path, null, false);
    else { res.writeHead(405, cors).end(); return; }

    res.writeHead(200, { ...cors, "Content-Type": "application/json" }).end(body || "null");
  });

  return new Promise(resolve => {
    server.listen(port, "127.0.0.1", () => {
      resolve({
        url: "http://127.0.0.1:" + server.address().port,
        tree: () => clone(tree),
        close: () => new Promise(r => {
          for (const s of streams) { try { s.send("cancel", {}); } catch (e) {} }
          streams.clear();
          server.close(r);
        }),
      });
    });
  });
}
