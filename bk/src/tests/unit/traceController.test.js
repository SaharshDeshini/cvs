// HTTP-level mapping of runner failures, with runTrace stubbed (no Docker).
const test = require("node:test");
const assert = require("node:assert/strict");
const runnerService = require("../../services/runnerService");
const app = require("../../app");

let server;
let baseUrl;

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server.close());

const post = async (body) => {
  const response = await fetch(`${baseUrl}/api/trace`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
};

test("RunnerError codes map to 429 / 503 / 502 and never leak the detail", async (t) => {
  t.mock.method(console, "error", () => {});
  const cases = [["BUSY", 429], ["RUNNER_UNAVAILABLE", 503], ["RUNNER_FAILED", 502]];
  for (const [code, expected] of cases) {
    t.mock.method(runnerService, "runTrace", async () => { throw new runnerService.RunnerError(code, "C:\\Users\\secret\\cvis-1 docker stderr"); });
    const { status, body } = await post({ code: "int main(){}" });
    assert.equal(status, expected, code);
    assert.equal(body.code, code);
    assert.ok(!JSON.stringify(body).includes("secret"), `${code} leaked detail`);
  }
});

test("an unexpected exception is a generic 500", async (t) => {
  t.mock.method(console, "error", () => {});
  t.mock.method(runnerService, "runTrace", async () => { throw new TypeError("internal path /srv/x exploded"); });
  const { status, body } = await post({ code: "int main(){}" });
  assert.equal(status, 500);
  assert.ok(!JSON.stringify(body).includes("/srv/x"));
});

test("a successful run is returned as a schema-1 trace", async (t) => {
  t.mock.method(runnerService, "runTrace", async () => ({
    compileExitCode: 0, compileOutput: "", traceText: '{"t":"end","status":"exited","exitCode":0,"signal":null,"line":null}',
    stdout: "", stderr: "", timedOut: false,
  }));
  const { status, body } = await post({ code: "int main(){}" });
  assert.equal(status, 200);
  assert.equal(body.schema, 1);
});

test("an unsupported charset is a 4xx, not a 500", async () => {
  const response = await fetch(`${baseUrl}/api/trace`, {
    method: "POST", headers: { "Content-Type": "application/json; charset=utf-7" }, body: "{}",
  });
  assert.ok(response.status >= 400 && response.status < 500, `status ${response.status}`);
});

test("both loopback spellings of the dev frontend are allowed", async () => {
  for (const origin of ["http://localhost:5173", "http://127.0.0.1:5173"]) {
    const response = await fetch(`${baseUrl}/api/trace`, { method: "OPTIONS", headers: { Origin: origin, "Access-Control-Request-Method": "POST" } });
    assert.equal(response.headers.get("access-control-allow-origin"), origin);
  }
});

test("CORS is limited to the frontend origin", async () => {
  const response = await fetch(`${baseUrl}/api/trace`, { method: "OPTIONS", headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST" } });
  assert.notEqual(response.headers.get("access-control-allow-origin"), "*");
  assert.notEqual(response.headers.get("access-control-allow-origin"), "https://evil.example");
});
