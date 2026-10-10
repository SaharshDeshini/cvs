import { cpp } from "@codemirror/lang-cpp";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { HighlightStyle, bracketMatching, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, keymap, lineNumbers } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { useEffect, useRef } from "react";

const setMarks = StateEffect.define();

// Line decorations (current execution line, error lines) live in editor state, so they survive typing and scrolling.
const marksField = StateField.define({
  create: () => Decoration.none,
  update(marks, transaction) {
    let next = marks.map(transaction.changes);
    for (const effect of transaction.effects) if (effect.is(setMarks)) next = effect.value;
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const highlightStyle = HighlightStyle.define([
  { tag: [tags.keyword, tags.controlKeyword, tags.modifier], color: "oklch(78% 0.13 340)" },
  { tag: [tags.typeName, tags.standard(tags.typeName)], color: "oklch(82% 0.1 215)" },
  { tag: [tags.number, tags.bool, tags.null], color: "oklch(82% 0.13 60)" },
  { tag: [tags.string, tags.character], color: "oklch(82% 0.11 165)" },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: "oklch(60% 0.02 200)", fontStyle: "italic" },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: "oklch(86% 0.1 90)" },
  { tag: [tags.processingInstruction, tags.macroName], color: "oklch(74% 0.1 30)" },
]);

const editorTheme = EditorView.theme({
  "&": { height: "100%", backgroundColor: "transparent", color: "var(--text)" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", fontSize: "14px", lineHeight: "1.65" },
  ".cm-content": { caretColor: "var(--accent)", padding: "12px 0" },
  ".cm-gutters": { backgroundColor: "var(--surface)", color: "var(--muted-dim)", border: "none" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 12px 0 18px", minWidth: "44px" },
  "&.cm-focused": { outline: "none" },
  "&.cm-focused .cm-cursor": { borderLeftColor: "var(--accent)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": { backgroundColor: "oklch(40% 0.05 200 / 0.55) !important" },
});

/** The faint "sum = 6   x = 7" text after the line about to run. Not part of the document: the editor text is untouched. */
class InlineValues extends WidgetType {
  constructor(text) {
    super();
    this.text = text;
  }

  eq(other) {
    return other.text === this.text;
  }

  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-inline-values";
    span.textContent = this.text;
    span.setAttribute("aria-hidden", "true");
    return span;
  }

  ignoreEvent() {
    return true;
  }
}

function buildMarks(doc, currentLine, errorLines, inlineText) {
  const inDoc = (line) => Number.isInteger(line) && line >= 1 && line <= doc.lines;
  const ranges = [];
  if (inDoc(currentLine)) ranges.push(Decoration.line({ class: "cm-exec-line" }).range(doc.line(currentLine).from));
  if (inDoc(currentLine) && inlineText) ranges.push(Decoration.widget({ widget: new InlineValues(inlineText), side: 1 }).range(doc.line(currentLine).to));
  for (const line of errorLines) {
    if (inDoc(line)) ranges.push(Decoration.line({ class: "cm-error-line" }).range(doc.line(line).from));
  }
  return Decoration.set(ranges, true);
}

/**
 * CodeMirror 6 editor. The editor owns the text; `initialCode` is only read once.
 * `currentLine` / `errorLines` are 1-based and may be null/empty.
 */
export default function CodeEditor({ initialCode, onChange, onRun, currentLine, errorLines, inlineText = null }) {
  const hostRef = useRef(null);
  const viewRef = useRef(null);
  const handlers = useRef({ onChange, onRun });
  handlers.current = { onChange, onRun };

  useEffect(() => {
    const view = new EditorView({
      parent: hostRef.current,
      doc: initialCode,
      extensions: [
        lineNumbers(),
        history(),
        indentOnInput(),
        bracketMatching(),
        cpp(),
        syntaxHighlighting(highlightStyle),
        marksField,
        editorTheme,
        keymap.of([
          { key: "Mod-Enter", run: () => { handlers.current.onRun(); return true; } },
          indentWithTab,
          ...defaultKeymap,
          ...historyKeymap,
        ]),
        EditorView.contentAttributes.of({ "aria-label": "C++ source code" }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) handlers.current.onChange(update.state.doc.toString());
        }),
      ],
    });
    viewRef.current = view;
    return () => view.destroy();
    // initialCode is intentionally read once: the editor is the source of truth afterwards.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const marks = buildMarks(view.state.doc, currentLine, errorLines, inlineText);
    const effects = [setMarks.of(marks)];
    if (Number.isInteger(currentLine) && currentLine >= 1 && currentLine <= view.state.doc.lines) {
      effects.push(EditorView.scrollIntoView(view.state.doc.line(currentLine).from, { y: "nearest", yMargin: 48 }));
    }
    view.dispatch({ effects });
  }, [currentLine, errorLines, inlineText]);

  return <div className="editor-host" ref={hostRef} />;
}
