import { describe, expect, it } from "vitest";
import { parseAnswer, parseInline } from "./aiText";

describe("parseInline", () => {
  it("splits text, bold, code and step citations in order", () => {
    expect(parseInline("At [[step:3]] `n` becomes **seven** now")).toEqual([
      { type: "text", text: "At " },
      { type: "step", n: 3 },
      { type: "text", text: " " },
      { type: "code", text: "n" },
      { type: "text", text: " becomes " },
      { type: "bold", text: "seven" },
      { type: "text", text: " now" },
    ]);
  });

  it("keeps HTML as plain text tokens, never as markup", () => {
    const tokens = parseInline('<img src=x onerror="alert(1)"> and <b>bold</b>');
    expect(tokens).toEqual([{ type: "text", text: '<img src=x onerror="alert(1)"> and <b>bold</b>' }]);
  });

  it("leaves unmatched markers alone", () => {
    expect(parseInline("a ** b ` c [[step:x]]")).toEqual([{ type: "text", text: "a ** b ` c [[step:x]]" }]);
  });

  it("returns nothing for empty text", () => {
    expect(parseInline("")).toEqual([]);
  });
});

describe("parseAnswer", () => {
  it("makes paragraphs from blank-line separated text and joins wrapped lines", () => {
    const blocks = parseAnswer("First line\nsecond line.\n\nNext paragraph.");
    expect(blocks.map((block) => block.type)).toEqual(["p", "p"]);
    expect(blocks[0].inline).toEqual([{ type: "text", text: "First line second line." }]);
  });

  it("groups bullets and numbered items into separate lists", () => {
    const blocks = parseAnswer("- one\n- two\n1. first\n2. second");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ type: "list", ordered: false });
    expect(blocks[0].items).toHaveLength(2);
    expect(blocks[1]).toMatchObject({ type: "list", ordered: true });
    expect(blocks[1].items[1]).toEqual([{ type: "text", text: "second" }]);
  });

  it("keeps a fenced code block verbatim, including blank lines and markers inside it", () => {
    const blocks = parseAnswer("Fix it:\n```cpp\nint total = 0;\n\n- not a bullet **nor bold**\n```\nDone.");
    expect(blocks.map((block) => block.type)).toEqual(["p", "code", "p"]);
    expect(blocks[1]).toEqual({ type: "code", lang: "cpp", text: "int total = 0;\n\n- not a bullet **nor bold**" });
  });

  it("closes an unterminated code fence at the end of the text", () => {
    expect(parseAnswer("```\nint x;")).toEqual([{ type: "code", lang: "", text: "int x;" }]);
  });

  it("handles Windows line endings and empty input", () => {
    expect(parseAnswer("a\r\n\r\nb")).toHaveLength(2);
    expect(parseAnswer("")).toEqual([]);
    expect(parseAnswer("   \n \n")).toEqual([]);
  });

  it("does not turn a hyphen or star inside a sentence into a list", () => {
    expect(parseAnswer("a well-known 3 * 4 result")[0].type).toBe("p");
  });
});
