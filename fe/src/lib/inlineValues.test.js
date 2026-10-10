import { describe, expect, it } from "vitest";
import { inlineValuesFor } from "./inlineValues";

const int = (value) => ({ kind: "int", type: "int", value: String(value) });
const ptr = (addr) => ({ kind: "ptr", type: "Node *", value: addr, addr, to: "Node", state: addr === "0x0" ? "null" : "heap" });

describe("inlineValuesFor", () => {
  it("lists each variable named on the line with its value, in order of appearance", () => {
    expect(inlineValuesFor("        sum += x;", { x: int(7), sum: int(6) })).toBe("sum = 6   x = 7");
  });

  it("ignores names that are not variables of the frame (std, cout, functions)", () => {
    expect(inlineValuesFor("std::cout << total << std::endl;", { total: int(3) })).toBe("total = 3");
  });

  it("ignores names that only appear in a string literal or a comment", () => {
    expect(inlineValuesFor('puts("x"); // y', { x: int(1), y: int(2) })).toBe("");
  });

  it("shows a null pointer as null and any other as a short address", () => {
    expect(inlineValuesFor("head = next;", { head: ptr("0x0"), next: ptr("0x55d0a2b0") })).toBe("head = null   next = @…a2b0");
  });

  it("skips arrays, structs and containers: they have their own diagram", () => {
    expect(inlineValuesFor("v.push_back(i);", { v: { kind: "seq", items: [] }, i: int(4) })).toBe("i = 4");
  });

  it("shows each variable once and at most three", () => {
    const vars = { a: int(1), b: int(2), c: int(3), d: int(4) };
    expect(inlineValuesFor("a = a + b + c + d;", vars)).toBe("a = 1   b = 2   c = 3");
  });

  it("ignores member and field names after . and ->, and names inside block comments", () => {
    expect(inlineValuesFor("p->next = q; s.size = 1; /* sum */", { next: int(1), size: int(2), sum: int(3), p: ptr("0x0"), q: ptr("0x0") })).toBe("p = null   q = null");
  });

  it("returns an empty string for an empty line", () => {
    expect(inlineValuesFor("", { a: int(1) })).toBe("");
  });

  it("does not mistake inherited object members (constructor, __proto__) for variables", () => {
    expect(inlineValuesFor("__proto__ = constructor;", {})).toBe("");
  });
});
