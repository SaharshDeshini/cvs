import { afterEach, describe, expect, it, vi } from "vitest";
import { AiApiError, askAssistant, fetchAiStatus, findingsPayload } from "./aiApi";

const respond = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const mockFetch = (...responses) => {
  const fetchMock = vi.fn();
  responses.forEach((response) => fetchMock.mockImplementationOnce(async () => (response instanceof Error ? Promise.reject(response) : response)));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};
const REQUEST = { traceId: "a".repeat(32), kind: "step", step: 2, message: "", level: "standard", history: [], findings: [] };
const GOOD = { answer: "Because [[step:3]].", step: 2, citations: [2], verification: { invalidCitations: 0, unverifiedValues: [] }, cached: false, truncated: false, model: "m" };

afterEach(() => vi.unstubAllGlobals());

describe("fetchAiStatus", () => {
  it("reports an enabled assistant", async () => {
    mockFetch(respond({ enabled: true, reason: null, provider: "gemini", model: "gemini-2.5-flash", message: null }));
    expect(await fetchAiStatus()).toEqual({ phase: "ready", enabled: true, reason: null, message: null, model: "gemini-2.5-flash" });
  });

  it("carries the server's setup message when it is off", async () => {
    mockFetch(respond({ enabled: false, reason: "no_key", provider: "gemini", model: "m", message: "Add GEMINI_API_KEY" }));
    expect(await fetchAiStatus()).toMatchObject({ phase: "ready", enabled: false, reason: "no_key", message: "Add GEMINI_API_KEY" });
  });

  it("says unreachable for a network failure, a bad status, or a malformed body (never throws)", async () => {
    mockFetch(new TypeError("fetch failed"), respond({}, 500), respond({ nope: 1 }));
    for (let i = 0; i < 3; i += 1) expect(await fetchAiStatus()).toMatchObject({ phase: "unreachable", enabled: false });
  });
});

describe("askAssistant", () => {
  it("posts the question as JSON and returns a normalised answer", async () => {
    const fetchMock = mockFetch(respond(GOOD));
    const answer = await askAssistant(REQUEST);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/api\/ai\/ask$/);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual(REQUEST);
    expect(answer).toMatchObject({ answer: "Because [[step:3]].", step: 2, citations: [2], cached: false, model: "m" });
  });

  it("fills safe defaults for optional fields and drops junk in lists", async () => {
    mockFetch(respond({ answer: "ok", citations: [1, "x", null, 3], verification: { unverifiedValues: ["9", 5, "7"] } }));
    const answer = await askAssistant(REQUEST);
    expect(answer.citations).toEqual([1, 3]);
    expect(answer.verification).toEqual({ invalidCitations: 0, unverifiedValues: ["9", "7"] });
    expect(answer.step).toBeNull();
  });

  it("turns the server's typed error into an AiApiError with its code and wording", async () => {
    mockFetch(respond({ error: "The AI service rejected the API key.", code: "KEY_REJECTED" }, 503));
    await expect(askAssistant(REQUEST)).rejects.toMatchObject({ name: "AiApiError", code: "KEY_REJECTED", message: "The AI service rejected the API key." });
  });

  it("explains an unlabelled failure by status, including a run the server forgot", async () => {
    mockFetch(respond("oops", 410), respond(null, 502));
    await expect(askAssistant(REQUEST)).rejects.toMatchObject({ code: "HTTP_410", message: expect.stringContaining("Press Run again") });
    await expect(askAssistant(REQUEST)).rejects.toMatchObject({ code: "HTTP_502" });
  });

  it("rejects an answer without text instead of showing an empty bubble", async () => {
    mockFetch(respond({ answer: "   " }), respond({}));
    await expect(askAssistant(REQUEST)).rejects.toMatchObject({ code: "BAD_RESPONSE" });
    await expect(askAssistant(REQUEST)).rejects.toBeInstanceOf(AiApiError);
  });

  it("reports an unreachable backend, and passes a cancel through untouched", async () => {
    mockFetch(new TypeError("fetch failed"), new DOMException("aborted", "AbortError"));
    await expect(askAssistant(REQUEST)).rejects.toMatchObject({ code: "UNREACHABLE" });
    await expect(askAssistant(REQUEST)).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("findingsPayload", () => {
  const bug = { id: "x", step: 3, kind: "leak", severity: "bad", line: 9, title: "T".repeat(500), detail: "D".repeat(900) };

  it("keeps only the fields the server accepts and clips long text", () => {
    const [finding] = findingsPayload([bug]);
    expect(Object.keys(finding).sort()).toEqual(["detail", "kind", "line", "severity", "step", "title"]);
    expect(finding.title).toHaveLength(200);
    expect(finding.detail).toHaveLength(600);
  });

  it("sends at most 20 findings and a safe severity", () => {
    expect(findingsPayload(Array.from({ length: 30 }, () => ({ ...bug, severity: "weird" })))).toHaveLength(20);
    expect(findingsPayload([{ ...bug, severity: "weird" }])[0].severity).toBe("warn");
  });
});
