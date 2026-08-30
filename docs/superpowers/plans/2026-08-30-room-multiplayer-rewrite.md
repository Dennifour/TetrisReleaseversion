# Room Multiplayer Rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the fire-and-forget, poll-based room multiplayer with a streamed, awaited-write room layer split into four testable units, so that dropped writes are retried rather than lost and a room nobody is in cannot stay listed.

**Architecture:** `Room` (transport + state + lifecycle + rendering in one object) splits into `Sig` (Firebase REST/SSE transport, no game semantics), `RoomState` (pure reducer, the single writer of room state), `RoomClient` (lifecycle, outbox, round management), and `RoomView` (rendering only). Reads become an `EventSource` stream applied to a local replica; writes become awaited with bounded retry, with ETag compare-and-swap for contended values.

**Tech Stack:** Vanilla JS in one HTML file (no build step, no runtime dependencies). Node 22 for the test-only mock server. Playwright for the browser-driven match simulation.

**Spec:** `docs/superpowers/specs/2026-08-30-room-multiplayer-design.md`

## Global Constraints

- Single file `Tetris_version1.html`; no build step; must open from disk. No new runtime dependencies. The Firebase JS SDK is specifically excluded.
- Size budget: 150 KB is pressure, not a gate. Run `ls -l Tetris_version1.html` after each task and note the number in the commit body if it moved more than 2 KB.
- Comments in the shipped file are terse one-liners for the genuinely non-obvious only. Long rationale goes in `CLAUDE.md`, never in the file.
- New tunable constants go with the existing grouped `const`s, not inlined as magic numbers.
- New UI strings go in `I18N` with **both** `en` and `ko` values. Never English-only.
- All user text rendered into the DOM goes through `esc()` (`:2833`).
- Anything off the wire is untrusted: clamp counts, `fitBoard()` peer boards, cap string lengths.
- Wire compatibility with the old protocol is **not** required.
- Everything under `test/` is test-only and never referenced by the shipped file.

**Protocol constants** (add to the constant group that currently holds `ROOM_MS`, `:2463`):

```js
const HB_MS=5000, SEAT_TTL=20000, LOBBY_TTL=20000, SIG_TRIES=4, SIG_BASE_MS=120,
      LEAVE_TIMEOUT_MS=2500, CHAT_KEEP=40, MAX_SEATS=4;
```

**Data model** (verbatim from the spec — every task writes to these paths and no others):

```
/lobby/{id}                   {n, t, c}
/rooms/{id}/meta              {h, r}
/rooms/{id}/seat/{pid}        {n, j, hb, rdy, spec, w}
/rooms/{id}/live/{pid}        {b, p, o}
/rooms/{id}/go                {s, r, at, roster}
/rooms/{id}/gb/{pid}/{msgId}  n
/chat/{id}/{key}              {n, m}
```

---

### Task 1: Mock Firebase RTDB server

The whole plan is verified against this. It must exist and be correct before any protocol code is written.

**Files:**
- Create: `test/mock-rtdb.js`
- Create: `test/mock-rtdb.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `startMock({port}) -> Promise<{url, close(), tree()}>`. `url` is the origin (e.g. `http://127.0.0.1:5001`), `tree()` returns a deep clone of the in-memory data for assertions, `close()` shuts the server and all open streams down.

Firebase semantics this must reproduce: a path maps onto a JSON tree; `GET` returns the subtree or `null`; `PUT` replaces a subtree; `PATCH` merges keys one level deep; a `null` value deletes a key; empty objects do not exist (a node whose children are all removed is itself removed); `GET` with `X-Firebase-ETag: true` returns an `ETag` header; `PUT`/`DELETE` with `if-match` return `412` on mismatch; `GET` with `Accept: text/event-stream` opens a stream that emits an initial `put` of the whole subtree then `put`/`patch` events on every change beneath it.

- [ ] **Step 1: Write the failing test**

Create `test/mock-rtdb.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { startMock } from "./mock-rtdb.js";

test("put, get, patch, delete, and null-pruning", async () => {
  const m = await startMock({ port: 0 });
  const j = async (p, o) => {
    const r = await fetch(m.url + p + ".json", o);
    const t = await r.text();
    return t && t !== "null" ? JSON.parse(t) : null;
  };

  await j("/rooms/A/meta", { method: "PUT", body: JSON.stringify({ h: "p1", r: "attack" }) });
  assert.deepEqual(await j("/rooms/A/meta"), { h: "p1", r: "attack" });

  await j("/rooms/A/meta", { method: "PATCH", body: JSON.stringify({ r: "score" }) });
  assert.deepEqual(await j("/rooms/A/meta"), { h: "p1", r: "score" });

  // a null value deletes the key, and an emptied node stops existing
  await j("/rooms/A/meta", { method: "PATCH", body: JSON.stringify({ h: null, r: null }) });
  assert.equal(await j("/rooms/A/meta"), null);

  await j("/rooms/A", { method: "DELETE" });
  assert.equal(await j("/rooms/A"), null);
  await m.close();
});

test("etag compare-and-swap rejects a stale write with 412", async () => {
  const m = await startMock({ port: 0 });
  await fetch(m.url + "/seat/w.json", { method: "PUT", body: "1" });

  const r1 = await fetch(m.url + "/seat/w.json", { headers: { "X-Firebase-ETag": "true" } });
  const tag = r1.headers.get("etag");
  assert.ok(tag, "GET with X-Firebase-ETag must return an ETag header");

  // somebody else writes first, invalidating our tag
  await fetch(m.url + "/seat/w.json", { method: "PUT", body: "2" });

  const stale = await fetch(m.url + "/seat/w.json", {
    method: "PUT", body: "99", headers: { "if-match": tag }
  });
  assert.equal(stale.status, 412);
  assert.equal(m.tree().seat.w, 2);
  await m.close();
});

test("streams an initial put then patches on change", async () => {
  const m = await startMock({ port: 0 });
  await fetch(m.url + "/rooms/A/meta.json", { method: "PUT", body: JSON.stringify({ h: "p1" }) });

  const res = await fetch(m.url + "/rooms/A.json", { headers: { Accept: "text/event-stream" } });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const nextEvent = async () => {
    while (!buf.includes("\n\n")) buf += dec.decode((await reader.read()).value, { stream: true });
    const raw = buf.slice(0, buf.indexOf("\n\n"));
    buf = buf.slice(buf.indexOf("\n\n") + 2);
    return {
      event: /^event: (.*)$/m.exec(raw)[1],
      data: JSON.parse(/^data: (.*)$/m.exec(raw)[1]),
    };
  };

  const first = await nextEvent();
  assert.equal(first.event, "put");
  assert.equal(first.data.path, "/");
  assert.deepEqual(first.data.data, { meta: { h: "p1" } });

  await fetch(m.url + "/rooms/A/seat/p1.json", { method: "PUT", body: JSON.stringify({ n: "Ada" }) });
  const second = await nextEvent();
  assert.equal(second.event, "put");
  assert.equal(second.data.path, "/seat/p1");
  assert.deepEqual(second.data.data, { n: "Ada" });

  await reader.cancel();
  await m.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd "C:/@Dennifour/Projects/Tetris" && node --test test/mock-rtdb.test.mjs`
