import { test } from "node:test";
import assert from "node:assert/strict";
import { startMock } from "./mock-rtdb.js";
import { startServe } from "./serve.js";
import { openClients, shutdown } from "./harness.mjs";

test("every screen and settings tab opens without a console error", async () => {
  const mock = await startMock({ port: 0 });
  const serve = await startServe({ root: process.cwd(), port: 0 });
  const [c] = await openClients(1, {
    mockUrl: mock.url, pageUrl: serve.url + "/Tetris_version1.html", name: "S",
  });

  const screens = ["#v-home", "#v-play", "#v-speed", "#v-records", "#v-lobby", "#v-set", "#v-host", "#v-join"];
  for (const s of screens) {
    await c.page.evaluate(id => UI.show(id), s);
    await c.page.waitForTimeout(160);
    assert.equal(await c.page.evaluate(() => UI.cur), s, "failed to open " + s);
  }
  for (const tab of ["general", "video", "audio", "controls", "online"]) {
    await c.page.evaluate(t => { UI.show("#v-set"); UI.openTab(t); }, tab);
    await c.page.waitForTimeout(120);
  }
  // the panels added in batch 3 must actually render
  assert.ok(await c.page.evaluate(() => !!document.querySelector("#preset-rows")?.children.length),
    "the presets panel should render");
  assert.ok(await c.page.evaluate(() => !!document.querySelector("#b-export")), "export button present");
  assert.match(await c.page.evaluate(() => document.querySelector("#panel-audio").textContent),
    /updated|업데이트/, "the audio panel should say it is to be updated");

  await c.page.evaluate(() => startGame("solo"));
  await c.page.waitForTimeout(400);
  assert.ok(await c.page.evaluate(() => !!G), "a solo run should start");

  const errs = c.errors.filter(e => !/favicon/i.test(e));
  assert.deepEqual(errs, [], "console errors: " + errs.join(" | "));

  await c.close(); await serve.close(); await mock.close();
});

test.after(shutdown);
