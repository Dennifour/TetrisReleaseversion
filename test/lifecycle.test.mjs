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

test("joining a room that does not exist reports it rather than seating you", async () => {
  const { cs: [a], end } = await boot(1);
  const msg = await a.page.evaluate(() => RoomClient.join("NOPE00").then(() => "ok", e => e.message));
  assert.notEqual(msg, "ok");
  assert.equal(await a.page.evaluate(() => RoomClient.on), false);
  await end();
});

test.after(shutdown);
