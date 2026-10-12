// clang-format compiled to WebAssembly (~5 MB). Loaded on the first Format click, so it costs nothing at startup.
const STYLE = JSON.stringify({ BasedOnStyle: "LLVM", IndentWidth: 4, ColumnLimit: 100, AllowShortFunctionsOnASingleLine: "None" });
const FILE_NAME = "main.cpp";

let formatterPromise = null;

function loadFormatter() {
  if (!formatterPromise) {
    formatterPromise = import("@wasm-fmt/clang-format/vite")
      .then(async (module) => {
        if (typeof module.default === "function") await module.default(); // the Node entry (used by tests) needs no init
        return module.format;
      })
      .catch((error) => {
        formatterPromise = null; // allow a retry after a failed download
        throw error;
      });
  }
  return formatterPromise;
}

/** Offset in `text` of 1-based `lineNumber` and 0-based `column`, clamped to the text. Keeps the caret on the same line after a reformat. */
export function caretOffset(text, lineNumber, column) {
  const lines = text.split("\n");
  const index = Math.max(0, Math.min(lineNumber, lines.length) - 1);
  const lineStart = lines.slice(0, index).reduce((sum, line) => sum + line.length + 1, 0);
  return lineStart + Math.min(column, lines[index].length);
}

/** Returns `source` formatted like clang-format would. Rejects if the formatter cannot load or the text cannot be formatted. */
export async function formatCpp(source) {
  const format = await loadFormatter();
  return format(source, FILE_NAME, STYLE);
}
