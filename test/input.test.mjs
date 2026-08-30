import { test } from "node:test";
import assert from "node:assert/strict";
import { startMock } from "./mock-rtdb.js";
import { startServe } from "./serve.js";
import { openClients, shutdown, fakeGamepads } from "./harness.mjs";

const boot = async pads => {
  const mock = await startMock({ port: 0 });
  const serve = await startServe({ root: process.cwd(), port: 0 });
  const [c] = await openClients(1, {
    mockUrl: mock.url,
    pageUrl: serve.url + "/Tetris_version1.html",
    name: "I",
    init: pads ? fakeGamepads(pads) : null,
  });
  // record everything that reaches the single input choke point
  await c.page.evaluate(() => {
    window.__fired = [];
    const p = Input.press.bind(Input), r = Input.release.bind(Input);
    Input.press = a => { window.__fired.push("+" + a); return p(a); };
    Input.release = a => { window.__fired.push("-" + a); return r(a); };
  });
  return { c, end: async () => { await c.close(); await serve.close(); await mock.close(); } };
};

// A bluetooth keyboard that enumerates through the Gamepad API: non-standard
// mapping, and a resting axis well past the deadzone.
const BT_KEYBOARD = [{ id: "BT Keyboard", mapping: "", axes: [0.9, 0], buttons: [false, false] }];
const REAL_PAD = [{ id: "Xbox Controller", mapping: "standard", axes: [0, 0], buttons: Array(16).fill(false) }];

test("an idle bluetooth keyboard is not adopted as the controller", async () => {
  const { c, end } = await boot(BT_KEYBOARD);
  const out = await c.page.evaluate(() => {
    CFG.padOn = true;
    for (let i = 0; i < 10; i++) Pad.poll();
    return { fired: window.__fired, active: Pad.activeId() };
  });
  assert.deepEqual(out.fired, [], "a resting device must produce no input at all");
  assert.equal(out.active, null, "it must not be adopted as the active pad");
  await end();
});

test("a resting axis offset never latches a direction", async () => {
  const { c, end } = await boot(BT_KEYBOARD);
  const fired = await c.page.evaluate(() => {
    CFG.padOn = true;
    Pad.poll();
    // even once the device is used, its rest position is the zero point
    window.__pads[0].buttons[0] = true; Pad.poll();
    window.__pads[0].buttons[0] = false; Pad.poll();
    return window.__fired.filter(f => /left|right/.test(f));
  });
  assert.deepEqual(fired, [], "an axis at rest is zero, whatever value it reports");
  await end();
});

test("a real controller drives input once it is actually used", async () => {
  const { c, end } = await boot(REAL_PAD);
  const out = await c.page.evaluate(() => {
    CFG.padOn = true;
    Pad.poll();
    const before = Pad.activeId();
    const btn = CFG.pads.hardDrop[0];
    window.__pads[0].buttons[btn] = true; Pad.poll();
    window.__pads[0].buttons[btn] = false; Pad.poll();
    return { before, after: Pad.activeId(), fired: window.__fired };
  });
  assert.equal(out.before, null, "an untouched pad is not yet active");
  assert.equal(out.after, "Xbox Controller", "using it makes it active");
  assert.ok(out.fired.includes("+hardDrop"), "fired: " + out.fired);
  await end();
});

test("a real controller's stick still moves the piece", async () => {
  const { c, end } = await boot(REAL_PAD);
  const fired = await c.page.evaluate(() => {
    CFG.padOn = true;
    Pad.poll();
    window.__pads[0].buttons[0] = true; Pad.poll();      // wake it
    window.__pads[0].buttons[0] = false; Pad.poll();
    window.__fired.length = 0;
    window.__pads[0].axes[0] = -0.9; Pad.poll();
    window.__pads[0].axes[0] = 0; Pad.poll();
    return window.__fired;
  });
  assert.ok(fired.includes("+left"), "fired: " + fired);
  assert.ok(fired.includes("-left"), "fired: " + fired);
  await end();
});

test("the last-used device is tracked and distinguishes keyboard from pad", async () => {
  const { c, end } = await boot(REAL_PAD);
  const out = await c.page.evaluate(() => {
    CFG.padOn = true;
    const seen = {};
    dispatchEvent(new KeyboardEvent("keydown", { code: CFG.keys.left[0] }));
    seen.afterKey = LastDevice.kind;
    dispatchEvent(new KeyboardEvent("keyup", { code: CFG.keys.left[0] }));
    window.__pads[0].buttons[CFG.pads.hardDrop[0]] = true; Pad.poll();
    seen.afterPad = LastDevice.kind;
    return seen;
  });
  assert.equal(out.afterKey, "key");
  assert.equal(out.afterPad, "pad");
  await end();
});

test.after(shutdown);
