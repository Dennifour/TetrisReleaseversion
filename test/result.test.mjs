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
    name: "G",
  });
  return { c, end: async () => { await c.close(); await serve.close(); await mock.close(); } };
};

const shown = () => `document.querySelector("#game-over").classList.contains("on")`;

test("the result card waits a beat before appearing", async () => {
  const { c, end } = await boot();
  const out = await c.page.evaluate(`(async () => {
    startGame("solo");
    G.die();
    UI.showGameOver(false);
    const immediately = ${shown()};
    await new Promise(r => setTimeout(r, 600));
    const halfway = ${shown()};
    await new Promise(r => setTimeout(r, 700));
    return { immediately, halfway, after: ${shown()} };
  })()`);
  assert.equal(out.immediately, false, "the card must not appear the instant the run ends");
  assert.equal(out.halfway, false, "still hidden at 600ms");
  assert.equal(out.after, true, "shown by ~1.3s");
  await end();
});

test("the board is torn down behind the card, not merely covered", async () => {
  const { c, end } = await boot();
  const gone = await c.page.evaluate(`(async () => {
    startGame("solo");
    G.die();
    UI.showGameOver(false);
    await new Promise(r => setTimeout(r, 1800));   // past the card plus the fade
    return G === null;
  })()`);
  assert.equal(gone, true, "the well must be gone, so leaving the card cannot reveal it");
  await end();
});

test("starting a new run cancels a result card still pending", async () => {
  const { c, end } = await boot();
  const out = await c.page.evaluate(`(async () => {
    startGame("solo");
    G.die();
    UI.showGameOver(false);
    await new Promise(r => setTimeout(r, 300));
    startGame("solo");                              // restart inside the delay
    await new Promise(r => setTimeout(r, 1200));
    return { card: ${shown()}, alive: !!G };
  })()`);
  assert.equal(out.card, false, "the old run's card must not land on the new one");
  assert.equal(out.alive, true, "and the new well must survive");
  await end();
});

test.after(shutdown);
