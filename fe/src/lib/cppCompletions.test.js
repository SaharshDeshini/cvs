import { describe, expect, it } from "vitest";
import { buildOptions, collectSymbols } from "./cppCompletions";

const SAMPLE = `#include <iostream>
#include <vector>
struct Node { int value; Node* next; };
class Stack { public: void push(int v); };

// done; int hidden = 1;
/* block; int blocked = 1; */
int add(int a, int b) {
  int total = a + b;
  std::string label = "x; int fake = 2;";
  return total;
}

int main() {
  std::vector<int> nums = {1, 2, 3};
  Node* head = nullptr;
  for (int i = 0; i < 3; i++) {
    double ratio = 0.5;
  }
  return add(1, 2);
}
`;

describe("collectSymbols", () => {
  const symbols = collectSymbols(SAMPLE);

  it("finds function definitions", () => {
    expect(symbols.functions).toEqual(expect.arrayContaining(["add", "main"]));
  });

  it("finds variables and parameters, including pointers and templates", () => {
    expect(symbols.variables).toEqual(expect.arrayContaining(["a", "b", "total", "nums", "head", "i", "ratio", "label"]));
  });

  it("finds struct and class names as types", () => {
    expect(symbols.types).toEqual(expect.arrayContaining(["Node", "Stack"]));
  });

  it("ignores declarations inside comments and string literals", () => {
    expect(symbols.variables).not.toContain("hidden");
    expect(symbols.variables).not.toContain("fake");
  });

  it("never reports a keyword as a name", () => {
    const all = [...symbols.functions, ...symbols.variables, ...symbols.types];
    expect(all).not.toContain("return");
    expect(all).not.toContain("for");
  });

  it("does not read the class in `int Foo::get() const {` as a variable", () => {
    const scoped = collectSymbols("struct Foo { int get() const; };\nint Foo::get() const { return 1; }\n");
    expect(scoped.variables).not.toContain("Foo");
    expect(scoped.types).toContain("Foo");
  });

  it("returns each name once", () => {
    const again = collectSymbols("int x = 1;\nint y = x;\nx = 2;\nint x2 = 0;\nint x = 3;");
    expect(again.variables.filter((name) => name === "x")).toHaveLength(1);
  });

  it("copes with empty or hostile input", () => {
    expect(collectSymbols("")).toEqual({ functions: [], variables: [], types: [] });
    expect(collectSymbols("int __proto__ = 1; int constructor;").variables).toEqual(expect.arrayContaining(["__proto__", "constructor"]));
  });
});

describe("buildOptions", () => {
  const labels = (options) => options.map((option) => option.label);

  it("offers keywords, std names and the user's own names", () => {
    const options = buildOptions(collectSymbols(SAMPLE), "");
    expect(labels(options)).toEqual(expect.arrayContaining(["while", "vector", "cout", "add", "total", "Node"]));
  });

  it("tags each option with a kind", () => {
    const byLabel = Object.fromEntries(buildOptions(collectSymbols(SAMPLE), "").map((option) => [option.label, option.type]));
    expect(byLabel.while).toBe("keyword");
    expect(byLabel.add).toBe("function");
    expect(byLabel.total).toBe("variable");
    expect(byLabel.Node).toBe("class");
  });

  it("ranks the user's own names above library names", () => {
    const options = buildOptions(collectSymbols(SAMPLE), "");
    const boost = (label) => options.find((option) => option.label === label).boost;
    expect(boost("total")).toBeGreaterThan(boost("while"));
  });

  it("keeps a user name that shadows a std name only once", () => {
    const options = buildOptions({ functions: [], variables: ["vector"], types: [] }, "");
    expect(labels(options).filter((label) => label === "vector")).toHaveLength(1);
  });

  it("offers only std names after std::", () => {
    const options = buildOptions(collectSymbols(SAMPLE), "std::");
    expect(labels(options)).toEqual(expect.arrayContaining(["vector", "cout", "sort"]));
    expect(labels(options)).not.toContain("while");
    expect(labels(options)).not.toContain("total");
  });

  it("offers nothing after another scope qualifier", () => {
    expect(buildOptions(collectSymbols(SAMPLE), "Stack::")).toEqual([]);
  });
});
