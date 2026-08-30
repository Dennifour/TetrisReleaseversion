// Smoke test against a REAL Firebase RTDB. Not part of `npm test` -- it needs
// network and a database URL. Usage:
//   node test/real-smoke.mjs <rtdb-url>
//
// Security rules on a real database are path-scoped, so this cannot hide under
// a scratch prefix; it writes to the same /rooms, /lobby and /chat the game
// uses. It therefore deletes ONLY the ids it created -- never a whole subtree.
import { startServe } from "./serve.js";
import { openClients, shutdown } from "./harness.mjs";

const BASE = (process.argv[2] || "").replace(/\/+$/, "");
if (!BASE) { console.error("usage: node test/real-smoke.mjs <rtdb-url>"); process.exit(2); }

const PROBE = "/rooms/__ccsmoke";                  // under /rooms, which rules allow
const j = p => BASE + p + ".json";
const say = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
const made = new Set();                            // room ids this run created
let failures = 0, skipped = 0;
const check = (name, ok, detail) => {
  if (ok) say("PASS", name);
  else { failures++; say("FAIL", name, detail === undefined ? "" : "-- " + JSON.stringify(detail)); }
};
const skip = (name, why) => { skipped++; say("SKIP", name, "--", why); };

try {
  // ---- 0. what do the rules actually allow? ------------------------------
  const canWrite = async p => (await fetch(j(p), { method: "PUT", body: '"x"' })).status === 200;
  const chatOk = await canWrite("/chat/__ccsmoke/probe");
  if (chatOk) await fetch(j("/chat/__ccsmoke"), { method: "DELETE" });
  say("rules:", "/rooms writable =", await canWrite(PROBE + "/w"), "| /chat writable =", chatOk);

  // ---- 1. basic REST shape ----------------------------------------------
  await fetch(j(PROBE), { method: "PUT", body: JSON.stringify({ hello: "world" }) });
  const got = await fetch(j(PROBE)).then(r => r.json());
  check("REST put/get round-trips", !!got && got.hello === "world", got);

  await fetch(j(PROBE), { method: "PATCH", body: JSON.stringify({ two: 2 }) });
  const merged = await fetch(j(PROBE)).then(r => r.json());
  check("PATCH merges rather than replaces", !!merged && merged.hello === "world" && merged.two === 2, merged);

  await fetch(j(PROBE + "/hello"), { method: "PUT", body: "null" });
  const pruned = await fetch(j(PROBE)).then(r => r.json());
  check("a null value deletes the key", !!pruned && !pruned.error && pruned.hello === undefined, pruned);

  // ---- 2. ETag compare-and-swap -----------------------------------------
  await fetch(j(PROBE + "/cas"), { method: "PUT", body: "1" });
  const tag = (await fetch(j(PROBE + "/cas"), { headers: { "X-Firebase-ETag": "true" } })).headers.get("etag");
  check("GET with X-Firebase-ETag returns an ETag", !!tag, tag);

  if (tag) {
    const fresh = await fetch(j(PROBE + "/cas"), { method: "PUT", body: "2", headers: { "if-match": tag } });
    check("if-match with a current tag is accepted", fresh.ok, fresh.status);
    const stale = await fetch(j(PROBE + "/cas"), { method: "PUT", body: "99", headers: { "if-match": tag } });
    check("if-match with a stale tag is rejected with 412", stale.status === 412, stale.status);
    const after = await fetch(j(PROBE + "/cas")).then(r => r.json());
    check("the rejected write did not land", after === 2, after);
  }

  // ---- 3. SSE streaming --------------------------------------------------
  const ctl = new AbortController();
  const events = [];
  const streamDone = (async () => {
    const res = await fetch(j(PROBE + "/stream"), { headers: { Accept: "text/event-stream" }, signal: ctl.signal });
    check("stream responds as text/event-stream",
      (res.headers.get("content-type") || "").includes("text/event-stream"),
      res.headers.get("content-type"));
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const raw = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = /^event: (.*)$/m.exec(raw), da = /^data: (.*)$/m.exec(raw);
        if (ev && da && ev[1] !== "keep-alive") {
          let parsed = null; try { parsed = JSON.parse(da[1]); } catch {}
          events.push({ event: ev[1], path: parsed && parsed.path });
        }
      }
    }
  })().catch(() => {});

  await new Promise(r => setTimeout(r, 1500));
  await fetch(j(PROBE + "/stream/seat/p1"), { method: "PUT", body: JSON.stringify({ n: "Ada" }) });
  await new Promise(r => setTimeout(r, 1500));
  await fetch(j(PROBE + "/stream/seat/p1"), { method: "PATCH", body: JSON.stringify({ rdy: true }) });
  await new Promise(r => setTimeout(r, 1500));
  ctl.abort(); await streamDone;

  say("stream events:", JSON.stringify(events));
  check("stream delivers an initial put at path /", !!events.find(e => e.event === "put" && e.path === "/"), events);
  check("a child write arrives as a put at its own path", !!events.find(e => e.event === "put" && e.path === "/seat/p1"), events);
  check("a PATCH arrives as a patch event", !!events.find(e => e.event === "patch" && e.path === "/seat/p1"), events);

  // ---- 4. a real three-client match --------------------------------------
  const serve = await startServe({ root: process.cwd(), port: 0 });
  const cs = await openClients(3, { mockUrl: BASE, pageUrl: serve.url + "/Tetris_version1.html", name: "R" });
  const [a, b, c] = cs;
  try {
    const id = await a.page.evaluate(() => RoomClient.create());
    made.add(id);
    say("created room", id);
    for (const g of [b, c]) await g.page.evaluate(i => RoomClient.join(i), id);
    for (const g of cs) await g.page.waitForFunction(() => RoomClient.view().seats.length === 3, null, { timeout: 25000 });
    check("three clients seated over real Firebase", true);

    if (chatOk) {
      await a.page.evaluate(() => RoomClient.say("real hello"));
      for (const g of cs) await g.page.waitForFunction(() => RoomClient.chat.length === 1, null, { timeout: 25000 });
      check("chat streamed to every client", true);
    } else skip("chat streamed to every client", "the database rules deny writes to /chat");

    for (const g of cs) await g.page.evaluate(() => RoomClient.setReady(true));
    for (const g of cs) await g.page.waitForFunction(() => G && G.mode === "versus" && !G.over, null, { timeout: 30000 });
    const seeds = await Promise.all(cs.map(g => g.page.evaluate(() => NET_SEED)));
    check("every client dealt the same seed", new Set(seeds).size === 1, seeds);

    for (const g of [b, c]) await g.page.evaluate(() => { G.die(); });
    await a.page.waitForFunction(() => G && G.won === true, null, { timeout: 30000 });
    const wins = await Promise.all(cs.map(g => g.page.evaluate(() => !!(G && G.won))));
    check("exactly one winner", wins.filter(Boolean).length === 1, wins);

    await a.page.waitForFunction(() => RoomClient.view().seats.some(s => s.pid === PID && s.w === 1), null, { timeout: 25000 });
    check("the win was recorded through compare-and-swap", true);

    for (const g of cs) await g.page.evaluate(() => RoomClient.leave());
    await new Promise(r => setTimeout(r, 1500));
    const lobby = await fetch(j("/lobby/" + id)).then(r => r.json());
    const room = await fetch(j("/rooms/" + id)).then(r => r.json());
    check("no ghost room left in the lobby", lobby === null, lobby);
    check("the room node is gone", room === null, room);
    if (lobby === null && room === null) made.delete(id);

    for (const g of cs) {
      const errs = g.errors.filter(e => !/favicon/i.test(e));
      check(g.name + " had no console errors", errs.length === 0, errs);
    }
  } finally {
    for (const g of cs) await g.close();
    await serve.close();
    await shutdown();
  }
} finally {
  // only what this run made, and only by id -- never a subtree the game owns
  await fetch(j(PROBE), { method: "DELETE" }).catch(() => {});
  for (const id of made) {
    for (const p of ["/rooms/", "/lobby/", "/chat/"]) {
      await fetch(j(p + id), { method: "DELETE" }).catch(() => {});
    }
    say("cleaned up stray room", id);
  }
  say(failures ? `${failures} CHECK(S) FAILED, ${skipped} skipped` : `ALL CHECKS PASSED, ${skipped} skipped`);
  process.exit(failures ? 1 : 0);
}