Expected: FAIL — `Cannot find module './mock-rtdb.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `test/mock-rtdb.js`:

```js
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

  const write = (path, val, merge) => {
    const parts = segs(path);
    if (!parts.length) { tree = merge ? Object.assign(tree, clone(val)) : (clone(val) ?? {}); }
    else {
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
    emit(path, val, merge);
  };

  const emit = (path, val, merge) => {
    const abs = "/" + segs(path).join("/");
    for (const s of streams) {
      const root = "/" + segs(s.path).join("/");
      if (abs !== root && !abs.startsWith(root === "/" ? "/" : root + "/")) continue;
      const rel = abs === root ? "/" : abs.slice(root.length) || "/";
      s.send(merge ? "patch" : "put", { path: rel, data: read(path) });
    }
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
      res.writeHead(200, { ...cors, "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
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
    if (ifMatch && ifMatch !== etagOf(path)) { res.writeHead(412, cors).end('{"error":"mismatch"}'); return; }

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
        close: () => new Promise(r => { for (const s of streams) s.send("cancel", {}); streams.clear(); server.close(r); }),
      });
    });
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/mock-rtdb.test.mjs`
Expected: PASS, 3/3.

- [ ] **Step 5: Commit**

```bash
git add test/mock-rtdb.js test/mock-rtdb.test.mjs
git commit -m "Add a mock RTDB to verify the room protocol offline"
```

---

### Task 2: Static server and Playwright boot harness

**Files:**
- Create: `test/serve.js`
- Create: `test/harness.mjs`
- Create: `test/boot.test.mjs`

**Interfaces:**
- Consumes: `startMock` from Task 1.
- Produces: `startServe({root,port}) -> Promise<{url, close()}>`; and from `harness.mjs`, `openClients(n, {mockUrl, pageUrl, name}) -> Promise<Client[]>` where `Client = {page, log, name, close()}`. Every client's console output is prefixed with its name and printed, which is the logging the user asked for.

- [ ] **Step 1: Write the failing test**

Create `test/boot.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { startMock } from "./mock-rtdb.js";
import { startServe } from "./serve.js";
import { openClients } from "./harness.mjs";

