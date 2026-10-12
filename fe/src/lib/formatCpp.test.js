import { describe, expect, it } from "vitest";
import { caretOffset, formatCpp } from "./formatCpp";

describe("caretOffset", () => {
  const text = "int a;\n  return 0;\n}";

  it("maps a line and column to an offset", () => {
    expect(caretOffset(text, 1, 0)).toBe(0);
    expect(caretOffset(text, 2, 4)).toBe(7 + 4);
  });

  it("clamps a column past the end of the line", () => {
    expect(caretOffset(text, 1, 99)).toBe(6);
  });

  it("clamps a line past the end of the text to the start of the last line", () => {
    expect(caretOffset(text, 99, 0)).toBe(text.length - 1);
  });
});

describe("formatCpp", () => {
  it("indents and spaces messy code", async () => {
    const messy = "#include <iostream>\nint main(){int x=1;if(x>0){x++;}\nreturn x;}\n";
    const formatted = await formatCpp(messy);
    expect(formatted).toContain("int main() {");
    expect(formatted).toContain("    int x = 1;");
    expect(formatted).toContain("        x++;");
  });

  it("leaves already formatted code unchanged", async () => {
    const once = await formatCpp("int main(){return 0;}\n");
    expect(await formatCpp(once)).toBe(once);
  });
});
