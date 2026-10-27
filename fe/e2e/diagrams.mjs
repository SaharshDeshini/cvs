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

await check("a pointer still in a register is 'in transit', not a leak (build() has just returned its list)", async () => {
  await load("lifecycle", 19);
  assert.equal(await count(".badge-transit"), 1);
  assert.equal(await count(".badge-leaked"), 0);
  assert.equal(await count(".leak-tray"), 0);
  await shot("lifecycle-transit");
});

await check("memory that really leaks is collected in its own tray with a byte count, and the live heap stays separate", async () => {
  await load("lifecycle", 40);
  assert.equal(await count(".leak-tray"), 1);
  assert.equal(await count(".leak-tray .badge-leaked"), 1);
  assert.equal(await count(".badge-transit"), 0);
  const [meta] = await texts(".leak-meta");
  assert.match(meta, /2 blocks · 32 bytes never freed/);
  assert.equal(await count(".heap-structures > .structure:not(.is-leaked)"), 1, "the freed node the dangling pointer still names stays in the live heap");
  await shot("lifecycle-leak");
});

await check("findings: the leak and the dangling pointer are listed, the delete-then-reassign idiom is not", async () => {
  await load("lifecycle", 40);
  const findings = await texts(".finding");
  assert.equal(findings.length, 2, findings.join(" | "));
  assert.match(findings[0], /^Leak: 2 blocks/);
  assert.match(findings[1], /^Dangling pointer: list/);
  assert.equal(await count(".tl-bug"), 2);
  assert.match((await texts(".caption"))[0], /^Step 41/);
});

await check("timeline: clicking a problem marker jumps to that step and shows its explanation", async () => {
  await load("lifecycle", 0);
  await page.click(".tl-bug.is-bad");
  const [readout] = await texts(".step-count");
  assert.match(readout, /^25 \/ 41/);
  assert.equal(await count(".bug-card.is-bad"), 1);
  assert.match((await texts(".bug-detail"))[0], /32 bytes/);
  await shot("timeline-leak");
});

await check("inline values: the line about to run shows the variables it uses, and only those", async () => {
  await load("rangefor", 4);
  assert.deepEqual(await texts(".cm-inline-values"), ["sum = 0   x = 4"]);
});

await check("hover tracing: pointing at a pointer lights its arrow and rings its target; leaving restores everything", async () => {
  await load("list", 30);
  await page.hover(".stack .frame-card.is-current .ptr");
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.ok((await count("svg.arrows g.is-focus")) >= 1, "the hovered pointer's arrow is lit");
  assert.ok((await count("svg.arrows g.is-dim")) >= 1, "the other arrows fade");
  assert.ok((await count("svg.arrows .focus-ring")) >= 1, "the target is ringed");
  await shot("hover-trace");
  await page.mouse.move(5, 5);
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(await count("svg.arrows g.is-focus"), 0);
  assert.equal(await count("svg.arrows g.is-dim"), 0);
});

const readout = async () => (await texts(".step-count"))[0];
const waitReadout = (pattern) => page.waitForFunction((source) => new RegExp(source).test(document.querySelector(".step-count")?.textContent ?? ""), { timeout: 90000 }, pattern.source);
const chord = async (...keys) => { for (const key of keys) await page.keyboard.down(key); for (const key of keys.reverse()) await page.keyboard.up(key); };

await check("Ctrl+Enter runs the program from the editor and from the stdin box (a re-run starts back at step 1)", async () => {
  await load("lifecycle", 3);
  assert.match(await readout(), /^4 \/ 41/);
  await page.click(".cm-content");
  await chord("Control", "Enter");
  await waitReadout(/^1 \/ 41/);
  for (let i = 0; i < 3; i += 1) await page.click("button[aria-label='Next step']");
  assert.match(await readout(), /^4 \/ 41/);
  await page.click(".stdin summary");
  await page.click(".stdin textarea");
  await chord("Control", "Enter");
  await waitReadout(/^1 \/ 41/);
});