test("the game boots with the mock configured and no console errors", async () => {
  const mock = await startMock({ port: 0 });
  const serve = await startServe({ root: process.cwd(), port: 0 });
  const [a] = await openClients(1, {
    mockUrl: mock.url,
    pageUrl: serve.url + "/Tetris_version1.html",
    name: "A",
  });

  assert.equal(await a.page.evaluate(() => CFG.fbUrl), mock.url);
  assert.equal(await a.page.evaluate(() => typeof Sig), "object");
  assert.deepEqual(a.errors, []);

  await a.close(); await serve.close(); await mock.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/boot.test.mjs`
Expected: FAIL — `Cannot find module './serve.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `test/serve.js`:

```js
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
      res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" }).end(buf);
    } catch { res.writeHead(404).end(); }
  });
  return new Promise(resolve => {
    server.listen(port, "127.0.0.1", () => resolve({
      url: "http://127.0.0.1:" + server.address().port,
      close: () => new Promise(r => server.close(r)),
    }));
  });
}
```

Create `test/harness.mjs`:

```js
// Drives N browser clients against one mock. Logs progress; takes no screenshots.
import { chromium } from "playwright";

let browser = null;
const stamp = () => new Date().toISOString().slice(11, 23);

export async function openClients(n, { mockUrl, pageUrl, name = "C" }) {
  browser = browser || await chromium.launch();
  const out = [];
  for (let i = 0; i < n; i++) {
    const label = n === 1 ? name : name + (i + 1);
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const errors = [];
    page.on("console", m => {
      if (m.type() === "error") errors.push(m.text());
      console.log(`${stamp()} [${label}] ${m.text()}`);
    });
    page.on("pageerror", e => { errors.push(String(e)); console.log(`${stamp()} [${label}] PAGEERROR ${e}`); });
    // seed the signalling URL before any script runs
    await page.addInitScript(u => localStorage.setItem("tfx:fbUrl", JSON.stringify(u)), mockUrl);
    await page.goto(pageUrl);
    await page.waitForFunction(() => typeof CFG !== "undefined");
    out.push({
      name: label, page, errors,
      log: (...a) => console.log(`${stamp()} [${label}]`, ...a),
      close: () => ctx.close(),
    });
  }
  return out;
}

export async function shutdown() { if (browser) { await browser.close(); browser = null; } }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx playwright install chromium` (once), then `node --test test/boot.test.mjs`
Expected: the `CFG.fbUrl` and `errors` assertions PASS; the `typeof Sig` assertion FAILS with `"undefined"` because `Sig` does not exist yet. **Leave that one failing** — Task 3 makes it pass. Confirm the other two pass before moving on.

- [ ] **Step 5: Commit**

```bash
git add test/serve.js test/harness.mjs test/boot.test.mjs
git commit -m "Add a static server and Playwright harness for match simulation"
```

---

### Task 3: `Sig` — awaited transport with streaming and CAS

**Files:**
- Modify: `Tetris_version1.html` — replace the `FB` object at `:2419-2435`
- Create: `test/sig.test.mjs`

**Interfaces:**
- Consumes: `openClients` (Task 2), `startMock` (Task 1).
- Produces, all reachable by name from `page.evaluate` (top-level `const` in a classic script is visible in the global lexical scope):
  - `Sig.on() -> boolean`
  - `Sig.get(path) -> Promise<any>`
  - `Sig.put(path, val) -> Promise<any>`
  - `Sig.patch(path, val) -> Promise<any>`
  - `Sig.del(path) -> Promise<void>`
  - `Sig.cas(path, fn) -> Promise<any>` — retries on 412 up to `SIG_TRIES`
  - `Sig.stream(path, onEvent) -> {close()}`; `onEvent({type:"put"|"patch", path, data})`

- [ ] **Step 1: Write the failing test**

Create `test/sig.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { startMock } from "./mock-rtdb.js";
import { startServe } from "./serve.js";
import { openClients, shutdown } from "./harness.mjs";

const boot = async () => {
  const mock = await startMock({ port: 0 });
  const serve = await startServe({ root: process.cwd(), port: 0 });
  const [c] = await openClients(1, { mockUrl: mock.url, pageUrl: serve.url + "/Tetris_version1.html", name: "S" });
  return { mock, serve, c, end: async () => { await c.close(); await serve.close(); await mock.close(); } };
};

test("writes are awaited and readable back", async () => {
  const { mock, c, end } = await boot();
  await c.page.evaluate(() => Sig.put("/rooms/A/meta", { h: "p1", r: "attack" }));
  assert.deepEqual(mock.tree().rooms.A.meta, { h: "p1", r: "attack" });
  assert.deepEqual(await c.page.evaluate(() => Sig.get("/rooms/A/meta")), { h: "p1", r: "attack" });
  await end();
});

test("a failed write rejects instead of resolving silently", async () => {
  const { c, end } = await boot();
  const threw = await c.page.evaluate(async () => {
    const keep = CFG.fbUrl;
    CFG.fbUrl = "http://127.0.0.1:1";           // nothing listening
    try { await Sig.put("/x", 1); return false; } catch { return true; } finally { CFG.fbUrl = keep; }
  });
  assert.equal(threw, true, "Sig.put must reject when the write cannot land");
  await end();
});

test("cas serialises concurrent increments without losing one", async () => {
  const { mock, c, end } = await boot();
  await c.page.evaluate(() => Sig.put("/seat/p1/w", 0));
  await c.page.evaluate(() => Promise.all(
    Array.from({ length: 5 }, () => Sig.cas("/seat/p1/w", v => (v | 0) + 1))
  ));
  assert.equal(mock.tree().seat.p1.w, 5, "no increment may be lost");
  await end();
});

test("stream delivers an initial put and then live changes", async () => {
  const { mock, c, end } = await boot();
  await c.page.evaluate(() => Sig.put("/rooms/A/meta", { h: "p1" }));
  await c.page.evaluate(() => {
    window.__ev = [];
    window.__h = Sig.stream("/rooms/A", e => window.__ev.push(e));
  });
  await c.page.waitForFunction(() => window.__ev.length >= 1);
  await fetch(mock.url + "/rooms/A/seat/p2.json", { method: "PUT", body: JSON.stringify({ n: "Bo" }) });
  await c.page.waitForFunction(() => window.__ev.length >= 2);

  const ev = await c.page.evaluate(() => window.__ev);
  assert.equal(ev[0].type, "put");
  assert.deepEqual(ev[0].data, { meta: { h: "p1" } });
  assert.equal(ev[1].path, "/seat/p2");
  assert.deepEqual(ev[1].data, { n: "Bo" });

  await c.page.evaluate(() => window.__h.close());
  await end();
});

test.after(shutdown);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/sig.test.mjs`
Expected: FAIL — `Sig is not defined`.

- [ ] **Step 3: Write minimal implementation**

In `Tetris_version1.html`, replace the whole `FB` object (`:2419-2435`) with `Sig`. Keep the localized error keys (`e_fbnet`, `e_fbauth`) so existing UI error paths still read correctly.

```js
const Sig = {
 base(){ return (CFG.fbUrl||"").trim().replace(/\/+$/,""); },
 on(){ return /^https?:\/\/.+/i.test(this.base()); },
 url(p){ return this.base()+p+".json"; },
 sleep(ms){ return new Promise(r=>setTimeout(r,ms)); },
 // retried and awaited: a lost write is what desynchronised the old room
 async req(path,opt,tries){
  const n=tries==null?SIG_TRIES:tries;
  let last=null;
  for(let i=0;i<n;i++){
   let r;
   try{ r=await fetch(this.url(path),opt); }
   catch(e){ last=new Error(T("e_fbnet")); await this.sleep(SIG_BASE_MS*(1<<i)+rnd(SIG_BASE_MS)); continue; }
   if(r.status===412) return {conflict:true};
   if(r.status===401||r.status===403) throw new Error(T("e_fbauth"));
   if(!r.ok){ last=new Error(T("e_fbnet")); await this.sleep(SIG_BASE_MS*(1<<i)+rnd(SIG_BASE_MS)); continue; }
   const t=await r.text();
   let v=null;
   try{ v = t&&t!=="null" ? JSON.parse(t) : null; }catch(e){ v=null; }
   return {value:v, etag:r.headers.get("etag")};
  }
  throw last||new Error(T("e_fbnet"));
 },
 async get(path){ return (await this.req(path,{cache:"no-store"})).value; },
 async put(path,val){ return (await this.req(path,{method:"PUT",body:JSON.stringify(val)})).value; },
 async patch(path,val){ return (await this.req(path,{method:"PATCH",body:JSON.stringify(val)})).value; },
 async del(path){ await this.req(path,{method:"DELETE",keepalive:true}); },
 // compare-and-swap: win counts were a read-modify-write on a stale snapshot
 async cas(path,fn){
  for(let i=0;i<SIG_TRIES;i++){
   const r=await this.req(path,{cache:"no-store",headers:{"X-Firebase-ETag":"true"}});
   const next=fn(r.value);
   const w=await this.req(path,{method:"PUT",body:JSON.stringify(next),headers:{"if-match":r.etag||"*"}});
   if(!w.conflict) return next;
   await this.sleep(SIG_BASE_MS*(1<<i)+rnd(SIG_BASE_MS));
  }
  throw new Error(T("e_fbnet"));
 },
 stream(path,onEvent){
  let es=null, closed=false, back=0;
  const open=()=>{
   if(closed) return;
   es=new EventSource(this.url(path));
   const on=(type)=>es.addEventListener(type,m=>{
    back=0;
    let d=null;
    try{ d=JSON.parse(m.data); }catch(e){ return; }
    if(d) onEvent({type, path:String(d.path||"/"), data:d.data});
   });
   on("put"); on("patch");
   es.onerror=()=>{ try{ es.close(); }catch(e){} if(closed) return; setTimeout(open,Math.min(4000,SIG_BASE_MS*(1<<back++))); };
  };
  open();
  return { close(){ closed=true; try{ es&&es.close(); }catch(e){} } };
 }
};
```

Then update every remaining `FB.` reference in the file to `Sig.` — `Room.create/join/stop/beat/set/board/mark/pushRule/attack/say/readChat/foldChat/callStart/poll` and `Net.listRooms`. This is a mechanical rename in this task; the call sites are rewritten properly in Tasks 5-7. Confirm none are left: `grep -n "FB\." Tetris_version1.html` must return nothing.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/sig.test.mjs test/boot.test.mjs`
Expected: PASS, all tests including the `typeof Sig` assertion left failing in Task 2.

- [ ] **Step 5: Commit**

```bash
git add Tetris_version1.html test/sig.test.mjs
git commit -m "Replace fire-and-forget FB with awaited, streamed Sig transport"
```

---

### Task 4: `RoomState` — the pure reducer

**Files:**
- Modify: `Tetris_version1.html` — insert after `Sig`, before `Room`
- Create: `test/roomstate.test.mjs`

**Interfaces:**
- Consumes: nothing (no I/O, no DOM, no timers — this is why it is testable alone).
- Produces:
  - `RoomState.make(myPid) -> st`
  - `RoomState.apply(st, ev)` — `ev` is a `Sig.stream` event; the **only** writer of `st.tree`
  - `RoomState.view(st, nowMs) -> {id, host, rule, go, seats, live, me, alive, roster}`
  - `seats` is sorted by `j` then `pid`; each seat is `{pid,n,j,hb,rdy,spec,w,fresh}` with `fresh = nowMs-hb < SEAT_TTL`
  - `roster` is `go.roster` (pid → join stamp) or `null`
  - `RoomState.inRound(view, pid) -> boolean` — true when the roster names that pid at that join stamp
  - `alive` lists in-round seats that have not published a death

- [ ] **Step 1: Write the failing test**

Create `test/roomstate.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { startMock } from "./mock-rtdb.js";
import { startServe } from "./serve.js";
import { openClients, shutdown } from "./harness.mjs";

const boot = async () => {
  const mock = await startMock({ port: 0 });
  const serve = await startServe({ root: process.cwd(), port: 0 });
  const [c] = await openClients(1, { mockUrl: mock.url, pageUrl: serve.url + "/Tetris_version1.html", name: "R" });
  return { c, end: async () => { await c.close(); await serve.close(); await mock.close(); } };
};

test("root put seeds state; child put and patch update in place", async () => {
  const { c, end } = await boot();
  const v = await c.page.evaluate(() => {
    const st = RoomState.make("p1");
    RoomState.apply(st, { type: "put", path: "/", data: {
      meta: { h: "p1", r: "attack" },
      seat: { p1: { n: "Ada", j: 1, hb: 1000 }, p2: { n: "Bo", j: 2, hb: 1000 } },
    }});
    RoomState.apply(st, { type: "put", path: "/seat/p3", data: { n: "Cy", j: 3, hb: 1000 } });
    RoomState.apply(st, { type: "patch", path: "/seat/p1", data: { rdy: true } });
    return RoomState.view(st, 1000);
  });
  assert.equal(v.host, "p1");
  assert.deepEqual(v.seats.map(s => s.pid), ["p1", "p2", "p3"]);
  assert.equal(v.seats[0].rdy, true);
  assert.equal(v.seats[1].n, "Bo");
  await end();
});

test("a null put removes a seat", async () => {
  const { c, end } = await boot();
  const pids = await c.page.evaluate(() => {
    const st = RoomState.make("p1");
    RoomState.apply(st, { type: "put", path: "/", data: { seat: { p1: { j: 1, hb: 9 }, p2: { j: 2, hb: 9 } } } });
    RoomState.apply(st, { type: "put", path: "/seat/p2", data: null });
    return RoomState.view(st, 9).seats.map(s => s.pid);
  });
  assert.deepEqual(pids, ["p1"]);
  await end();
});

test("staleness is reported, and the roster fixes round membership", async () => {
  const { c, end } = await boot();
  const out = await c.page.evaluate(() => {
    const st = RoomState.make("p1");
    RoomState.apply(st, { type: "put", path: "/", data: {
      seat: { p1: { j: 1, hb: 100000 }, p2: { j: 2, hb: 100000 }, p3: { j: 3, hb: 0 } },
      go: { s: 7, r: "attack", at: 5, roster: { p1: 1, p2: 2 } },
    }});
    const v = RoomState.view(st, 100000);
    return {
      fresh: v.seats.filter(s => s.fresh).map(s => s.pid),
      inRound: v.seats.filter(s => RoomState.inRound(v, s.pid)).map(s => s.pid),
      alive: v.alive.map(s => s.pid),
    };
  });
  // p3's heartbeat is ancient
  assert.deepEqual(out.fresh, ["p1", "p2"]);
  // p3 was never in the roster, so it is not in the round even though it has a seat
  assert.deepEqual(out.inRound, ["p1", "p2"]);
  assert.deepEqual(out.alive, ["p1", "p2"]);
  await end();
});

test("a rejoin under the same pid is not a survivor of the frozen roster", async () => {
  const { c, end } = await boot();
  const inRound = await c.page.evaluate(() => {
    const st = RoomState.make("p1");
    RoomState.apply(st, { type: "put", path: "/", data: {
      seat: { p2: { j: 2, hb: 50 } },
      go: { s: 1, r: "attack", at: 5, roster: { p2: 2 } },
    }});
    // p2 left and came back: same pid, new join stamp
    RoomState.apply(st, { type: "put", path: "/seat/p2", data: { j: 99, hb: 50 } });
    const v = RoomState.view(st, 50);
    return RoomState.inRound(v, "p2");
  });
  assert.equal(inRound, false);
  await end();
});

test.after(shutdown);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/roomstate.test.mjs`
Expected: FAIL — `RoomState is not defined`.

- [ ] **Step 3: Write minimal implementation**

Insert into `Tetris_version1.html` directly after the `Sig` object:

```js
// one writer for room state: the old object was mutated from six paths
const RoomState = {
 make(myPid){ return {tree:{}, me:myPid}; },
 apply(st,ev){
  const parts=String(ev.path||"/").split("/").filter(Boolean);
  if(!parts.length){ st.tree = ev.type==="patch" ? Object.assign(st.tree||{},ev.data||{}) : (ev.data||{}); return; }
  let n=st.tree;
  for(const s of parts.slice(0,-1)){ if(!n[s]||typeof n[s]!=="object") n[s]={}; n=n[s]; }
  const last=parts[parts.length-1];
  if(ev.data===null||ev.data===undefined) delete n[last];
  else if(ev.type==="patch" && n[last] && typeof n[last]==="object") Object.assign(n[last],ev.data);
  else n[last]=ev.data;
 },
 view(st,nowMs){
  const t=st.tree||{};
  const meta=t.meta||{}, go=t.go||null, live=t.live||{};
  const seats=Object.keys(t.seat||{}).map(pid=>{
   const r=t.seat[pid]||{};
   return {pid, n:String(r.n||"").slice(0,12)||T("opponent"), j:r.j|0, hb:r.hb|0,
       rdy:!!r.rdy, spec:!!r.spec, w:r.w|0, d:!!(live[pid]&&live[pid].o),
       fresh:(nowMs-(r.hb|0))<SEAT_TTL};
  }).sort((a,b)=>a.j-b.j||(a.pid<b.pid?-1:1));
  const v={id:st.id||null, host:meta.h||null, rule:meta.r==="score"?"score":"attack",
      go, seats, live, roster:(go&&go.roster)||null, me:st.me};
  v.alive=seats.filter(s=>!s.d && this.inRound(v,s.pid));
  return v;
 },
 // the roster is frozen by the host at go time, so every client agrees on it
 inRound(v,pid){
  if(!v.roster) return false;
  const s=v.seats.find(x=>x.pid===pid);
  return !!s && v.roster[pid]===s.j;
 }
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/roomstate.test.mjs`
Expected: PASS, 4/4.

- [ ] **Step 5: Commit**

```bash
git add Tetris_version1.html test/roomstate.test.mjs
git commit -m "Add RoomState, a pure reducer with one writer for room state"
```

---

### Task 5: `RoomClient` lifecycle and the ghost-room guarantees

This is the task that fixes the bug the user reported first.

**Files:**
- Modify: `Tetris_version1.html` — replace `Room` (`:2466-2657`) and `Net.listRooms` (`:2806-2817`)
- Create: `test/lifecycle.test.mjs`

**Interfaces:**
- Consumes: `Sig` (Task 3), `RoomState` (Task 4).
- Produces:
  - `RoomClient.on -> boolean`, `RoomClient.id`, `RoomClient.view()` — current `RoomState.view`
  - `RoomClient.create() -> Promise<id>`
  - `RoomClient.join(id) -> Promise<void>` — throws `T("e_roomfull")` when full, `T("e_noroom")` when absent
  - `RoomClient.leave() -> Promise<void>` — **awaits** its deletes
  - `RoomClient.listRooms() -> Promise<[{id,name,count}]>` — **read-only**, never deletes
  - `RoomClient.isHost() -> boolean`

- [ ] **Step 1: Write the failing test**

Create `test/lifecycle.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { startMock } from "./mock-rtdb.js";
import { startServe } from "./serve.js";
import { openClients, shutdown } from "./harness.mjs";

const boot = async n => {
  const mock = await startMock({ port: 0 });
  const serve = await startServe({ root: process.cwd(), port: 0 });
  const cs = await openClients(n, { mockUrl: mock.url, pageUrl: serve.url + "/Tetris_version1.html", name: "C" });
  return { mock, cs, end: async () => { for (const c of cs) await c.close(); await serve.close(); await mock.close(); } };
};

test("a room you create and leave is gone from the listing", async () => {
  const { mock, cs: [a], end } = await boot(1);
  const id = await a.page.evaluate(() => RoomClient.create());
  a.log("created", id);
  assert.ok(mock.tree().lobby[id], "the room should be listed while occupied");

  await a.page.evaluate(() => RoomClient.leave());
  a.log("left");

  // the reported bug: this listing used to still contain the room
  assert.equal(mock.tree().lobby, undefined, "no lobby entry may survive the last player leaving");
  assert.equal(mock.tree().rooms, undefined, "the room node must go too");
  assert.deepEqual(await a.page.evaluate(() => RoomClient.listRooms()), []);
  await end();
});

test("listing never deletes a room that still has a live player", async () => {
  const { mock, cs: [a, b], end } = await boot(2);
  const id = await a.page.evaluate(() => RoomClient.create());
  // b only ever lists; it must not garbage-collect a's occupied room
  for (let i = 0; i < 3; i++) await b.page.evaluate(() => RoomClient.listRooms());
  assert.ok(mock.tree().rooms[id], "a listing client must not delete an occupied room");
  assert.ok(mock.tree().lobby[id]);
  await end();
});

test("a guest leaving keeps the room; the last one out clears it", async () => {
  const { mock, cs: [a, b], end } = await boot(2);
  const id = await a.page.evaluate(() => RoomClient.create());
  await b.page.evaluate(i => RoomClient.join(i), id);
  await a.page.waitForFunction(() => RoomClient.view().seats.length === 2);

  await b.page.evaluate(() => RoomClient.leave());
  assert.ok(mock.tree().rooms[id], "the room survives while the host is still in it");
  assert.equal(Object.keys(mock.tree().rooms[id].seat).length, 1);

  await a.page.evaluate(() => RoomClient.leave());
  assert.equal(mock.tree().rooms, undefined);
  await end();
});

test("the seat limit holds against simultaneous joins", async () => {
  const { mock, cs, end } = await boot(5);
  const id = await cs[0].page.evaluate(() => RoomClient.create());
  const results = await Promise.all(cs.slice(1).map(c =>
    c.page.evaluate(i => RoomClient.join(i).then(() => "ok", e => e.message), id)
  ));
  const seated = Object.keys(mock.tree().rooms[id].seat).length;
  assert.equal(seated, 4, "MAX_SEATS must hold: " + JSON.stringify(results));
  assert.equal(results.filter(r => r === "ok").length, 3);
  await end();
});

test.after(shutdown);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/lifecycle.test.mjs`
Expected: FAIL — `RoomClient is not defined`.

- [ ] **Step 3: Write minimal implementation**

Replace the `Room` object with `RoomClient`. Delete `Net.listRooms` and point callers at `RoomClient.listRooms`.

```js
let PID="";
const RoomClient = {
 id:null, on:false, st:null, sub:null, hbTimer:null, seen:new Set(), gseq:0, joinedAt:0,
 view(){ return RoomState.view(this.st||RoomState.make(PID), Date.now()); },
 isHost(){ return this.on && this.view().host===PID; },
 path(){ return "/rooms/"+this.id; },
 mine(){ return this.path()+"/seat/"+PID; },
 // read-only: the old listing deleted other people's rooms as a side effect
 async listRooms(){
  if(!Sig.on()) throw new Error(T("e_nofb"));
  const idx=await Sig.get("/lobby")||{};
  const t0=Date.now();
  return Object.keys(idx).filter(id=>t0-((idx[id]||{}).t||0)<LOBBY_TTL)
   .map(id=>({id, name:String((idx[id]||{}).n||"").slice(0,12), count:(idx[id]||{}).c|0}));
 },
 async create(){
  if(!Sig.on()) throw new Error(T("e_nofb"));
  PID=PID||roomId(8);
  const id=roomId(6), t=Date.now();
  NET_RULE="attack";
  await Sig.put("/rooms/"+id,{meta:{h:PID,r:"attack"}, seat:{[PID]:{n:CFG.name,j:t,hb:t,w:0}}});
  await Sig.put("/lobby/"+id,{n:CFG.name,t,c:1});
  this.begin(id,t);
  return id;
 },
 async join(id){
  if(!Sig.on()) throw new Error(T("e_nofb"));
  PID=PID||roomId(8);
  const v=await Sig.get("/rooms/"+id);
  if(!v||!v.meta) throw new Error(T("e_noroom"));
  const t=Date.now();
  // cas on the seat map closes the check-then-act race the old join had
  const seat=await Sig.cas("/rooms/"+id+"/seat",cur=>{
   const m=cur||{};
   const live=Object.keys(m).filter(k=>t-((m[k]||{}).hb||0)<SEAT_TTL);
   if(live.length>=MAX_SEATS && !m[PID]) return m;
   return Object.assign({},m,{[PID]:{n:CFG.name,j:t,hb:t,w:0}});
  });
  if(!seat||!seat[PID]) throw new Error(T("e_roomfull"));
  await Sig.patch("/lobby/"+id,{t,c:Object.keys(seat).length});
  this.begin(id,t);
 },
 begin(id,joinedAt){
  this.id=id; this.on=true; this.joinedAt=joinedAt;
  this.st=RoomState.make(PID); this.st.id=id;
  this.seen=new Set(); this.gseq=0;
  this.sub=Sig.stream(this.path(),ev=>this.onEvent(ev));
  this.hbTimer=setInterval(()=>this.beat(),HB_MS);
 },
 onEvent(ev){
  if(!this.on) return;
  RoomState.apply(this.st,ev);
  const v=this.view();
  if(!v.seats.some(s=>s.pid===PID)){ UI.roomGone(); return; }
  this.onRound(v);
  RoomView.render(v);
 },
 onRound(){},                                   // Task 7 fills this in
 async beat(){
  if(!this.on) return;
  const t=Date.now();
  try{
   await Sig.patch(this.mine(),{hb:t});
   const n=this.view().seats.filter(s=>s.fresh).length||1;
   await Sig.patch("/lobby/"+this.id,{t,c:n});   // any occupant refreshes it, not only the host
  }catch(e){}
 },
 async leave(){
  if(!this.on && !this.id) return;
  const id=this.id;
  this.on=false;
  clearInterval(this.hbTimer); this.hbTimer=null;
  try{ this.sub&&this.sub.close(); }catch(e){}
  this.sub=null; this.id=null;
  const others=this.view().seats.filter(s=>s.pid!==PID&&s.fresh).length;
  this.st=null;
  // awaited, and capped so a dead network cannot trap the player on this screen
  const work=(async()=>{
   await Sig.del("/rooms/"+id+"/seat/"+PID);
   await Sig.del("/rooms/"+id+"/live/"+PID);
   if(others>0){ await Sig.patch("/lobby/"+id,{t:Date.now(),c:others}); return; }
   await Sig.del("/rooms/"+id);
   await Sig.del("/lobby/"+id);
   await Sig.del("/chat/"+id);
  })();
  await Promise.race([work.catch(()=>{}), Sig.sleep(LEAVE_TIMEOUT_MS)]);
 }
};
```

Add an unload hook beside the existing `beforeunload` handler (`:3698`) so a closed tab still clears its seat:

```js
addEventListener("pagehide",()=>{ try{ if(RoomClient.on) RoomClient.leave(); }catch(e){} });
```

Point `UI.doMakeRoom`, `UI.doJoinRoom`, `UI.refreshRooms`, and `UI.leaveRoom` at `RoomClient`, and delete `Net.openRoom`/`Net.joinRoom`/`Net.listRooms`. In `Net.reset()`, replace `Room.stop()` with nothing — leaving is now explicit — and **set `this.mode="p2p"` only after** any awaited room work, fixing the leak where a failed join left `mode==="room"`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/lifecycle.test.mjs`
Expected: PASS, 4/4. The first test is the reported ghost-room bug.

- [ ] **Step 5: Commit**

```bash
git add Tetris_version1.html test/lifecycle.test.mjs
git commit -m "Rewrite room lifecycle so a room nobody is in cannot stay listed"
```

---

### Task 6: Chat over the stream

**Files:**
- Modify: `Tetris_version1.html` — chat methods on `RoomClient`, `UI.renderChat` (`:3142`), the `#chatbar` handler (`:3282`)
- Create: `test/chat.test.mjs`

**Interfaces:**
- Consumes: `Sig.stream`, `RoomClient.begin`.
- Produces: `RoomClient.chat -> [{key,n,m}]`, `RoomClient.say(text) -> Promise<void>`. The `cq` marker is deleted from the protocol entirely.

- [ ] **Step 1: Write the failing test**

Create `test/chat.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { startMock } from "./mock-rtdb.js";
import { startServe } from "./serve.js";
import { openClients, shutdown } from "./harness.mjs";

test("a message reaches every client in the room, in order", async () => {
  const mock = await startMock({ port: 0 });
  const serve = await startServe({ root: process.cwd(), port: 0 });
  const [a, b] = await openClients(2, { mockUrl: mock.url, pageUrl: serve.url + "/Tetris_version1.html", name: "C" });

  const id = await a.page.evaluate(() => RoomClient.create());
  await b.page.evaluate(i => RoomClient.join(i), id);

  await a.page.evaluate(() => RoomClient.say("first"));
  await b.page.evaluate(() => RoomClient.say("second"));

  for (const c of [a, b]) await c.page.waitForFunction(() => RoomClient.chat.length === 2);
  for (const c of [a, b]) {
    const msgs = await c.page.evaluate(() => RoomClient.chat.map(m => m.m));
    assert.deepEqual(msgs, ["first", "second"], c.name + " saw " + msgs);
  }

  await a.close(); await b.close(); await serve.close(); await mock.close();
});

test("typing outside a room does not silently eat the text", async () => {
  const mock = await startMock({ port: 0 });
  const serve = await startServe({ root: process.cwd(), port: 0 });
  const [a] = await openClients(1, { mockUrl: mock.url, pageUrl: serve.url + "/Tetris_version1.html", name: "C" });

  const kept = await a.page.evaluate(() => {
    document.querySelector("#chat-in").value = "not in a room";
    document.querySelector("#chatbar").dispatchEvent(new Event("submit", { cancelable: true }));
    return document.querySelector("#chat-in").value;
  });
  assert.equal(kept, "not in a room", "the compose box must keep text it could not send");

  await a.close(); await serve.close(); await mock.close();
});

test.after(shutdown);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/chat.test.mjs`
Expected: FAIL — `RoomClient.chat` is undefined.

- [ ] **Step 3: Write minimal implementation**

Add to `RoomClient`: `chat:[]`, a second stream opened in `begin()`, and `say()`.

```js
 // chat streams on its own path, so the cq marker and its ordering hazard are gone
 openChat(id){
  this.chatSub=Sig.stream("/chat/"+id,ev=>{
   if(ev.path==="/") this.chat=this.foldChat(ev.data||{});
   else{
    const key=ev.path.slice(1);
    if(ev.data===null) this.chat=this.chat.filter(m=>m.key!==key);
    else this.chat=this.foldChat(Object.assign(this.chatMap(),{[key]:ev.data}));
   }
   UI.renderChat();
  });
 },
 chatMap(){ const o={}; for(const m of this.chat) o[m.key]={n:m.n,m:m.m}; return o; },
 foldChat(c){
  return Object.keys(c).sort((a,b)=>parseInt(a,10)-parseInt(b,10)||(a<b?-1:1))
   .slice(-CHAT_KEEP)
   .map(k=>({key:k, n:String((c[k]||{}).n||"").slice(0,12), m:String((c[k]||{}).m||"").slice(0,120)}));
 },
 async say(text){
  if(!this.on) return;
  const t=String(text).slice(0,120);
  if(!t.trim()) return;
  await Sig.put("/chat/"+this.id+"/"+(Date.now()+"-"+PID),{n:CFG.name,m:t});
 },
```

In `begin()` add `this.chat=[]; this.openChat(id);`; in `leave()` add `try{ this.chatSub&&this.chatSub.close(); }catch(e){}` and `this.chat=[]`.

Change `UI.renderChat` (`:3142`) to read `RoomClient.chat` instead of `Room.chat`, and include the language in the cache signature so a language switch repaints:

```js
  const sig=LANG+":"+log.length+":"+(log.length?log[log.length-1].key:"");
```

Change the `#chatbar` submit handler (`:3282`) to guard **before** clearing:

```js
$("#chatbar").addEventListener("submit",e=>{
 e.preventDefault();
 const el=$("#chat-in"), t=el.value;
 if(!t.trim()||!RoomClient.on) return;      // keep the text if it cannot be sent
 el.value="";
 RoomClient.say(t).catch(()=>{});
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/chat.test.mjs`
Expected: PASS, 2/2.

- [ ] **Step 5: Commit**

```bash
git add Tetris_version1.html test/chat.test.mjs
git commit -m "Stream chat and stop discarding text typed outside a room"
```

---

### Task 7: Round lifecycle — roster, idempotent garbage, awaited death, CAS wins

**Files:**
- Modify: `Tetris_version1.html` — `RoomClient.onRound`, `startMatch` (`:2144`), `drainEvents` (`:2216`), `resolveRound` (`:2085`), `UI.tallied` (`:3179`), `loop` send block (`:2208`)
- Create: `test/round.test.mjs`

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `RoomClient.callStart() -> Promise<void>` — host only; writes `/go` with a frozen `roster`
  - `RoomClient.publishBoard(b) -> Promise<void>` — writes `/live/{pid}`
  - `RoomClient.publishDeath(ms) -> Promise<void>` — awaited with retry
  - `RoomClient.sendAttack(pid, n) -> Promise<void>` — writes `/gb/{pid}/{msgId}`
  - `RoomClient.bumpWin() -> Promise<number>` — `Sig.cas` on `/seat/{pid}/w`
  - `RoomClient.takeGarbage(v)` — applies each unseen `msgId` exactly once, then deletes it

- [ ] **Step 1: Write the failing test**

Create `test/round.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { startMock } from "./mock-rtdb.js";
import { startServe } from "./serve.js";
import { openClients, shutdown } from "./harness.mjs";

const boot = async n => {
  const mock = await startMock({ port: 0 });
  const serve = await startServe({ root: process.cwd(), port: 0 });
  const cs = await openClients(n, { mockUrl: mock.url, pageUrl: serve.url + "/Tetris_version1.html", name: "C" });
  return { mock, cs, end: async () => { for (const c of cs) await c.close(); await serve.close(); await mock.close(); } };
};

test("garbage from the same message id applies exactly once", async () => {
  const { cs: [a], end } = await boot(1);
  const applied = await a.page.evaluate(async () => {
    await RoomClient.create();
    let total = 0;
    G = { over: false, mode: "versus", queueGarbage(n) { total += n; } };
    const packet = { m1: 4 };
    RoomClient.takeGarbage(packet);
    RoomClient.takeGarbage(packet);   // a redelivery, e.g. the delete had not landed
    RoomClient.takeGarbage(packet);
    G = null;
    return total;
  });
  assert.equal(applied, 4, "a redelivered garbage id must not stack");
  await end();
});

test("the host freezes a roster that excludes spectators", async () => {
  const { mock, cs: [a, b, c], end } = await boot(3);
  const id = await a.page.evaluate(() => RoomClient.create());
  await b.page.evaluate(i => RoomClient.join(i), id);
  await c.page.evaluate(i => RoomClient.join(i), id);
  await a.page.waitForFunction(() => RoomClient.view().seats.length === 3);

  await c.page.evaluate(() => RoomClient.setSpectating(true));
  await a.page.waitForFunction(() => RoomClient.view().seats.filter(s => s.spec).length === 1);
  await a.page.evaluate(() => RoomClient.callStart());

  const roster = mock.tree().rooms[id].go.roster;
  assert.equal(Object.keys(roster).length, 2, "the spectator must not be in the roster");
  await end();
});

test("win counts survive concurrent increments", async () => {
  const { mock, cs: [a], end } = await boot(1);
  const id = await a.page.evaluate(() => RoomClient.create());
  await a.page.evaluate(() => Promise.all([
    RoomClient.bumpWin(), RoomClient.bumpWin(), RoomClient.bumpWin(),
  ]));
  const seat = mock.tree().rooms[id].seat;
  assert.equal(seat[Object.keys(seat)[0]].w, 3, "no win may be lost to a stale read-modify-write");
  await end();
});

test.after(shutdown);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/round.test.mjs`
Expected: FAIL — `RoomClient.takeGarbage is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add to `RoomClient`:

```js
 async setReady(v){ if(this.on) await Sig.patch(this.mine(),{rdy:!!v}); },
 async setSpectating(v){ if(this.on) await Sig.patch(this.mine(),{spec:!!v, rdy:false}); },
 async setRule(r){ if(this.isHost()) await Sig.patch(this.path()+"/meta",{r:r==="score"?"score":"attack"}); },
 async publishBoard(b){ if(this.on) await Sig.patch(this.path()+"/live/"+PID,b); },
 async publishDeath(ms){ if(this.on) await Sig.patch(this.path()+"/live/"+PID,{o:1,ms:ms|0}); },
 async sendAttack(pid,n){
  if(!this.on) return;
  await Sig.put(this.path()+"/gb/"+pid+"/"+PID+"_"+(++this.gseq),n|0);
 },
 async bumpWin(){ return this.on ? Sig.cas(this.mine()+"/w",v=>(v|0)+1) : 0; },
 // idempotent by message id: the old code applied before its delete landed
 takeGarbage(g){
  for(const k of Object.keys(g||{})){
   if(this.seen.has(k)) continue;
   this.seen.add(k);
   const n=Math.max(0,Math.min(COLS*2,g[k]|0));
   if(G && !G.over && G.mode==="versus" && n>0) G.queueGarbage(n);
   Sig.del(this.path()+"/gb/"+PID+"/"+k).catch(()=>{});
  }
 },
 async callStart(){
  if(!this.isHost()) return;
  const v=this.view();
  const roster={};
  for(const s of v.seats) if(!s.spec && s.fresh) roster[s.pid]=s.j;
  if(Object.keys(roster).length<2) return;
  this.starting=now();
  await Sig.put(this.path()+"/go",{s:((Math.random()*0xffffffff)>>>0)||1, r:NET_RULE, at:Date.now(), roster});
 },
```

Replace the stub `onRound(){}` with:

```js
 onRound(v){
  const g=(this.st.tree.gb||{})[PID];
  if(g) this.takeGarbage(g);
  if(!this.isHost()&&!this.starting) NET_RULE=v.rule;
  if(v.go&&v.go.at&&v.go.at!==this.lastGo){
   this.lastGo=v.go.at;
   this.starting=now();
   NET_SEED=v.go.s>>>0;
   NET_RULE=v.go.r==="score"?"score":"attack";
   startMatch();
  }
  if(this.isHost()) this.maybeStart(v);
 },
 maybeStart(v){
  if(G && !G.over) return;
  if(this.starting && now()-this.starting<8000) return;
  const p=v.seats.filter(s=>!s.spec&&s.fresh);
  if(p.length<2||!p.every(s=>s.rdy)) return;
  this.callStart().catch(()=>{});
 },
```

Then rewire the call sites:

- `startMatch` (`:2144`): replace the `Room.mark({d:false,ms:null,b:null,rdy:false,g:null})` reset with `Sig.del(RoomClient.path()+"/live/"+PID)` then `Sig.patch(RoomClient.mine(),{rdy:false})`. **Do not touch `/gb`** — nulling it is what erased in-flight garbage.
- `drainEvents` "attack" (`:2224`): target from `RoomClient.view().alive` excluding self; call `RoomClient.sendAttack(...)`.
- `drainEvents` "dead" (`:2239`): `RoomClient.publishDeath(G.lasted()).catch(()=>{})` — awaited internally with retry.
- `resolveRound` (`:2085`): build `field` from `RoomClient.view()` seats where `RoomState.inRound(v,pid)`, reading `d`/`ms` from `v.live[pid]`. Replace both `Room.set("w",…)` calls with `RoomClient.bumpWin()`.
- `UI.tallied` (`:3179`): replace `Room.set("w",…)` with `RoomClient.bumpWin()`, and set `this._goneFor=G` so a later `gameOver` cannot double-count `noteRun`.
- `loop` (`:2208`): gate the board publish on `!G.spectating` so spectators stop transmitting, and call `RoomClient.publishBoard(...)`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/round.test.mjs`
Expected: PASS, 3/3.

- [ ] **Step 5: Commit**

```bash
git add Tetris_version1.html test/round.test.mjs
git commit -m "Agree round membership, apply garbage once, and never lose a win"
```

---

### Task 8: `RoomView` and removal of the old object

**Files:**
- Modify: `Tetris_version1.html` — extract rendering out of `UI.renderRoom` (`:3109`) into `RoomView`; delete every remaining `Room.` reference
- Create: `test/view.test.mjs`

**Interfaces:**
- Consumes: `RoomState.view` output.
- Produces: `RoomView.render(view)` — seat rows, ready button, spectate button, hint, rule paint. Markup and class names are unchanged from `:3118-3138`, so all existing CSS keeps working.

- [ ] **Step 1: Write the failing test**

Create `test/view.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { startMock } from "./mock-rtdb.js";
import { startServe } from "./serve.js";
import { openClients, shutdown } from "./harness.mjs";

test("seat rows reflect the room, and the spectate button is offered before the first match", async () => {
  const mock = await startMock({ port: 0 });
  const serve = await startServe({ root: process.cwd(), port: 0 });
  const [a, b] = await openClients(2, { mockUrl: mock.url, pageUrl: serve.url + "/Tetris_version1.html", name: "C" });

  const id = await a.page.evaluate(() => RoomClient.create());
  await b.page.evaluate(i => RoomClient.join(i), id);
  await a.page.waitForFunction(() => document.querySelectorAll("#seatlist .seat-row").length === 2);

  assert.equal(await a.page.evaluate(() => document.querySelectorAll("#seatlist .seat-row.mine").length), 1);
  // the old build hid this until a round had already happened
  assert.equal(await a.page.evaluate(() => document.querySelector("#b-spectate").hidden), false);

  await b.page.evaluate(() => RoomClient.setSpectating(true));
  await a.page.waitForFunction(() => document.querySelectorAll("#seatlist .seat-row.spectating").length === 1);

  await a.close(); await b.close(); await serve.close(); await mock.close();
});

test("no reference to the old Room object survives", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile("Tetris_version1.html", "utf8");
  assert.equal(/\bRoom\.[a-z]/i.test(src), false, "the old Room object must be gone");
  assert.equal(/\bFB\./.test(src), false, "the old FB object must be gone");
});

test.after(shutdown);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/view.test.mjs`
Expected: FAIL — the spectate button is still hidden, and `Room.` references remain.

- [ ] **Step 3: Write minimal implementation**

Move the body of `UI.renderRoom` into `RoomView.render(v)`, reading from the view rather than `Room`. Keep every class name and the `esc()` calls. Two behaviour changes:

```js
  // offered from the start: it used to appear only after a round had run
  specBtn.hidden=!RoomClient.on;
```

and skip the rebuild when nothing changed, since this now runs on every stream event:

```js
  const sig=JSON.stringify(v.seats)+LANG;
  if(sig===this._sig) return;
  this._sig=sig;
```

Make `UI.renderRoom()` a thin forwarder (`RoomView.render(RoomClient.view())`) so the existing callers in `applyLang` (`:932`) keep working. Delete the `Room` object entirely and replace every remaining `Room.` reference. `grep -n "Room\.\|FB\." Tetris_version1.html` must return only `RoomClient.`/`RoomState.`/`RoomView.` matches.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/view.test.mjs`
Expected: PASS, 2/2.

- [ ] **Step 5: Commit**

```bash
git add Tetris_version1.html test/view.test.mjs
git commit -m "Split room rendering into RoomView and delete the old Room object"
```

---

### Task 9: Full match simulation

The deliverable the user asked for: create a room, join it, play a match, log the whole thing.

**Files:**
- Create: `test/match.test.mjs`
- Modify: `package.json` (create if absent) — add `"scripts": {"test": "node --test test/"}`

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Write the failing test**

Create `test/match.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { startMock } from "./mock-rtdb.js";
import { startServe } from "./serve.js";
import { openClients, shutdown } from "./harness.mjs";

test("a three-player match runs from creation to a single winner", async () => {
  const mock = await startMock({ port: 0 });
  const serve = await startServe({ root: process.cwd(), port: 0 });
  const cs = await openClients(3, { mockUrl: mock.url, pageUrl: serve.url + "/Tetris_version1.html", name: "P" });
  const [a, b, c] = cs;

  const id = await a.page.evaluate(() => RoomClient.create());
  a.log("created room", id);
  for (const g of [b, c]) { await g.page.evaluate(i => RoomClient.join(i), id); g.log("joined", id); }
  for (const g of cs) await g.page.waitForFunction(() => RoomClient.view().seats.length === 3);
  a.log("all three seated");

  await a.page.evaluate(() => RoomClient.say("gl hf"));
  for (const g of cs) await g.page.waitForFunction(() => RoomClient.chat.length === 1);
  a.log("chat delivered to all clients");

  for (const g of cs) { await g.page.evaluate(() => RoomClient.setReady(true)); g.log("ready"); }
  for (const g of cs) await g.page.waitForFunction(() => G && G.mode === "versus", null, { timeout: 15000 });
  a.log("match started; seed", await a.page.evaluate(() => NET_SEED));

  assert.equal(await a.page.evaluate(() => NET_SEED), await b.page.evaluate(() => NET_SEED),
    "every client must deal the same pieces");

  // end two wells; the survivor must be the sole winner
  for (const g of [b, c]) { await g.page.evaluate(() => G.die()); g.log("topped out"); }
  await a.page.waitForFunction(() => G && G.won === true, null, { timeout: 15000 });
  a.log("won the round");

  const results = await Promise.all(cs.map(g => g.page.evaluate(() => ({ won: !!(G && G.won) }))));
  assert.equal(results.filter(r => r.won).length, 1, "exactly one winner: " + JSON.stringify(results));

  for (const g of cs) { await g.page.evaluate(() => RoomClient.leave()); g.log("left"); }
  assert.equal(mock.tree().rooms, undefined, "no room may survive everyone leaving");
  assert.equal(mock.tree().lobby, undefined, "no ghost room may remain listed");
  a.log("room fully cleaned up");

  for (const g of cs) assert.deepEqual(g.errors, [], g.name + " console errors");
  for (const g of cs) await g.close();
  await serve.close(); await mock.close();
});

test.after(shutdown);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/match.test.mjs`
Expected: FAIL if any wiring from Tasks 5-8 is incomplete. Read the logged step sequence to see how far it got.

- [ ] **Step 3: Write minimal implementation**

Fix whatever the simulation surfaces. Do not weaken the assertions to make them pass. Create `package.json` if it does not exist:

```json
{ "private": true, "type": "module", "scripts": { "test": "node --test test/" } }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS across all suites, with the full step log printed.

- [ ] **Step 5: Commit**

```bash
git add test/match.test.mjs package.json
git commit -m "Simulate a full three-player match end to end"
```

---

### Task 10: Documentation and size check

**Files:**
- Modify: `CLAUDE.md` — the Multiplayer section

- [ ] **Step 1: Check the size**

Run: `ls -l Tetris_version1.html` and note the byte count.

- [ ] **Step 2: Rewrite the Multiplayer section of CLAUDE.md**

Replace the "Multiplayer (versus mode)" bullets. The old text describes `Room`, polling, `cq`, and `ROOM_MS`/`ROOM_IDLE_MS`, all of which are gone; it also wrongly implies room mode is WebRTC. Document instead: the `Sig`/`RoomState`/`RoomClient`/`RoomView` split and why (one writer for state); SSE streaming rather than polling; the new data model with `live` split from `seat`; the roster frozen into `/go` and why every client must agree on it; garbage idempotence by message id; awaited leave plus read-only listing as the three ghost-room guarantees; and `Sig.cas` for win counts. Keep the existing "Things that were broken once" entries and add: *a listing must never delete rooms*, and *`/gb` must never be nulled by the round reset*.

- [ ] **Step 3: Run the whole suite once more**

Run: `npm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "Document the rewritten room multiplayer"
```

---

## Self-review

**Spec coverage.** Sig → Task 3. RoomState → Task 4. RoomClient → Tasks 5-7. RoomView → Task 8. Data model → Tasks 5-7 (all seven paths written). Ghost rooms, all three guarantees → Task 5 (awaited leave; `pagehide`; read-only `listRooms`). Spectate → Tasks 7 (roster exclusion, no board transmission) and 8 (button available from the start). Chat → Task 6, including both named latent bugs. Round resolution → Task 7 (roster, awaited death, `Sig.cas`). `Net.mode` leak → Task 5. Verification → Tasks 1, 2, 9. Constraints → Global Constraints, with the size check in Task 10.

**Placeholders.** None: every code step carries the actual code. Task 9 Step 3 is deliberately open ("fix what the simulation surfaces") because its content depends on the run — but its gate is exact and the assertions may not be weakened.

**Type consistency.** `RoomState.view()` returns `{id,host,rule,go,seats,live,me,alive,roster}`, and Tasks 5-8 read only those keys. `RoomState.inRound(view,pid)` takes a view, not a state, at every call site. `Sig.req` returns `{value,etag}` or `{conflict:true}`, and `get/put/patch` unwrap `.value` while `cas` checks `.conflict`. `RoomClient.leave()` returns a promise and is awaited everywhere except the `pagehide` hook, where it is deliberately fire-and-forget because the page is going away.

**One risk to watch.** Task 3 assumes a top-level `const` in a classic script is reachable by name from `page.evaluate` (global lexical scope). If that turns out not to hold in practice, the fix is one line in the file — `window.__t={Sig,RoomState,RoomClient,RoomView}` behind a `location.hostname==="127.0.0.1"` guard — and a matching prefix in the tests. Decide this in Task 3, not later.
