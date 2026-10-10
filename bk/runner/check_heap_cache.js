// Proves the heap-block cache (values.py, HEAP_CACHE) changes nothing but speed: runs each fixture in the runner image twice,
// cache off then on, and requires every step record to be identical. Needs Docker and the image `cvis-runner:2`.
// usage:  node bk/runner/check_heap_cache.js [fixture ...]     (names without .cpp, from bk/src/tests/fixtures)
// Skip `wild_pointers`: it prints uninitialised stack bytes, so two runs differ even with the cache off.
const { spawnSync } = require("node:child_process");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { parseFrames } = require("../src/utils/frames");

const FIXTURES = path.join(__dirname, "..", "src", "tests", "fixtures");
// cache_hazards: heap structs whose printed value is read from memory OUTSIDE them (a list iterator, a wchar_t*); the cache
// must refuse them. It once did not, and the reviewer's guess was confirmed by this fixture, so it stays in the set.
const DEFAULT_SET = ["cache_hazards", "list_big", "list", "bst", "leak", "heap_reuse", "pointers", "lifecycle", "list_stl", "double_free", "bubble", "recursion"];
const IMAGE = "cvis-runner:2";

function run(fixture, cacheFlag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cvis-heapcache-"));
  fs.copyFileSync(path.join(FIXTURES, `${fixture}.cpp`), path.join(dir, "main.cpp"));
  const began = Date.now();
  const result = spawnSync("docker", [
    "run", "--rm", "--network", "none", "--memory", "1g", "--pids-limit", "256",
    "--tmpfs", "/tmp:rw,exec,nosuid,size=128m", "--tmpfs", "/out:rw,noexec,nosuid,size=64m,mode=1777",
    "-e", "MAX_STEPS=5000", "-e", "COMPILE_SECONDS=30", "-e", "TRACE_SECONDS=90", "-e", "MAX_TRACE_BYTES=200000000",
    "-e", `CVIS_HEAP_CACHE=${cacheFlag}`,
    "--mount", `type=bind,src=${dir.replace(/\\/g, "/")},dst=/src,readonly`, IMAGE,
  ], { maxBuffer: 512 * 1024 * 1024 });
  const seconds = (Date.now() - began) / 1000;
  fs.rmSync(dir, { recursive: true, force: true });
  const text = parseFrames(result.stdout, new Set(["trace.jsonl"])).get("trace.jsonl")?.text ?? "";
  const records = text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return { seconds, steps: records.filter((r) => r.t === "step"), end: records.find((r) => r.t === "end") };
}

// ASLR is on in the container, so two runs use different addresses: name every long hex literal ADDR<n> by first appearance.
function canonical(steps) {
  const names = new Map();
  return steps.map((step) => JSON.parse(JSON.stringify(step).replace(/0x[0-9a-f]{8,}/g, (hex) => {
    if (!names.has(hex)) names.set(hex, `ADDR${names.size}`);
    return names.get(hex);
  })));
}

function firstDifference(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    try { assert.deepStrictEqual(a[i], b[i]); } catch { return i; }
  }
  return -1;
}

let failures = 0;
for (const fixture of process.argv.length > 2 ? process.argv.slice(2) : DEFAULT_SET) {
  const off = run(fixture, "0");
  const on = run(fixture, "1");
  const bad = firstDifference(canonical(off.steps), canonical(on.steps));
  const same = bad < 0 && off.end?.status === on.end?.status;
  if (!same) failures += 1;
  const rate = (r) => `${(r.steps.length / r.seconds).toFixed(0)}/s`;
  console.log(`${same ? "SAME" : "DIFF"}  ${fixture.padEnd(12)} steps=${String(off.steps.length).padEnd(5)} off ${off.seconds.toFixed(1)}s (${rate(off)})  on ${on.seconds.toFixed(1)}s (${rate(on)})${same ? "" : `  differs at step ${bad}`}`);
}
console.log(failures === 0 ? "heap cache: output identical to the uncached tracer" : `heap cache: ${failures} fixture(s) DIFFER`);
process.exit(failures === 0 ? 0 : 1);
