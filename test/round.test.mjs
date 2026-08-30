import { test } from "node:test";
import assert from "node:assert/strict";
import { startMock } from "./mock-rtdb.js";
import { startServe } from "./serve.js";
import { openClients, shutdown } from "./harness.mjs";

const boot = async n => {
  const mock = await startMock({ port: 0 });
  const serve = await startServe({ root: process.cwd(), port: 0 });
  const cs = await openClients(n, {
    mockUrl: mock.url,
    pageUrl: serve.url + "/Tetris_version1.html",
    name: "C",
  });
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

test("garbage off the wire is clamped", async () => {
  const { cs: [a], end } = await boot(1);
  const applied = await a.page.evaluate(async () => {
    await RoomClient.create();
    let total = 0;
    G = { over: false, mode: "versus", queueGarbage(n) { total += n; } };
    RoomClient.takeGarbage({ evil: 1e9 });
    G = null;
    return total;
  });
  assert.equal(applied, 20, "a peer once queued a billion garbage lines; cap at COLS*2");
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

test("a death publishes into live and is visible to the other client", async () => {
  const { cs: [a, b], end } = await boot(2);
  const id = await a.page.evaluate(() => RoomClient.create());
  await b.page.evaluate(i => RoomClient.join(i), id);
  await a.page.waitForFunction(() => RoomClient.view().seats.length === 2);

  await b.page.evaluate(() => RoomClient.publishDeath(4200));
  await a.page.waitForFunction(() => RoomClient.view().seats.some(s => s.d && s.ms === 4200));
  await end();
});

test.after(shutdown);
