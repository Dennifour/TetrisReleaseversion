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
    name: "R",
  });
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

test("a death published into live marks a seat not-alive", async () => {
  const { c, end } = await boot();
  const alive = await c.page.evaluate(() => {
    const st = RoomState.make("p1");
    RoomState.apply(st, { type: "put", path: "/", data: {
      seat: { p1: { j: 1, hb: 50 }, p2: { j: 2, hb: 50 } },
      go: { s: 1, r: "attack", at: 5, roster: { p1: 1, p2: 2 } },
    }});
    RoomState.apply(st, { type: "patch", path: "/live/p2", data: { o: 1, ms: 4200 } });
    return RoomState.view(st, 50).alive.map(s => s.pid);
  });
  assert.deepEqual(alive, ["p1"]);
  await end();
});

test("real millisecond timestamps are not truncated to int32", async () => {
  const { c, end } = await boot();
  const out = await c.page.evaluate(() => {
    const t = Date.now();                     // ~1.79e12, well past int32
    const st = RoomState.make("p1");
    RoomState.apply(st, { type: "put", path: "/", data: { seat: { p1: { j: t, hb: t } } } });
    const v = RoomState.view(st, t);
    return { hb: v.seats[0].hb, j: v.seats[0].j, fresh: v.seats[0].fresh, t };
  });
  assert.equal(out.hb, out.t, "a heartbeat must survive the round trip intact");
  assert.equal(out.j, out.t);
  assert.equal(out.fresh, true, "a seat that just beat must not read as stale");
  await end();
});

test.after(shutdown);