await check("keys: End, PageDown/PageUp, and [ ] jump between steps and problems; none of them act while typing", async () => {
  await load("lifecycle", 0);
  await page.keyboard.press("End");
  assert.match(await readout(), /^41 \/ 41/);
  await page.keyboard.press("PageUp");
  assert.match(await readout(), /^31 \/ 41/);
  await page.keyboard.press("Home");
  await page.keyboard.press("PageDown");
  assert.match(await readout(), /^11 \/ 41/);
  await page.keyboard.press("]");
  assert.match(await readout(), /^25 \/ 41/, "first problem (the leak)");
  await page.keyboard.press("]");
  assert.match(await readout(), /^29 \/ 41/, "second problem (the dangling pointer)");
  await page.keyboard.press("]");
  assert.match(await readout(), /^29 \/ 41/, "no further problem: stays put");
  await page.keyboard.press("[");
  assert.match(await readout(), /^25 \/ 41/);
  await page.click(".cm-content");
  await page.keyboard.press("End"); // typing in the editor: End moves the caret, not the playhead
  assert.match(await readout(), /^25 \/ 41/);
  await page.evaluate(() => document.activeElement?.blur());
  await page.click(".shortcuts summary");
  assert.equal(await count(".shortcut-row"), 11); // 10 stepping/run keys + Alt+A for the AI assistant
  assert.ok((await texts(".shortcut-row dd")).includes("Open / close the AI assistant"));
  await shot("shortcuts");
});

await check("binary search: the discarded half is dimmed, the live range is lit and labelled, even between iterations", async () => {
  await load("binsearch", 9);
  assert.deepEqual(await texts(".range-chip"), ["search range [4..7]"]);
  assert.equal(await count(".cell.out-range"), 4);
  assert.equal(await count(".cell.in-range"), 4);
  assert.deepEqual(await texts(".cell-marker"), ["lo", "hi"]);
  await shot("binsearch");
});

await check("binary search written with left/right stays a search on EVERY step (mid is out of scope between iterations)", async () => {
  await load("binsearch_lr", 0);
  const total = Number((await readout()).split("/")[1]);
  const modes = new Set();
  for (let step = 0; step < total; step += 1) {
    const classes = await page.$$eval(".range-chip", (els) => els.map((el) => el.className));
    for (const name of classes) modes.add(name.includes("is-search") ? "search" : "window");
    await page.keyboard.press("ArrowRight");
  }
  assert.deepEqual([...modes], ["search"], `modes seen: ${[...modes].join(",")}`);
});

await check("sliding window: the window is lit, and `k` (the window size) is not mistaken for a position", async () => {
  await load("window", 26);
  assert.deepEqual(await texts(".range-chip"), ["window [1..4] · 4 cells"]);
  assert.equal(await count(".cell.in-range"), 4);
  assert.deepEqual(await texts(".cell-marker"), ["left", "right"]);
});

await check("two pointers: each pointer variable is a tag on the cell it points at", async () => {
  await load("twoptr", 12);
  assert.deepEqual(await texts(".cell-tag"), ["lp", "rp"]);
  const cell = await rect(".array .cell", 0);
  const tag = await rect(".cell-tag", 0);
  assert.ok(Math.abs(tag.x + tag.w / 2 - (cell.x + cell.w / 2)) < 3, "the lp tag is centred under cell 0");
  await shot("twoptr");
});

await check("matrix: int[3][4] and vector<vector<int>> are grids with row and column numbers and an active cell", async () => {
  await load("matrix", 24);
  assert.equal(await count(".matrix-grid"), 2);
  assert.deepEqual(await texts(".mx-cell.is-active"), ["8"]);
  assert.equal(await count(".mx-head.is-marked"), 3);
  const [header] = await texts(".matrix-grid thead th");
  assert.equal(header, "0");
  await shot("matrix");
});

await check("linked list: the variables standing on a node are tagged on it (head, slow, fast)", async () => {
  await load("slowfast", 14);
  assert.deepEqual(await texts(".node-tag"), ["head, slow, fast"]);
  await load("slowfast", 20);
  const tags = (await texts(".node-tag")).join(" | ");
  assert.ok(/slow/.test(tags) && /fast/.test(tags) && /head/.test(tags), tags);
  await shot("slowfast");
});

await check("no console errors or page errors across all of it", async () => {
  assert.deepEqual(problems, []);
});

console.log(`\n${passed} checks passed`);
await browser.close();
