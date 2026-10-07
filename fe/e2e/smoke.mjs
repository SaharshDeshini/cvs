// Browser smoke test: drives the real UI (Vite dev server) against the real backend with system Chrome.
// Prereqs: Docker running, runner image built, backend on :5000, `npm run dev` on :5173.
// Usage: node e2e/smoke.mjs [screenshotDir]
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";

const CHROME = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const URL = process.env.APP_URL ?? "http://127.0.0.1:5173/";
const shots = process.argv[2] ?? "e2e/shots";
mkdirSync(shots, { recursive: true });

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 860 });
const problems = [];
page.on("console", (m) => { if (m.type() === "error") problems.push(`console: ${m.text()}`); });
page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));

const text = (selector) => page.$eval(selector, (el) => el.textContent.trim());
const count = (selector) => page.$$eval(selector, (els) => els.length);
const shot = (name) => page.screenshot({ path: path.join(shots, `${name}.png`) });
const waitChip = (label) => page.waitForFunction((l) => document.querySelector(".chip")?.textContent === l, { timeout: 90000 }, label);
const step = async () => (await text(".step-count")).replace(/\s+/g, "");
let passed = 0;
const check = (name, fn) => fn().then(() => { passed += 1; console.log(`ok  ${name}`); });

async function replaceCode(source) {
  await page.click(".cm-content");
  await page.keyboard.down("Control"); await page.keyboard.press("a"); await page.keyboard.up("Control");
  await page.keyboard.type(source);
}

await page.goto(URL, { waitUntil: "networkidle0" });
await check("empty state is shown before any run", async () => {
  assert.match(await text(".empty-title"), /Run your code/);
  assert.equal(await page.$eval(".btn-icon", (b) => b.disabled), true, "step buttons disabled without a trace");
  await shot("1-empty");
});

await check("Run produces a trace and highlights the current line", async () => {
  await page.click(".btn-run");
  await waitChip("traced");
  assert.equal(await count(".frame-card.is-current"), 1);
  assert.equal(await count(".cm-exec-line"), 1);
  assert.match(await step(), /^1\/\d+$/);
  await shot("2-first-step");
});

