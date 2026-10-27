// Browser check for the AI assistant panel in real Chrome. A MOCK backend on :5000 stands in for the real one (no Docker, no API key),
// so this proves the frontend: opening, quick actions, answers, step chips, verification notes, safe rendering, errors, retry,
// new-run reset and the "not set up" state. The real backend + Gemini wire format are covered by bk unit tests (aiHttp.test.js).
// Prereq: `npm run dev` (dev server) and port 5000 free. Usage: APP_URL=http://localhost:5173/ node e2e/assistant.mjs [screenshotDir]
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import puppeteer from "puppeteer-core";

const CHROME = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const URL = process.env.APP_URL ?? "http://localhost:5173/";
const shots = process.argv[2] ?? "e2e/shots";
mkdirSync(shots, { recursive: true });

// ---- mock backend -------------------------------------------------------------------------------------------------------------
const int = (value) => ({ kind: "int", type: "int", value: String(value) });
const step = (n, line, fn, event, frames, extra = {}) => ({ n, line, fn, event, depth: frames.length, stdoutLen: 0, keyframe: true, frames: frames.map((f, i) => ({ id: `f${i}`, ...f })), changes: [], returned: null, skipped: null, heap: null, ...extra });
const STEPS = [
  step(0, 9, "main", "step", [{ fn: "main", line: 9, vars: {} }]),
  step(1, 10, "main", "step", [{ fn: "main", line: 10, vars: { total: int(0) } }]),
  step(2, 4, "factorial", "call", [{ fn: "main", line: 11, vars: { total: int(0) } }, { fn: "factorial", line: 4, vars: { n: int(1) } }]),
  step(3, 11, "main", "return", [{ fn: "main", line: 11, vars: { total: int(0) } }], { returned: { fn: "factorial", ...int(1) } }),
  step(4, 13, "main", "step", [{ fn: "main", line: 13, vars: { total: int(1) } }]),
];
let runCounter = 0;
const traceBody = () => ({
  schema: 1, status: "ok", message: null, exitCode: 0, signal: null, crashLine: null, limits: { maxSteps: 5000, stepsRecorded: STEPS.length, truncated: false },
  droppedRecords: 0, compileErrors: [], compileOutput: null, stdout: "total = 1\n", stderr: "", keyframeEvery: 50, steps: STEPS,
  traceId: String(++runCounter).padStart(32, "0"),
});
const ANSWER = [
  "At **step 1** the program starts in `main` [[step:1]].",
  "",
  "- `total` becomes `0` [[step:2]]",
  "- It then calls `factorial` with `n` = `1` [[step:3]]",
  "",
  "Bogus number `4242`. <img src=x onerror=\"window.__xss=1\">",
].join("\n");

const state = { status: { enabled: true, reason: null, provider: "gemini", model: "mock-model", message: null }, asks: [], askMode: "ok", statusRequests: 0 };
const json = (response, status, body, headers = {}) => {
  response.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", ...headers });
  response.end(JSON.stringify(body));
};
const mock = createServer((request, response) => {
  if (request.method === "OPTIONS") return json(response, 204, {});
  let data = "";
  request.on("data", (chunk) => { data += chunk; });
  request.on("end", () => {
    if (request.url === "/api/trace") return json(response, 200, traceBody());
    if (request.url === "/api/ai/status") { state.statusRequests += 1; return json(response, 200, state.status); }
    if (request.url === "/api/ai/ask") {
      const body = JSON.parse(data);
      state.asks.push(body);
      if (state.askMode === "limited") { state.askMode = "ok"; return json(response, 429, { error: "Too many questions in a minute. Wait a little and ask again.", code: "RATE_LIMITED" }); }
      return json(response, 200, {
        kind: body.kind, step: body.step, answer: ANSWER, citations: [0, 1, 2], truncated: false, model: "mock-model", cached: false, usage: {},
        verification: { invalidCitations: 1, unverifiedValues: ["4242"] },
      });
    }
    return json(response, 404, { error: "not found" });
  });
});
await new Promise((resolve, reject) => { mock.once("error", (e) => reject(new Error(`cannot start the mock backend on :5000 (${e.code}) - stop the real backend first`))); mock.listen(5000, "127.0.0.1", resolve); });

