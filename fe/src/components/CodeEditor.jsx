import { autocompletion, closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { cpp } from "@codemirror/lang-cpp";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { HighlightStyle, bracketMatching, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, keymap, lineNumbers } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { useCallback, useEffect, useRef, useState } from "react";
import { cppCompletionSource } from "../lib/cppCompletions";
import { caretOffset, formatCpp } from "../lib/formatCpp";

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
  { tag: [tags.keyword, tags.controlKeyword, tags.modifier], color: "oklch(78% 0.12 320)" },
  { tag: [tags.typeName, tags.standard(tags.typeName)], color: "oklch(80% 0.11 235)" },
  { tag: [tags.number, tags.bool, tags.null], color: "oklch(78% 0.14 55)" },
  { tag: [tags.string, tags.character], color: "oklch(82% 0.09 150)" },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: "oklch(55% 0.01 280)", fontStyle: "italic" },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: "oklch(88% 0.1 88)" },
  { tag: [tags.processingInstruction, tags.macroName], color: "oklch(74% 0.1 30)" },
]);

const editorTheme = EditorView.theme({
  "&": { height: "100%", backgroundColor: "transparent", color: "var(--text)" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", fontSize: "14px", lineHeight: "1.65" },
  ".cm-content": { caretColor: "var(--accent)", padding: "12px 0" },
  ".cm-gutters": { backgroundColor: "var(--bg)", color: "var(--muted-dim)", border: "none" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 12px 0 18px", minWidth: "44px" },
  "&.cm-focused": { outline: "none" },
  ".cm-tooltip": { backgroundColor: "var(--raised)", color: "var(--text)", border: "1px solid var(--line)", borderRadius: "10px", boxShadow: "0 12px 32px oklch(0% 0 0 / 0.5)", overflow: "hidden" },
  ".cm-tooltip-autocomplete > ul": { fontFamily: "var(--font-mono)", fontSize: "13px", maxHeight: "14em" },
  ".cm-tooltip-autocomplete > ul > li": { padding: "2px 10px" },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "var(--accent-soft)", color: "var(--accent)" },
  ".cm-completionMatchedText": { textDecoration: "none", fontWeight: "700", color: "var(--accent)" },
  ".cm-completionIcon": { opacity: "0.7" },
  "&.cm-focused .cm-cursor": { borderLeftColor: "var(--accent)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": { backgroundColor: "oklch(38% 0.04 280 / 0.6) !important" },
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
  const formattingRef = useRef(false);
  const [format, setFormat] = useState({ busy: false, error: null });

  const runFormat = useCallback(async () => {
    const view = viewRef.current;
    if (!view || formattingRef.current) return;
    formattingRef.current = true;
    const before = view.state.doc.toString();
    setFormat({ busy: true, error: null });
    try {
      const formatted = await formatCpp(before);
      if (viewRef.current !== view) return; // the editor was unmounted while the formatter loaded
      if (view.state.doc.toString() !== before) {
        setFormat({ busy: false, error: "Code changed while formatting, try again" }); // never overwrite newer typing
        return;
      }
      if (formatted !== before) {
        const caret = view.state.doc.lineAt(view.state.selection.main.head);
        const anchor = caretOffset(formatted, caret.number, view.state.selection.main.head - caret.from);
        view.dispatch({ changes: { from: 0, to: before.length, insert: formatted }, selection: { anchor }, scrollIntoView: true });
      }
      setFormat({ busy: false, error: null });
    } catch (error) {
      setFormat({ busy: false, error: `Could not format: ${error instanceof Error ? error.message : "unknown error"}` });
    } finally {
      formattingRef.current = false;
    }
  }, []);

  useEffect(() => {
    const view = new EditorView({
      parent: hostRef.current,
      doc: initialCode,
      extensions: [
        lineNumbers(),
        history(),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        cpp(),
        autocompletion({ override: [cppCompletionSource] }),
        syntaxHighlighting(highlightStyle),
        marksField,
        editorTheme,
        keymap.of([
          { key: "Mod-Enter", run: () => { handlers.current.onRun(); return true; } },
          { key: "Shift-Alt-f", run: () => { runFormat(); return true; } },
          indentWithTab,
          ...closeBracketsKeymap,
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
    return () => {
      viewRef.current = null;
      view.destroy();
    };
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

  return (
    <>
      <div className="editor-bar">
        <span className="editor-bar-title">main.cpp</span>
        {format.error && <span className="editor-bar-error" role="alert">{format.error}</span>}
        <button type="button" className="btn btn-small" onClick={runFormat} aria-busy={format.busy} aria-keyshortcuts="Shift+Alt+F" title="Format code (Shift+Alt+F)">
          {format.busy ? "Formatting…" : "Format"}
        </button>
      </div>
      <div className="editor-host" ref={hostRef} />
    </>
  );
}
