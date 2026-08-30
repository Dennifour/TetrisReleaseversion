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

// block() aligns every tile to a whole device pixel, but it does so in the
// space *before* the board-give translate. If that translate is fractional it
// shifts all of them off-pixel again, and adjacent tiles antialias into a seam
// -- the 1px gap seen on hard drop, which is what starts the bob.
const bobOffset = bob => `(() => {
  startGame("solo");
  CFG.bob = true;
  FX.bob = ${bob};
  const seen = [];
  const orig = ctx.translate.bind(ctx);
  ctx.translate = (x, y) => { seen.push(y); return orig(x, y); };
  try { render(G, null); } finally { ctx.translate = orig; }
  return { y: seen[0], DPR, cell: L.cell };
})()`;

test("the board-give offset lands on a whole device pixel", async () => {
  const { c, end } = await boot();
  for (const bob of [0.37, 0.5123, -0.29, 1.77]) {
    const out = await c.page.evaluate(bobOffset(bob));
    assert.ok(out.y !== undefined, "render should apply a translate while bobbing");
    const devicePx = out.y * out.DPR;
    assert.ok(Math.abs(devicePx - Math.round(devicePx)) < 1e-9,
      `bob ${bob} translated ${out.y} css px = ${devicePx} device px, which is off-pixel ` +
      `(DPR ${out.DPR}, cell ${out.cell}) -- tiles will seam`);
  }
  await end();
});

test("the board still gives: a bob of zero does not translate", async () => {
  const { c, end } = await boot();
  const out = await c.page.evaluate(bobOffset(0));
  assert.equal(out.y, undefined, "no bob, no translate");
  await end();
});

test("a large bob still moves the board", async () => {
  const { c, end } = await boot();
  const out = await c.page.evaluate(bobOffset(0.9));
  assert.ok(Math.abs(out.y) > 0, "rounding must not flatten the give to nothing");
  await end();
});

test.after(shutdown);