// ---- browser ------------------------------------------------------------------------------------------------------------------
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.setViewport({ width: 1500, height: 1000 });
const problems = [];
page.on("console", (message) => { if (message.type() === "error" && !/Failed to load resource/.test(message.text())) problems.push(`console: ${message.text()}`); });
page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));

let passed = 0;
const check = async (name, fn) => {
  await fn();
  passed += 1;
  console.log(`ok ${name}`);
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const text = (selector) => page.$eval(selector, (el) => el.innerText);
const count = (selector) => page.$$eval(selector, (els) => els.length);
const stepCounter = () => text(".step-count");
const clickByText = (selector, label) => page.evaluate((sel, wanted) => {
  const button = [...document.querySelectorAll(sel)].find((el) => el.textContent.trim() === wanted);
  if (!button) throw new Error(`no ${sel} reading "${wanted}"`);
  button.click();
}, selector, label);

async function load() {
  await page.goto(URL, { waitUntil: "networkidle0" });
  await page.waitForSelector(".cm-content");
}
async function run() {
  await page.keyboard.down("Control");
  await page.keyboard.press("Enter");
  await page.keyboard.up("Control");
  await page.waitForSelector(".narration");
}

try {
  state.status = { enabled: true, reason: null, provider: "gemini", model: "mock-model", message: null };
  await load();

  await check("page load makes no assistant request (status is asked only when the panel opens or a run returns)", async () => {
    await wait(500);
    assert.equal(state.statusRequests, 0);
  });

  await check("before any run the panel asks the user to run first", async () => {
    await page.click(".ai-toggle");
    await page.waitForSelector(".pane-ai");
    assert.match(await text(".ai-body"), /Run your code first/);
    assert.equal(await count(".ai-composer"), 0);
  });

  await check("after a run the quick actions and the composer appear, and the narration offers 'Explain with AI'", async () => {
    await run();
    await page.waitForSelector(".ai-actions");
    assert.match(await text(".ai-actions"), /Explain step 1/);
    assert.match(await text(".ai-actions"), /Summarise this run/);
    assert.equal(await count(".ai-explain"), 1);
  });

  await check("'Explain step 1' sends the run id, kind and the 0-based step, and renders the answer", async () => {
    await clickByText(".ai-chip", "Explain step 1");
    await page.waitForSelector(".ai-msg.is-assistant:not([aria-label])");
    const [ask] = state.asks;
    assert.equal(ask.kind, "step");
    assert.equal(ask.step, 0);
    assert.match(ask.traceId, /^0{31}1$/);
    assert.equal(ask.level, "standard");
    const log = await text(".ai-log");
    assert.match(log, /Explain step 1/);
    assert.match(log, /At step 1 the program starts in main/);
    assert.equal(await count(".ai-log strong"), 1);
    assert.equal(await count(".ai-log .ai-list li"), 2);
    assert.equal(await count(".ai-step"), 3);
  });

  await check("a step chip jumps the timeline to that step", async () => {
    await page.evaluate(() => [...document.querySelectorAll(".ai-step")].find((b) => b.textContent.trim() === "step 3").click());
    assert.match(await stepCounter(), /^3\s*\/\s*5/);
  });

  await check("the checker's findings are shown plainly: a removed reference and an unmatched value", async () => {
    const notes = await text(".ai-notes");
    assert.match(notes, /1 reference to a step that does not exist in this run was removed/);
    assert.match(notes, /4242/);
  });

  await check("answer text is rendered as text: no element or script comes from it", async () => {
    assert.equal(await count(".ai-log img"), 0);
    assert.equal(await page.evaluate(() => window.__xss), undefined);
    assert.match(await text(".ai-log"), /<img src=x onerror="window\.__xss=1">/);
  });

  await screenshotStep("assistant-answer");

  await check("asking the same step again shows the saved answer without another request", async () => {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.keyboard.press("Home"); // back to step 1 so the label is the same question
    const before = state.asks.length;
    await clickByText(".ai-chip", "Explain step 1");
    await wait(300);
    assert.equal(state.asks.length, before);
    assert.equal(await count(".ai-msg.is-assistant"), 1);
  });

  await check("typing a question and pressing Enter sends a chat turn with the earlier exchange as history", async () => {
    await page.click(".ai-composer textarea");
    await page.keyboard.type("Why is total zero?");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelectorAll(".ai-msg.is-assistant").length === 2);
    const ask = state.asks.at(-1);
    assert.equal(ask.kind, "chat");
    assert.equal(ask.message, "Why is total zero?");
    assert.deepEqual(ask.history.map((turn) => turn.role), ["user", "assistant"]);
    assert.equal(ask.history[0].text, "Explain step 1");
    assert.equal(await page.$eval(".ai-composer textarea", (el) => el.value), "");
  });

  await check("typing in the composer does not step the program (arrow keys and space stay in the text box)", async () => {
    const before = await stepCounter();
    await page.click(".ai-composer textarea");
    await page.keyboard.type("a b");
    await page.keyboard.press("ArrowLeft");
    assert.equal(await stepCounter(), before);
    await page.$eval(".ai-composer textarea", (el) => { el.value = ""; });
  });

  await check("a rate-limit failure shows the server's words with 'Try again', and retrying succeeds", async () => {
    state.askMode = "limited";
    await page.click(".ai-composer textarea");
    await page.keyboard.type("one more");
    await page.keyboard.press("Enter");
    await page.waitForSelector(".ai-msg.is-error");
    assert.match(await text(".ai-msg.is-error"), /Too many questions in a minute/);
    await page.click(".ai-retry");
    await page.waitForFunction(() => document.querySelectorAll(".ai-msg.is-error").length === 0 && document.querySelectorAll(".ai-msg.is-assistant").length === 3);
  });

  await check("a level change is sent with the next question", async () => {
    await clickByText(".ai-level", "Beginner");
    await clickByText(".ai-chip", "Explain step 1");
    await page.waitForFunction(() => document.querySelectorAll(".ai-msg.is-assistant").length === 4);
    assert.equal(state.asks.at(-1).level, "beginner");
  });

  await check("running again starts a fresh conversation (answers about the old run are dropped)", async () => {
    await run();
    await wait(200);
    assert.equal(await count(".ai-msg"), 0);
    assert.match(await text(".ai-body"), /Ask about the run you are looking at/);
  });

  await check("Alt+A closes and reopens the panel", async () => {
    await page.keyboard.down("Alt");
    await page.keyboard.press("KeyA");
    await page.keyboard.up("Alt");
    await page.waitForFunction(() => !document.querySelector(".pane-ai"));
    await page.keyboard.down("Alt");
    await page.keyboard.press("KeyA");
    await page.keyboard.up("Alt");
    await page.waitForSelector(".pane-ai");
  });

  await check("when the backend has no key the panel explains how to set it up and the Explain buttons disappear", async () => {
    state.status = { enabled: false, reason: "no_key", provider: "gemini", model: "mock-model", message: "The AI assistant is not set up yet. Add GEMINI_API_KEY to bk/.env and restart the server." };
    await load();
    await run();
    await page.click(".ai-toggle");
    await page.waitForSelector(".ai-setup");
    const setup = await text(".ai-setup");
    assert.match(setup, /GEMINI_API_KEY/);
    assert.match(setup, /Google AI Studio/);
    assert.equal(await count(".ai-explain"), 0);
    assert.equal(await count(".ai-composer"), 0);
    assert.equal(await page.$eval(".ai-setup a", (a) => a.rel), "noopener noreferrer");
  });

  await screenshotStep("assistant-setup");

  assert.deepEqual(problems, [], `browser problems:\n${problems.join("\n")}`);
  console.log(`\n${passed} checks passed`);
} catch (error) {
  await page.screenshot({ path: `${shots}/assistant-failure.png` }).catch(() => {});
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser.close();
  mock.close();
}

async function screenshotStep(name) {
  await page.screenshot({ path: `${shots}/${name}.png` });
}
