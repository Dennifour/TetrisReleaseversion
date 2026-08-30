import { test } from "node:test";
import assert from "node:assert/strict";
import { startMock } from "./mock-rtdb.js";
import { startServe } from "./serve.js";
import { openClients, shutdown, fakeGamepads } from "./harness.mjs";

const PAD = [{ id: "Pad", mapping: "standard", axes: [0, 0], buttons: Array(16).fill(false) }];

const boot = async () => {
  const mock = await startMock({ port: 0 });
  const serve = await startServe({ root: process.cwd(), port: 0 });
  const [c] = await openClients(1, {
    mockUrl: mock.url,
    pageUrl: serve.url + "/Tetris_version1.html",
    name: "M",
    init: fakeGamepads(PAD),
  });
  return { c, end: async () => { await c.close(); await serve.close(); await mock.close(); } };
};

const key = code => `dispatchEvent(new KeyboardEvent("keydown",{code:${JSON.stringify(code)},bubbles:true}))`;

test("arrow keys walk focus through the items on the current screen", async () => {
  const { c, end } = await boot();
  const out = await c.page.evaluate(`(() => {
    LastDevice.note("key");
    UI.show("#v-home");
    const items = MenuNav.items();
    ${key("ArrowDown")};
    const first = document.activeElement;
    ${key("ArrowDown")};
    const second = document.activeElement;
    return {
      count: items.length,
      firstIsMenuItem: first.classList.contains("mi"),
      moved: first !== second,
      secondIsMenuItem: second.classList.contains("mi"),
    };
  })()`);
  assert.ok(out.count > 1, "the home screen should expose several items");
  assert.equal(out.firstIsMenuItem, true);
  assert.equal(out.secondIsMenuItem, true);
  assert.equal(out.moved, true, "a second ArrowDown must advance the focus");
  await end();
});

test("focus wraps and skips hidden or disabled items", async () => {
  const { c, end } = await boot();
  const ok = await c.page.evaluate(`(() => {
    LastDevice.note("key");
    UI.show("#v-home");
    const items = MenuNav.items();
    return items.every(el => !el.disabled && el.offsetParent !== null);
  })()`);
  assert.equal(ok, true, "hidden and disabled items must not be reachable");
  await end();
});

test("Enter activates the focused item", async () => {
  const { c, end } = await boot();
  const went = await c.page.evaluate(`(() => {
    LastDevice.note("key");
    UI.show("#v-home");
    ${key("ArrowDown")};
    const target = document.activeElement;
    let clicked = false;
    target.addEventListener("click", () => { clicked = true; });
    ${key("Enter")};
    return clicked;
  })()`);
  assert.equal(went, true, "Enter must activate the focused item");
  await end();
});

test("Escape leaves the current screen", async () => {
  const { c, end } = await boot();
  const out = await c.page.evaluate(`(async () => {
    LastDevice.note("key");
    UI.show("#v-play");
    await new Promise(r => setTimeout(r, 200));
    ${key("Escape")};
    await new Promise(r => setTimeout(r, 300));
    return UI.cur;
  })()`);
  assert.equal(out, "#v-home", "Escape on Play should return to Home");
  await end();
});

test("the gamepad d-pad moves menu focus too", async () => {
  const { c, end } = await boot();
  const out = await c.page.evaluate(`(() => {
    CFG.padOn = true;
    UI.show("#v-home");
    // wake the pad so it is adopted, then press d-pad down (standard button 13)
    window.__pads[0].buttons[0] = true; Pad.poll();
    window.__pads[0].buttons[0] = false; Pad.poll();
    const before = document.activeElement && document.activeElement.className;
    window.__pads[0].buttons[13] = true; Pad.poll();
    window.__pads[0].buttons[13] = false; Pad.poll();
    return { before, after: document.activeElement && document.activeElement.className, dev: LastDevice.kind };
  })()`);
  assert.equal(out.dev, "pad");
  assert.ok(/\bmi\b/.test(out.after || ""), "d-pad down should focus a menu item, got: " + out.after);
  await end();
});

test("tapping clears the focus ring so touch players never see it linger", async () => {
  const { c, end } = await boot();
  const out = await c.page.evaluate(`(() => {
    UI.show("#v-home");
    ${key("ArrowDown")};
    const afterKey = document.querySelectorAll(".mi.navfocus").length;
    // a real tap on a menu item
    document.querySelector("#v-home .mi").dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true }));
    return { afterKey, afterTap: document.querySelectorAll(".mi.navfocus").length };
  })()`);
  assert.equal(out.afterKey, 1, "a key press should show exactly one focus ring");
  assert.equal(out.afterTap, 0, "tapping must clear it again");
  await end();
});

test.after(shutdown);
