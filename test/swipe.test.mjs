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
    name: "W",
  });
  return { c, end: async () => { await c.close(); await serve.close(); await mock.close(); } };
};

// Drives Swipe directly with synthetic pointer coordinates, which is what the
// real listeners forward, and counts the moves that reach Input.
const dragMoves = `(cell, dx) => {
  CFG.touch = "swipe";
  L = L || {};
  L.cell = cell;                      // pretend the board renders at this size
  G = { over: false, paused: false, mode: "solo" };
  const fired = [];
  const p = Input.press.bind(Input);
  Input.press = a => { fired.push(a); };
  Swipe.id = null;
  Swipe.down({ pointerId: 1, clientX: 0, clientY: 300 });
  for (let x = 1; x <= dx; x++) Swipe.move({ pointerId: 1, clientX: x, clientY: 300 });
  Swipe.up({ pointerId: 1, clientX: dx, clientY: 300 });
  Input.press = p;
  G = null;
  return fired.filter(a => a === "right").length;
}`;

test("the same drag moves the piece the same distance at any board size", async () => {
  const { c, end } = await boot();
  const big = await c.page.evaluate(`(${dragMoves})(30, 240)`);
  const small = await c.page.evaluate(`(${dragMoves})(10, 240)`);
  assert.ok(big > 0, "the drag should move the piece at all");
  assert.equal(small, big,
    `a 240px drag gave ${big} moves on a 30px-cell board but ${small} on a 10px-cell board`);
  await end();
});

test("swipe sensitivity still responds to its setting", async () => {
  const { c, end } = await boot();
  const base = await c.page.evaluate(`(() => { CFG.swMove = 80; return (${dragMoves})(24, 240); })()`);
  const twitchy = await c.page.evaluate(`(() => { CFG.swMove = 40; return (${dragMoves})(24, 240); })()`);
  assert.ok(twitchy > base, `lowering swMove must move more: ${base} -> ${twitchy}`);
  await end();
});

test("the touch area is not limited to the canvas box", async () => {
  const { c, end } = await boot();
  const out = await c.page.evaluate(() => {
    const screen = document.querySelector("#screen");
    const area = SwipeArea();
    return {
      sameNode: area === screen,
      areaId: area && (area.id || area.tagName),
    };
  });
  assert.equal(out.sameNode, false,
    "#screen is exactly the canvas box, so listening there shrinks the input area with the board");
  await end();
});

test.after(shutdown);
