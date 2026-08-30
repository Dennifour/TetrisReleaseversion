// Drives N browser clients against one mock. Logs progress; takes no screenshots.
import { chromium } from "playwright";

let browser = null;
const stamp = () => new Date().toISOString().slice(11, 23);

// Replaces navigator.getGamepads with a scriptable fake. `pads` is the initial
// list; tests drive it through window.__pads afterwards.
export const fakeGamepads = pads => `
  window.__pads = ${JSON.stringify(pads)};
  navigator.getGamepads = () => window.__pads.map(p => p && ({
    connected: true, id: p.id || "fake", mapping: p.mapping || "",
    axes: p.axes || [0, 0],
    buttons: (p.buttons || []).map(b => ({ pressed: !!b, value: b ? 1 : 0 })),
  }));
`;

export async function openClients(n, { mockUrl, pageUrl, name = "C", init = null }) {
  browser = browser || await chromium.launch();
  const out = [];
  for (let i = 0; i < n; i++) {
    const label = n === 1 ? name : name + (i + 1);
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const errors = [];
    page.on("console", m => {
      if (m.type() === "error") errors.push(m.text());
      console.log(`${stamp()} [${label}] ${m.text()}`);
    });
    page.on("pageerror", e => {
      errors.push(String(e));
      console.log(`${stamp()} [${label}] PAGEERROR ${e}`);
    });
    // seed the signalling URL before any script runs
    await page.addInitScript(u => localStorage.setItem("tfx:fbUrl", JSON.stringify(u)), mockUrl);
    if (init) await page.addInitScript(init);
    await page.goto(pageUrl);
    await page.waitForFunction(() => typeof CFG !== "undefined");
    out.push({
      name: label,
      page,
      errors,
      log: (...a) => console.log(`${stamp()} [${label}]`, ...a),
      close: () => ctx.close(),
    });
  }
  return out;
}

export async function shutdown() {
  if (browser) { await browser.close(); browser = null; }
}
