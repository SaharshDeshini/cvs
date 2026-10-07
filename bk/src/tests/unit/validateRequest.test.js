const test = require("node:test");
const assert = require("node:assert/strict");
const { validateTraceRequest } = require("../../utils/validateRequest");
const { LIMITS } = require("../../utils/limits");

test("accepts code and defaults stdin to empty", () => {
  const result = validateTraceRequest({ code: "int main(){}" });
  assert.deepEqual(result, { ok: true, value: { code: "int main(){}", stdin: "" } });
});

test("rejects non-object bodies", () => {
  for (const body of [undefined, null, "str", 42, [], [{ code: "x" }]]) {
    assert.equal(validateTraceRequest(body).ok, false, JSON.stringify(body));
  }
});

test("rejects missing, empty and non-string code", () => {
  for (const code of [undefined, "", 123, null, {}, ["int main(){}"]]) {
    assert.equal(validateTraceRequest({ code }).ok, false, JSON.stringify(code));
  }
});

test("rejects NUL bytes in code and stdin", () => {
  assert.equal(validateTraceRequest({ code: "a\u0000b" }).ok, false);
  assert.equal(validateTraceRequest({ code: "x", stdin: "a\u0000b" }).ok, false);
});

test("enforces the code size limit in bytes, not characters", () => {
  const atLimit = "a".repeat(LIMITS.maxCodeBytes);
  assert.equal(validateTraceRequest({ code: atLimit }).ok, true);
  assert.equal(validateTraceRequest({ code: atLimit + "a" }).ok, false);
  const multibyte = "é".repeat(LIMITS.maxCodeBytes / 2 + 1); // 2 bytes each
  assert.equal(validateTraceRequest({ code: multibyte }).ok, false);
});

test("validates stdin type and size", () => {
  assert.equal(validateTraceRequest({ code: "x", stdin: 5 }).ok, false);
  assert.equal(validateTraceRequest({ code: "x", stdin: "a".repeat(LIMITS.maxStdinBytes + 1) }).ok, false);
  assert.equal(validateTraceRequest({ code: "x", stdin: "1 2\n" }).ok, true);
});
