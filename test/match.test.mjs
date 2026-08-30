import { test } from "node:test";
import assert from "node:assert/strict";
import { startMock } from "./mock-rtdb.js";
import { startServe } from "./serve.js";
import { openClients, shutdown } from "./harness.mjs";

test("a three-player match runs from creation to a single winner", async () => {
  const mock = await startMock({ port: 0 });
  const serve = await startServe({ root: process.cwd(), port: 0 });
  const cs = await openClients(3, {
    mockUrl: mock.url,
    pageUrl: serve.url + "/Tetris_version1.html",
    name: "P",
  });
  const [a, b, c] = cs;

  // the result card tears the board down behind itself, so G is gone shortly
  // after a run resolves -- record each outcome when it happens, not after
  for (const g of cs) await g.page.evaluate(() => {
    window.__won = null;
    const orig = UI.showGameOver.bind(UI);
    UI.showGameOver = beat => { window.__won = !!(G && G.won); return orig(beat); };
  });

  const id = await a.page.evaluate(() => RoomClient.create());
  a.log("created room", id);
  for (const g of [b, c]) {
    await g.page.evaluate(i => RoomClient.join(i), id);
    g.log("joined", id);
  }
  for (const g of cs) await g.page.waitForFunction(() => RoomClient.view().seats.length === 3);
  a.log("all three seated");

  await a.page.evaluate(() => RoomClient.say("gl hf"));
  for (const g of cs) await g.page.waitForFunction(() => RoomClient.chat.length === 1);
  a.log("chat delivered to all three clients");

  for (const g of cs) {
    await g.page.evaluate(() => RoomClient.setReady(true));
    g.log("ready");
  }
  for (const g of cs) await g.page.waitForFunction(() => G && G.mode === "versus" && !G.over);
  const seeds = await Promise.all(cs.map(g => g.page.evaluate(() => NET_SEED)));
  a.log("match started; seeds", seeds.join(" "));
  assert.equal(new Set(seeds).size, 1, "every client must deal the same pieces");
  assert.notEqual(seeds[0], 0);

  // end two wells; the survivor must be the sole winner
  for (const g of [b, c]) {
    await g.page.evaluate(() => { G.die(); });
    g.log("topped out after", await g.page.evaluate(() => G.lasted()), "ms");
  }

  await a.page.waitForFunction(() => window.__won !== null);
  a.log("round resolved");

  for (const g of cs) await g.page.waitForFunction(() => window.__won !== null);
  const results = await Promise.all(cs.map(async g => ({
    name: g.name,
    won: await g.page.evaluate(() => window.__won === true),
  })));
  for (const r of results) a.log("result", r.name, r.won ? "WIN" : "loss");
  assert.equal(results.filter(r => r.won).length, 1, "exactly one winner: " + JSON.stringify(results));

  await a.page.waitForFunction(() => RoomClient.view().seats.some(s => s.pid === PID && s.w === 1));
  a.log("win recorded on the winner's seat");

  for (const g of cs) {
    await g.page.evaluate(() => RoomClient.leave());
    g.log("left");
  }
  assert.equal(mock.tree().rooms, undefined, "no room may survive everyone leaving");
  assert.equal(mock.tree().lobby, undefined, "no ghost room may remain listed");
  a.log("room fully cleaned up");

  for (const g of cs) assert.deepEqual(g.errors, [], g.name + " console errors");

  for (const g of cs) await g.close();
  await serve.close(); await mock.close();
});

test("a spectator sits the round out and does not block it", async () => {
  const mock = await startMock({ port: 0 });
  const serve = await startServe({ root: process.cwd(), port: 0 });
  const cs = await openClients(3, {
    mockUrl: mock.url,
    pageUrl: serve.url + "/Tetris_version1.html",
    name: "S",
  });
  const [a, b, c] = cs;

  const id = await a.page.evaluate(() => RoomClient.create());
  for (const g of [b, c]) await g.page.evaluate(i => RoomClient.join(i), id);
  for (const g of cs) await g.page.waitForFunction(() => RoomClient.view().seats.length === 3);

  await c.page.evaluate(() => RoomClient.setSpectating(true));
  c.log("spectating");
  for (const g of cs) await g.page.waitForFunction(() => RoomClient.view().seats.filter(s => s.spec).length === 1);

  // only the two players ready up; the match must still start
  for (const g of [a, b]) await g.page.evaluate(() => RoomClient.setReady(true));
  for (const g of [a, b]) await g.page.waitForFunction(() => G && G.mode === "versus" && !G.over);
  a.log("match started with two players and one spectator");

  const roster = mock.tree().rooms[id].go.roster;
  assert.equal(Object.keys(roster).length, 2);
  assert.equal(await c.page.evaluate(() => !!(G && G.spectating)), true, "the spectator's well sits out");

  for (const g of cs) await g.page.evaluate(() => RoomClient.leave());
  for (const g of cs) await g.close();
  await serve.close(); await mock.close();
});

test.after(shutdown);
