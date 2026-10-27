// Turns the assistant's plain text into a small structure the UI renders as React elements. There is NO HTML anywhere: the model's
// text (and the program text it quotes) is data, so every token is rendered as text. Supported: paragraphs, "-" / "1." lists,
// ``` code blocks, **bold**, `code`, and [[step:N]] citations (N counts from 1, like the UI's "Step N").
const INLINE = /\[\[step:(\d{1,6})\]\]|\*\*([^*\n]+)\*\*|`([^`\n]+)`/g;
const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/;
const ORDERED = /^\s*\d+[.)]\s+/;
const FENCE = /^\s*```\s*([A-Za-z0-9_+-]*)\s*$/;

/** @returns {{ type: "text" | "bold" | "code", text: string }[] | { type: "step", n: number }[]} tokens, in order */
export function parseInline(text) {
  const tokens = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    if (match.index > last) tokens.push({ type: "text", text: text.slice(last, match.index) });
    if (match[1] !== undefined) tokens.push({ type: "step", n: Number(match[1]) });
    else if (match[2] !== undefined) tokens.push({ type: "bold", text: match[2] });
    else tokens.push({ type: "code", text: match[3] });
    last = match.index + match[0].length;
  }
  if (last < text.length) tokens.push({ type: "text", text: text.slice(last) });
  return tokens;
}

/**
 * @param {string} text
 * @returns {({ type: "p", inline: object[] } | { type: "list", ordered: boolean, items: object[][] } | { type: "code", lang: string, text: string })[]}
 */
export function parseAnswer(text) {
  const blocks = [];
  let paragraph = [];
  let list = null;
  const flushParagraph = () => {
    if (paragraph.length > 0) blocks.push({ type: "p", inline: parseInline(paragraph.join(" ")) });
    paragraph = [];
  };
  const flushList = () => {
    if (list) blocks.push(list);
    list = null;
  };
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fence = FENCE.exec(line);
    if (fence) {
      flushParagraph();
      flushList();
      const body = [];
      for (index += 1; index < lines.length && !FENCE.test(lines[index]); index += 1) body.push(lines[index]);
      blocks.push({ type: "code", lang: fence[1], text: body.join("\n") });
      continue;
    }
    const bullet = BULLET.exec(line);
    if (bullet) {
      flushParagraph();
      const ordered = ORDERED.test(line);
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { type: "list", ordered, items: [] };
      }
      list.items.push(parseInline(bullet[1]));
    } else if (line.trim() === "") {
      flushParagraph();
      flushList();
    } else {
      flushList();
      paragraph.push(line.trim());
    }
  }
  flushParagraph();
  flushList();
  return blocks;
}
