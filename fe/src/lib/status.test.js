import { describe, expect, it } from "vitest";
import { bannerMessage, chipFor } from "./status";

describe("chipFor", () => {
  it("reports the run outcome, not just that a response arrived", () => {
    expect(chipFor("ready", { status: "ok" })).toEqual({ label: "traced", tone: "ready" });
    expect(chipFor("ready", { status: "compile_error" })).toEqual({ label: "compile error", tone: "failed" });
    expect(chipFor("ready", { status: "runtime_error" }).label).toBe("crashed");
    expect(chipFor("ready", { status: "timeout" }).label).toBe("timed out");
    expect(chipFor("ready", { status: "truncated" }).tone).toBe("loading");
  });

  it("covers the non-ready phases", () => {
    expect(chipFor("idle", null).label).toBe("ready");
    expect(chipFor("loading", null).label).toBe("running");
    expect(chipFor("failed", null).tone).toBe("failed");
  });

  it("never claims success for an unknown status", () => {
    expect(chipFor("ready", { status: "something_new" })).toEqual({ label: "unknown result", tone: "failed" });
    expect(chipFor("ready", null).tone).toBe("failed");
  });
});

describe("bannerMessage", () => {
  it("drops the message that merely repeats the compile-error title", () => {
    expect(bannerMessage({ status: "compile_error", message: "Compilation failed" })).toBeNull();
  });

  it("keeps informative messages", () => {
    expect(bannerMessage({ status: "compile_error", message: "Compilation timed out" })).toBe("Compilation timed out");
    expect(bannerMessage({ status: "runtime_error", message: "Program crashed with SIGSEGV" })).toBe("Program crashed with SIGSEGV");
  });
});
