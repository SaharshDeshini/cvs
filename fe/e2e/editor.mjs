// Browser check for the editor itself: auto-closing brackets, name suggestions, Format. No backend or Docker needed.
// Prereq: `npm run dev`. Usage: APP_URL=http://localhost:5173/ node e2e/editor.mjs [screenshotDir]
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import puppeteer from "puppeteer-core";

const CHROME = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const URL = process.env.APP_URL ?? "http://localhost:5173/";
const shots = process.argv[2] ?? "e2e/shots";
mkdirSync(shots, { recursive: true });

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 1000 });
const problems = [];
page.on("console", (message) => { if (message.type() === "error") problems.push(`console: ${message.text()}`); });
page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));

let passed = 0;
const check = async (name, fn) => {
  await fn();
  passed += 1;
  console.log(`ok ${name}`);
};

const docText = () => page.$eval(".cm-content", (el) => el.innerText.replace(/\u00a0/g, " "));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function selectAll() {
  await page.click(".cm-content");
  await page.keyboard.down("Control");
  await page.keyboard.press("a");
  await page.keyboard.up("Control");
}

async function setDoc(text) {
  await selectAll();
  await page.evaluate((value) => {
    const data = new DataTransfer();
    data.setData("text/plain", value);
    document.querySelector(".cm-content").dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, text);
}

async function clearDoc() {
  await selectAll();
  await page.keyboard.press("Backspace");
}

const suggestions = () => page.$$eval(".cm-tooltip-autocomplete li", (items) => items.map((item) => item.textContent.trim()));

try {
  await page.goto(URL, { waitUntil: "networkidle0" });
  await page.waitForSelector(".cm-content");

  await check("typing an opening bracket adds the closing one", async () => {
    await clearDoc();
    await page.keyboard.type("int f(");
    assert.equal((await docText()).trim(), "int f()");
    await page.keyboard.type("int a[");
    assert.match(await docText(), /int f\(int a\[\]\)/);
  });

  await check("typing the closing bracket steps over it", async () => {
    await clearDoc();
    await page.keyboard.type("f(1)");
    assert.equal((await docText()).trim(), "f(1)");
  });

  await check("quotes pair too, and Backspace removes an empty pair", async () => {
    await clearDoc();
    await page.keyboard.type('s = "');
    assert.equal((await docText()).trim(), 's = ""');
    await page.keyboard.press("Backspace");
    assert.equal((await docText()).trim(), "s =");
  });

  await check("Enter between braces opens an indented block", async () => {
    await clearDoc();
    await page.keyboard.type("void g() {");
    await page.keyboard.press("Enter");
    const lines = (await docText()).replace(/\n$/, "").split("\n");
    assert.equal(lines.length, 3, `expected 3 lines, got ${JSON.stringify(lines)}`);
    assert.match(lines[1], /^\s+$/, "caret line should be indented");
    assert.equal(lines[2], "}");
  });

  await check("suggests the user's own function and variable names", async () => {
    await setDoc("int computeTotal(int base) {\n  int runningSum = base;\n  return 0;\n}\n");
    await page.keyboard.down("Control");
    await page.keyboard.press("End");
    await page.keyboard.up("Control");
    await page.keyboard.type("run");
    await page.waitForSelector(".cm-tooltip-autocomplete");
    assert.ok((await suggestions()).some((label) => label.includes("runningSum")), "runningSum not suggested");
    await page.screenshot({ path: `${shots}/editor-suggest.png` });
    await page.keyboard.press("Enter");
    assert.match(await docText(), /runningSum\s*$/);
    await page.keyboard.type("; com");
    await page.waitForSelector(".cm-tooltip-autocomplete");
    assert.ok((await suggestions()).some((label) => label.includes("computeTotal")), "computeTotal not suggested");
  });

  await check("suggests keywords and std names, and only std names after std::", async () => {
    await clearDoc();
    await page.keyboard.type("whi");
    await page.waitForSelector(".cm-tooltip-autocomplete");
    assert.ok((await suggestions()).some((label) => label.includes("while")), "while not suggested");
    await page.keyboard.press("Escape");
    await clearDoc();
    await page.keyboard.type("std::vec");
    await page.waitForSelector(".cm-tooltip-autocomplete");
    assert.ok((await suggestions()).some((label) => label.includes("vector")), "std::vector not suggested");
    await wait(300); // CodeMirror ignores Enter for ~75 ms after a popup opens, so a fast typist does not accept by accident
    await page.keyboard.press("Enter");
    assert.equal((await docText()).trim(), "std::vector");
  });

  await check("no suggestions inside a comment", async () => {
    await clearDoc();
    await page.keyboard.type("// whi");
    await wait(400);
    assert.equal((await suggestions()).length, 0);
  });

  const MESSY = "#include <iostream>\nint main(){int x=1;if(x>0){x++;}\nreturn x;}\n";
  const formatted = () => page.waitForFunction(() => document.querySelector(".cm-content").innerText.includes("int main() {"), { timeout: 20000 });

  await check("Format button reindents messy code", async () => {
    await setDoc(MESSY);
    await page.click(".editor-bar .btn");
    await formatted();
    const text = await docText();
    assert.match(text, /\n {4}int x = 1;/);
    assert.match(text, /\n {8}x\+\+;/);
    await page.screenshot({ path: `${shots}/editor-format.png` });
  });

  await check("Shift+Alt+F formats too", async () => {
    await setDoc(MESSY);
    await page.keyboard.down("Shift");
    await page.keyboard.down("Alt");
    await page.keyboard.press("f");
    await page.keyboard.up("Alt");
    await page.keyboard.up("Shift");
    await formatted();
  });

  await check("no console errors", async () => assert.deepEqual(problems, []));
  console.log(`${passed} checks passed`);
} finally {
  await browser.close();
}
