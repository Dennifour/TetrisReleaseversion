import { test } from "node:test";
import assert from "node:assert/strict";
import { startMock } from "./mock-rtdb.js";
import { startServe } from "./serve.js";
import { openClients, shutdown } from "./harness.mjs";

test("the game boots with the mock configured and no console errors", async () => {
  const mock = await startMock({ port: 0 });
  const serve = await startServe({ root: process.cwd(), port: 0 });
  const [a] = await openClients(1, {
    mockUrl: mock.url,
    pageUrl: serve.url + "/Tetris_version1.html",
    name: "A",
  });

  assert.equal(await a.page.evaluate(() => CFG.fbUrl), mock.url);
  assert.deepEqual(a.errors, []);

  await a.close(); await serve.close(); await mock.close();
});

test("script-scope bindings are reachable from evaluate", async () => {
  const mock = await startMock({ port: 0 });
  const serve = await startServe({ root: process.cwd(), port: 0 });
  const [a] = await openClients(1, {
    mockUrl: mock.url,
    pageUrl: serve.url + "/Tetris_version1.html",
    name: "A",
  });

  // the whole test strategy rests on this: top-level const in a classic
  // script lands in the global lexical scope, so evaluate resolves it
  assert.equal(await a.page.evaluate(() => typeof CFG), "object");
  assert.equal(await a.page.evaluate(() => typeof Grid), "object");
  assert.equal(await a.page.evaluate(() => typeof UI), "object");

  await a.close(); await serve.close(); await mock.close();
});

test.after(shutdown);
