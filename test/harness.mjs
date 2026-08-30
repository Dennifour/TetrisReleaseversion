// Drives N browser clients against one mock. Logs progress; takes no screenshots.
import { chromium } from "playwright";

let browser = null;
const stamp = () => new Date().toISOString().slice(11, 23);

export async function openClients(n, { mockUrl, pageUrl, name = "C" }) {
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
