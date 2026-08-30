import { test } from "node:test";
import assert from "node:assert/strict";
import { startMock } from "./mock-rtdb.js";
import { startServe } from "./serve.js";
import { openClients, shutdown } from "./harness.mjs";

const boot = async () => {
  const mock = await startMock({ port: 0 });
  const serve = await startServe({ root: process.cwd(), port: 0 });
  const [c] = await openClients(1, {
    mockUrl: mock.url,
    pageUrl: serve.url + "/Tetris_version1.html",
    name: "S",
  });
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
