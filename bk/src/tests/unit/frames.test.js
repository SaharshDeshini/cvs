const test = require("node:test");
const assert = require("node:assert/strict");
const { parseFrames } = require("../../utils/frames");

const NAMES = new Set(["trace.jsonl", "stdout.txt", "compile.rc"]);
const frame = (name, data, original = data.length) => `\u0001CVIS ${name} ${Buffer.byteLength(data)} ${original}\n${data}`;
const parse = (text) => parseFrames(Buffer.from(text), NAMES);

test("parses consecutive frames", () => {
  const frames = parse(frame("compile.rc", "0") + frame("stdout.txt", "hi\nthere\n"));
  assert.equal(frames.get("compile.rc").text, "0");
  assert.equal(frames.get("stdout.txt").text, "hi\nthere\n");
});

test("data containing the marker text is not re-parsed as a frame", () => {
  const inner = "\u0001CVIS stdout.txt 2 2\nxx";
  const frames = parse(frame("trace.jsonl", inner) + frame("compile.rc", "0"));
  assert.equal(frames.get("trace.jsonl").text, inner);
  assert.equal(frames.get("compile.rc").text, "0");
  assert.equal(frames.has("stdout.txt"), false);
});

test("reports truncation when the original was larger than what was emitted", () => {
  const frames = parse(frame("stdout.txt", "abc", 5000));
  assert.equal(frames.get("stdout.txt").truncated, true);
  assert.equal(parse(frame("stdout.txt", "abc")).get("stdout.txt").truncated, false);
});

test("the first frame of a name wins; unknown names are ignored", () => {
  const frames = parse(frame("stdout.txt", "first") + frame("stdout.txt", "second") + frame("evil.sh", "rm -rf"));
  assert.equal(frames.get("stdout.txt").text, "first");
  assert.equal(frames.has("evil.sh"), false);
});

test("stray bytes before and between frames are skipped", () => {
  const frames = parse(`noise\n${frame("compile.rc", "0")}garbage\u0001CVIS bad header\n${frame("stdout.txt", "ok")}`);
  assert.equal(frames.get("compile.rc").text, "0");
  assert.equal(frames.get("stdout.txt").text, "ok");
});

test("a length that overruns the buffer ends parsing but keeps earlier frames", () => {
  const frames = parse(frame("compile.rc", "0") + "\u0001CVIS stdout.txt 999999 999999\nshort");
  assert.equal(frames.get("compile.rc").text, "0");
  assert.equal(frames.has("stdout.txt"), false);
});

test("oversized or malformed headers are rejected", () => {
  assert.equal(parse(`\u0001CVIS ${"a".repeat(200)} 1 1\nx`).size, 0);
  assert.equal(parse("\u0001CVIS stdout.txt -5 5\nxxxxx").size, 0);
  assert.equal(parse("\u0001CVIS stdout.txt 12345678901 1\nx").size, 0);
  assert.equal(parse("").size, 0);
});

test("multi-byte UTF-8 is cut by bytes, not characters", () => {
  const frames = parse(frame("stdout.txt", "héllo→"));
  assert.equal(frames.get("stdout.txt").text, "héllo→");
});
