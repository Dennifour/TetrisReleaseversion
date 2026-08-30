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

test("a message reaches every client in the room, in order", async () => {
  const { cs: [a, b], end } = await boot(2);
  const id = await a.page.evaluate(() => RoomClient.create());
  await b.page.evaluate(i => RoomClient.join(i), id);

  await a.page.evaluate(() => RoomClient.say("first"));
  await b.page.evaluate(() => RoomClient.say("second"));

  for (const c of [a, b]) await c.page.waitForFunction(() => RoomClient.chat.length === 2);
  for (const c of [a, b]) {
    const msgs = await c.page.evaluate(() => RoomClient.chat.map(m => m.m));
    assert.deepEqual(msgs, ["first", "second"], c.name + " saw " + msgs);
  }
  await end();
});

test("typing outside a room does not silently eat the text", async () => {
  const { cs: [a], end } = await boot(1);
  const kept = await a.page.evaluate(() => {
    document.querySelector("#chat-in").value = "not in a room";
    document.querySelector("#chatbar").dispatchEvent(new Event("submit", { cancelable: true }));
    return document.querySelector("#chat-in").value;
  });
  assert.equal(kept, "not in a room", "the compose box must keep text it could not send");
  await end();
});

test("chat is cleared on leaving and not carried into the next room", async () => {
  const { cs: [a], end } = await boot(1);
  await a.page.evaluate(() => RoomClient.create());
  await a.page.evaluate(() => RoomClient.say("hello"));
  await a.page.waitForFunction(() => RoomClient.chat.length === 1);

  await a.page.evaluate(() => RoomClient.leave());
  await a.page.evaluate(() => RoomClient.create());
  assert.deepEqual(await a.page.evaluate(() => RoomClient.chat), []);
  await end();
});

test("the empty-chat line follows a language change", async () => {
  const { cs: [a], end } = await boot(1);
  await a.page.evaluate(() => RoomClient.create());
  // pin the starting language: the default follows the browser locale
  const en = await a.page.evaluate(() => {
    CFG.lang = "en";
    UI.renderChat();
    return document.querySelector("#chat-log").textContent;
  });

  const ko = await a.page.evaluate(() => {
    CFG.lang = "ko";
    UI.renderChat();
    return document.querySelector("#chat-log").textContent;
  });
  // the old signature cache was length+last-key only, so this never repainted
  assert.notEqual(ko, en, "a language switch must repaint the empty-chat line");
  await end();
});

test.after(shutdown);
