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
    name: "D",
  });
  return { c, end: async () => { await c.close(); await serve.close(); await mock.close(); } };
};

const TILE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("a backup round-trips settings and records", async () => {
  const { c, end } = await boot();
  const out = await c.page.evaluate(`(() => {
    CFG.das = 133; CFG.name = "Ada"; REC.marathon = 4242; REC.speed.hard = 7;
    const text = JSON.stringify(Backup.make());
    CFG.das = 10; CFG.name = "gone"; REC.marathon = 0; REC.speed.hard = 0;
    Backup.apply(Backup.check(text));
    return { das: CFG.das, name: CFG.name, marathon: REC.marathon, hard: REC.speed.hard };
  })()`);
  assert.deepEqual(out, { das: 133, name: "Ada", marathon: 4242, hard: 7 });
  await end();
});

test("a malformed file is rejected whole, not applied in part", async () => {
  const { c, end } = await boot();
  const out = await c.page.evaluate(`(() => {
    CFG.das = 99;
    const tries = ["not json at all", "null", "[]", JSON.stringify({ nope: 1 })];
    const errs = tries.map(t => { try { Backup.apply(Backup.check(t)); return "APPLIED"; } catch (e) { return "rejected"; } });
    return { errs, das: CFG.das };
  })()`);
  assert.deepEqual(out.errs, ["rejected", "rejected", "rejected", "rejected"]);
  assert.equal(out.das, 99, "a rejected import must not have changed anything");
  await end();
});

test("a file from a newer version is refused rather than half-read", async () => {
  const { c, end } = await boot();
  const refused = await c.page.evaluate(`(() => {
    const text = JSON.stringify({ v: 999, cfg: { das: 1 } });
    try { Backup.check(text); return false; } catch (e) { return true; }
  })()`);
  assert.equal(refused, true);
  await end();
});

test("a preset saves all seven tiles and loads them back", async () => {
  const { c, end } = await boot();
  const out = await c.page.evaluate(`(() => {
    TYPES.forEach(t => { CFG.tiles[t] = ${JSON.stringify(TILE)}; });
    Presets.save("mine");
    const saved = CFG.presets.length && Object.keys(CFG.presets[0].tiles).length;
    TYPES.forEach(t => delete CFG.tiles[t]);          // wipe the live tiles
    Presets.load(0);
    return { saved, name: CFG.presets[0].n, restored: TYPES.filter(t => CFG.tiles[t]).length };
  })()`);
  assert.equal(out.saved, 7, "a preset holds all seven pieces");
  assert.equal(out.name, "mine");
  assert.equal(out.restored, 7, "loading restores all seven");
  await end();
});

test("presets stop at five", async () => {
  const { c, end } = await boot();
  const count = await c.page.evaluate(`(() => {
    CFG.tiles.I = ${JSON.stringify(TILE)};
    for (let i = 0; i < 8; i++) Presets.save("p" + i);
    return CFG.presets.length;
  })()`);
  assert.equal(count, 5, "MAX_PRESETS must hold");
  await end();
});

test("a preset is a copy, so editing a tile afterwards does not rewrite it", async () => {
  const { c, end } = await boot();
  const same = await c.page.evaluate(`(() => {
    CFG.tiles.I = ${JSON.stringify(TILE)};
    Presets.save("snap");
    CFG.tiles.I = "data:image/png;base64,CHANGED";
    return CFG.presets[0].tiles.I === ${JSON.stringify(TILE)};
  })()`);
  assert.equal(same, true, "the preset must keep the tiles it was saved with");
  await end();
});

test("presets survive an export and import", async () => {
  const { c, end } = await boot();
  const out = await c.page.evaluate(`(() => {
    CFG.tiles.I = ${JSON.stringify(TILE)};
    Presets.save("kept");
    const text = JSON.stringify(Backup.make());
    CFG.presets = [];
    Backup.apply(Backup.check(text));
    return { n: CFG.presets.length, name: CFG.presets[0] && CFG.presets[0].n };
  })()`);
  assert.equal(out.n, 1);
  assert.equal(out.name, "kept");
  await end();
});

test.after(shutdown);
