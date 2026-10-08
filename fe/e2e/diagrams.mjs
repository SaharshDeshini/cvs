// Browser check for the diagrams (arrays, pointers, lists, trees, STL): runs real programs through the real backend and
// asserts on what the page actually shows. Prereqs: Docker running, runner image built, backend on :5000, `npm run dev`.
// Usage: APP_URL=http://localhost:5173/ node e2e/diagrams.mjs [screenshotDir]
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";

const CHROME = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const URL = process.env.APP_URL ?? "http://localhost:5173/";
const FIXTURES = path.join(import.meta.dirname, "..", "..", "bk", "src", "tests", "fixtures");
const shots = process.argv[2] ?? "e2e/shots";
mkdirSync(shots, { recursive: true });

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 1000 });
const problems = [];
page.on("console", (m) => { if (m.type() === "error") problems.push(`console: ${m.text()}`); });
page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));

let passed = 0;
const check = (name, fn) => fn().then(() => { passed += 1; console.log(`ok  ${name}`); });
const texts = (selector) => page.$$eval(selector, (els) => els.map((el) => el.textContent.trim()));
const count = (selector) => page.$$eval(selector, (els) => els.length);

/** Pastes a fixture into the editor, runs it, and steps forward `steps` times. */
async function load(fixture, steps) {
  await page.goto(URL, { waitUntil: "networkidle0" });
  await page.click(".cm-content");
  await page.keyboard.down("Control"); await page.keyboard.press("a"); await page.keyboard.up("Control");
  const source = readFileSync(path.join(FIXTURES, `${fixture}.cpp`), "utf8");
  await page.evaluate((text) => {
    const data = new DataTransfer();
    data.setData("text/plain", text);
    document.querySelector(".cm-content").dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, source);
  await page.click(".btn-run");
  await page.waitForFunction(() => document.querySelector(".chip")?.className.includes("chip-ready"), { timeout: 90000 });
  await page.evaluate(() => document.activeElement?.blur());
  for (let i = 0; i < steps; i += 1) await page.keyboard.press("ArrowRight");
  await new Promise((resolve) => setTimeout(resolve, 350)); // arrows are measured after layout
}
const shot = (name) => page.screenshot({ path: path.join(shots, `${name}.png`) });
const rect = (selector, index = 0) => page.$$eval(selector, (els, i) => { const r = els[i].getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }, index);

await check("bubble sort: cells, loop-variable markers, and the cell that just changed", async () => {
  await load("bubble", 21);
  assert.deepEqual(await texts(".array .cell:not(.cell-more) .cell-text"), ["2", "5", "1", "7", "9", "3"]);
  assert.deepEqual(await texts(".cell-marker"), ["i", "j"]);
  assert.ok((await count(".cell.is-changed")) >= 1, "the cell written by the swap is flagged");
  await shot("bubble");
});

await check("a 1,000-element array shows a window and says how many cells are hidden", async () => {
  await load("bigarray", 40);
  assert.equal(await count(".array .cell:not(.cell-more)"), 64);
  assert.deepEqual(await texts(".cell-more"), ["+936 more"]);
  await shot("bigarray");
});

await check("pointers: arrow into an array element, into a live heap block, and a dangling one to a freed block", async () => {
  await load("pointers", 12);
  assert.equal(await count("svg.arrows path.arrow"), 3);
  assert.equal(await count("svg.arrows path.arrow-dangling"), 1);
  assert.equal(await count(".badge-freed"), 1);
  assert.equal(await count(".node-freed"), 1);
  const cell2 = await rect(".array .cell", 2);
  const ends = await page.$$eval("svg.arrows path.arrow-normal", (paths) => {
    const origin = paths[0].ownerSVGElement.getBoundingClientRect();
    return paths.map((p) => { const end = p.getPointAtLength(p.getTotalLength()); return { x: origin.x + end.x, y: origin.y + end.y }; });
  });
  // p's row is below the array, so its arrow comes up from underneath and lands on the cell's bottom edge
  const lands = (end) => end.x >= cell2.x && end.x <= cell2.x + cell2.w && Math.abs(end.y - (cell2.y + cell2.h)) < 4;
  assert.ok(ends.some(lands), `one arrow ends on arr[2] (where p = arr + 2 points); ends: ${JSON.stringify(ends)}, cell: ${JSON.stringify(cell2)}`);
  await shot("pointers");
});

await check("linked list: three nodes in order, with the pointers drawn between them", async () => {
  await load("list", 38);
  assert.deepEqual(await texts(".chain .node-box .struct-field:first-child .var-value"), ["1", "2", "3"]);
  assert.equal(await count("svg.arrows path.arrow"), 4); // reverse.prev, main.head, node1.next, node2.next
  const [first, second] = [await rect(".chain-item .node-box", 0), await rect(".chain-item .node-box", 1)];
  assert.ok(second.x > first.x + first.w, "nodes run left to right");
  await shot("list-reversed");
});

await check("reversal in progress: the list is two pieces, and each piece is its own structure", async () => {
  await load("list", 25);
  assert.deepEqual(await texts(".structure-title"), ["Linked list", "Linked list"]);
  await shot("list-mid-reversal");
});

await check("binary tree: root above its children, left child left of the root, right child to the right", async () => {
  await load("bst", 62);
  assert.deepEqual(await texts(".structure-title"), ["Binary tree"]);
  assert.equal(await count(".tree .node-box"), 5);
  const keys = await page.$$eval(".tree-branch", (branches) => branches.map((b) => b.querySelector(":scope > .node-box .struct-field:first-child .var-value").textContent));
  assert.deepEqual(keys, ["50", "30", "20", "40", "70"], "depth-first, left before right");
  const [root, left, right] = [await rect(".tree .node-box", 0), await rect(".tree .node-box", 1), await rect(".tree .node-box", 4)];
  assert.ok(left.y > root.y + root.h && right.y > root.y + root.h, "children sit below the root");
  assert.ok(left.x < root.x && right.x > root.x, "left child is on the left, right child on the right");
  assert.equal(await count("svg.arrows path.arrow"), 5); // main.root + four child links
  await shot("bst");
});

await check("STL: vector as cells, string as text, map as key -> value rows", async () => {
  await load("stl", 8);
  assert.deepEqual(await texts(".array .cell .cell-text"), ["3", "1", "2", "9"]);
  assert.ok((await texts(".var-value.kind-string")).includes('"hello"'));
  assert.deepEqual(await texts(".map-row"), ['"one"→1', '"two"→2']);
  await shot("stl");
});

await check("a narrow window keeps every arrow and lets a wide structure scroll instead of breaking", async () => {
  await page.setViewport({ width: 900, height: 900 });
  await load("list", 38);
  assert.equal(await count("svg.arrows path.arrow"), 4);
  assert.equal(await count(".node-box"), 3);
  await shot("list-narrow");
  await page.setViewport({ width: 1440, height: 1000 });
});

await check("no console errors or page errors across all of it", async () => {
  assert.deepEqual(problems, []);
});

console.log(`\n${passed} checks passed`);
await browser.close();