await check("keyboard: ArrowRight steps forward, ArrowLeft back, Home resets", async () => {
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  assert.match(await step(), /^3\//);
  await page.keyboard.press("ArrowLeft");
  assert.match(await step(), /^2\//);
  await page.keyboard.press("Home");
  assert.match(await step(), /^1\//);
});

await check("stepping into factorial shows a deeper stack with the current frame on top", async () => {
  for (let i = 0; i < 40; i += 1) {
    await page.keyboard.press("ArrowRight");
    const names = await page.$$eval(".frame-fn", (els) => els.map((e) => e.textContent));
    if (names.length >= 3 && names[0] === "factorial()") break;
  }
  const names = await page.$$eval(".frame-fn", (els) => els.map((e) => e.textContent));
  assert.ok(names.length >= 3, `expected a recursive stack, got ${names}`);
  assert.equal(names.at(-1), "main()", "caller is at the bottom");
  assert.equal(await page.$eval(".frame-card.is-current .frame-fn", (e) => e.textContent), "factorial()");
  await shot("3-recursion");
});

await check("a changed variable is flagged for the flash animation", async () => {
  await page.keyboard.press("Home");
  let flagged = 0;
  for (let i = 0; i < 12; i += 1) {
    await page.keyboard.press("ArrowRight");
    flagged += await count(".var-value.is-changed");
  }
  assert.ok(flagged > 0, "no value was ever marked as changed");
});

await check("scrubber seeks and play advances then stops at the end", async () => {
  await page.$eval(".scrubber", (el) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, el.max);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const last = await step();
  assert.equal(last.split("/")[0], last.split("/")[1], "scrubber jumped to the last step");
  assert.match(await text(".output-text"), /total = 9/); // 1! + 2! + 3! = 1 + 2 + 6
  await shot("4-last-step-output");
  await page.keyboard.press("Home");
  await page.select(".speed select", "4"); // 8x
  await page.click(".btn-play");
  await page.waitForFunction(() => { const [a, b] = document.querySelector(".step-count").textContent.replace(/\s+/g, "").split("/"); return a === b; }, { timeout: 20000 });
  assert.equal(await page.$eval(".btn-play", (b) => b.getAttribute("aria-label")), "Play", "playback paused itself at the end");
});

await check("editing the code marks the trace stale and hides the line highlight", async () => {
  await page.click(".cm-content");
  await page.keyboard.type(" ");
  await page.waitForSelector(".banner.is-notice");
  assert.equal(await count(".cm-exec-line"), 0);
  assert.match(await text(".step-line"), /code edited/);
  await shot("5-stale");
});

await check("compile error lists diagnostics and marks the offending line", async () => {
  await replaceCode('int main() { int x = "oops"; return 0; }');
  let posts = 0;
  const countPosts = (request) => { if (request.method() === "POST" && request.url().endsWith("/api/trace")) posts += 1; };
  page.on("request", countPosts);
  await page.keyboard.down("Control"); await page.keyboard.press("Enter"); await page.keyboard.up("Control");
  await page.waitForSelector(".diagnostics", { timeout: 90000 });
  page.off("request", countPosts);
  assert.equal(posts, 1, "Ctrl+Enter in the editor must start exactly one run");
  assert.match(await text(".banner.is-problem strong"), /Compilation failed/);
  assert.equal(await count(".banner.is-problem .banner-message"), 0, "title must not be repeated as a message");
  assert.equal(await text(".chip"), "compile error", "chip must not claim success");
  assert.ok((await count(".diagnostics li")) >= 1);
  assert.equal(await count(".cm-error-line"), 1);
  await shot("6-compile-error");
});

await check("a crash is shown as a problem but stays steppable", async () => {
  await replaceCode("int main() { int* p = nullptr; int x = 5; *p = x; return 0; }");
  await page.click(".btn-run");
  await page.waitForFunction(() => document.querySelector(".banner.is-problem strong")?.textContent.includes("crashed"), { timeout: 90000 });
  assert.match(await text(".banner.is-problem"), /SIGSEGV/);
  assert.ok((await count(".frame-card")) >= 1);
  await shot("7-crash");
});

await check("recursion unwinds one frame at a time and each return value is shown", async () => {
  await replaceCode("#include <iostream>\nint fact(int n) { if (n <= 1) return 1; return n * fact(n - 1); }\nint main() { int r = fact(3); std::cout << r << std::endl; return 0; }");
  await page.click(".btn-run");
  await waitChip("traced");
  await page.keyboard.press("Home");
  const total = Number((await step()).split("/")[1]);
  const depths = [];
  const returned = [];
  for (let i = 0; i < total; i += 1) {
    depths.push(Number((await text(".panel-meta")).split(" ")[0]));
    for (const label of await page.$$eval(".frame-returned", (els) => els.map((e) => e.getAttribute("aria-label")))) returned.push(label);
    await page.keyboard.press("ArrowRight");
  }
  for (let i = 1; i < depths.length; i += 1) assert.ok(depths[i - 1] - depths[i] <= 1, `stack depth jumped: ${depths}`);
  assert.deepEqual(returned, ["fact returned 1", "fact returned 2", "fact returned 6"]);
  await shot("8-returns");
});

await check("the output panel fills in as the program prints, one line per step", async () => {
  // several lines on purpose: the tracer steps by source line, so a one-line main is a single step
  await replaceCode('#include <iostream>\nint main() {\nfor (int i = 0; i < 3; i++) {\nstd::cout << "ab\\n";\n}\nreturn 0;\n}');
  await page.click(".btn-run");
  await waitChip("traced");
  await page.keyboard.press("Home");
  const total = Number((await step()).split("/")[1]);
  const seen = new Set();
  for (let i = 0; i < total; i += 1) {
    seen.add(await page.$eval('[aria-label="Program stdout"]', (el) => el.textContent));
    await page.keyboard.press("ArrowRight");
  }
  assert.ok(seen.has("ab\n") && seen.has("ab\nab\n"), `output states seen: ${JSON.stringify([...seen])}`);
  await shot("9-output");
});

await check("program text is rendered as text, never as HTML", async () => {
  await replaceCode('#include <iostream>\nint main(){ std::cout << "<img src=x onerror=window.__pwned=1>"; return 0; }');
  await page.click(".btn-run");
  await waitChip("traced");
  await page.$eval(".scrubber", (el) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, el.max);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  assert.equal(await count(".output-text img"), 0);
  assert.equal(await page.evaluate(() => window.__pwned), undefined);
  assert.match(await text(".output-text"), /<img src=x/);
});

await check("Space on the stdin summary opens it instead of toggling playback", async () => {
  await page.focus(".stdin summary");
  await page.keyboard.press("Space");
  assert.equal(await page.$eval(".stdin", (el) => el.open), true);
  assert.equal(await page.$eval(".btn-play", (b) => b.getAttribute("aria-label")), "Play", "playback must not have started");
  await page.keyboard.press("Space");
});

await check("Alt+ArrowRight inside the editor does not step when the editor handles the key", async () => {
  const before = await step();
  await page.click(".cm-content");
  await page.keyboard.down("Control"); await page.keyboard.press("ArrowLeft"); await page.keyboard.up("Control");
  assert.equal(await step(), before, "plain caret movement must never step the trace");
});

await check("narrow viewport stacks the panes without horizontal overflow", async () => {
  await page.setViewport({ width: 600, height: 900 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  assert.equal(overflow, false);
  await shot("8-narrow");
  await page.setViewport({ width: 1440, height: 860 });
});

await check("backend down gives a readable error, not a blank screen", async () => {
  await page.setRequestInterception(true);
  page.once("request", (request) => request.abort("connectionrefused"));
  await page.click(".btn-run");
  await page.waitForSelector(".banner.is-problem");
  assert.match(await text(".banner.is-problem"), /Cannot reach the backend/);
  await page.setRequestInterception(false);
  await shot("9-backend-down");
});

const unexpected = problems.filter((p) => !/Failed to load resource|ERR_CONNECTION_REFUSED|net::ERR/.test(p));
await browser.close();
assert.deepEqual(unexpected, [], `unexpected console errors:\n${unexpected.join("\n")}`);
console.log(`\n${passed} checks passed`);
