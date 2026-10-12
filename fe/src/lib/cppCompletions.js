import { syntaxTree } from "@codemirror/language";

const KEYWORDS = Object.freeze([
  "alignas", "auto", "bool", "break", "case", "catch", "char", "class", "const", "constexpr", "continue", "default", "delete", "do",
  "double", "else", "enum", "explicit", "false", "final", "float", "for", "friend", "goto", "if", "inline", "int", "long", "mutable",
  "namespace", "new", "noexcept", "nullptr", "operator", "override", "private", "protected", "public", "return", "short", "signed",
  "sizeof", "static", "static_cast", "struct", "switch", "template", "this", "throw", "true", "try", "typedef", "typename", "union",
  "unsigned", "using", "virtual", "void", "volatile", "while",
]);

const BUILTIN_TYPES = new Set(["auto", "bool", "char", "double", "float", "int", "long", "short", "signed", "unsigned", "void"]);

const STD_CLASSES = Object.freeze([
  "array", "bitset", "deque", "list", "map", "multimap", "multiset", "optional", "pair", "priority_queue", "queue", "set", "shared_ptr",
  "stack", "string", "tuple", "unique_ptr", "unordered_map", "unordered_set", "vector",
]);

const STD_FUNCTIONS = Object.freeze([
  "abs", "accumulate", "binary_search", "count", "fill", "find", "getline", "iota", "lower_bound", "make_pair", "make_shared", "make_unique",
  "max", "max_element", "min", "min_element", "move", "pow", "printf", "reverse", "scanf", "sort", "sqrt", "stoi", "stod", "swap", "to_string",
  "upper_bound",
]);

const STD_OBJECTS = Object.freeze(["cerr", "cin", "cout", "endl"]);

// Words that can precede a name without being a type; `return total;` is not a declaration of `total`.
const NOT_A_TYPE = new Set([
  ...KEYWORDS.filter((word) => !BUILTIN_TYPES.has(word)),
  "co_return", "co_await", "co_yield", "defined", "elif", "endif", "ifdef", "ifndef", "include", "pragma",
]);

const USER_BOOST = 99;
// The scans can go quadratic on huge text with no `;` or braces (measured by the reviewer: 25 s at 300 KB), so large documents get no name scan.
const MAX_SCAN_CHARS = 100_000;
const symbolCache = new WeakMap(); // CodeMirror documents are immutable: one scan per document version
const NOT_IN_CODE = /Comment|String|Char|Preproc|Include/;

// Comments, strings and preprocessor lines are blanked out so declarations inside them are not reported.
const NOISE = /\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|^[ \t]*#[^\n]*/gm;

const MODIFIERS = String.raw`(?:(?:const|static|unsigned|signed|long|short|volatile|register|constexpr|inline)\s+)*`;
const TYPE = String.raw`[A-Za-z_]\w*(?:::\w+)*(?:<[^;(){}]*?>)?`;
const DECLARATION_HEAD = String.raw`(?<=^|[;{}(,])\s*${MODIFIERS}(${TYPE})(?:\s*[*&]+\s*(?:const\s+)?|\s+)`;
const VARIABLE = new RegExp(String.raw`${DECLARATION_HEAD}([A-Za-z_]\w*)(?=\s*(?:=|;|,|\[|\)|\{|:(?!:)))`, "gm");
const FUNCTION = new RegExp(String.raw`${DECLARATION_HEAD}([A-Za-z_]\w*)\s*\([^;{}]*\)\s*(?:const\s*)?(?:noexcept\s*)?(?:override\s*)?[{;]`, "gm");
const TYPE_NAME = /\b(?:struct|class|enum(?:\s+class)?|union)\s+([A-Za-z_]\w*)|\busing\s+([A-Za-z_]\w*)\s*=/g;

const blankOut = (match) => match.replace(/[^\n]/g, " ");
const isName = (word) => Boolean(word) && !NOT_A_TYPE.has(word) && !BUILTIN_TYPES.has(word);

/** Names from `<type> <name>` declarations. A match whose leading word is a keyword (`return total;`) is not one. */
function declaredNames(pattern, text) {
  const names = new Set();
  for (const match of text.matchAll(pattern)) {
    if (!NOT_A_TYPE.has(match[1]) && isName(match[2])) names.add(match[2]);
  }
  return [...names];
}

function typeNames(text) {
  const names = new Set();
  for (const match of text.matchAll(TYPE_NAME)) {
    const name = match[1] ?? match[2];
    if (isName(name)) names.add(name);
  }
  return [...names];
}

/** Names the user has declared: `{ functions, variables, types }`, each a de-duplicated array. A heuristic scan, not a parser. */
export function collectSymbols(source) {
  const text = String(source ?? "").replace(NOISE, blankOut);
  return {
    functions: declaredNames(FUNCTION, text),
    variables: declaredNames(VARIABLE, text),
    types: typeNames(text),
  };
}

const option = (label, type, boost = 0) => ({ label, type, boost });

function stdOptions() {
  return [
    ...STD_CLASSES.map((name) => option(name, "class")),
    ...STD_FUNCTIONS.map((name) => option(name, "function")),
    ...STD_OBJECTS.map((name) => option(name, "variable")),
  ];
}

function keywordOptions() {
  return KEYWORDS.map((word) => option(word, BUILTIN_TYPES.has(word) ? "type" : "keyword"));
}

/**
 * Suggestions for a word being typed. `qualifier` is the text typed before the word, e.g. "" or "std::".
 * Names the user declared override library names with the same label and rank first.
 */
export function buildOptions(symbols, qualifier = "") {
  if (qualifier === "std::") return stdOptions();
  if (qualifier) return [];
  const byLabel = new Map([...keywordOptions(), ...stdOptions()].map((entry) => [entry.label, entry]));
  const user = [
    ...symbols.types.map((name) => option(name, "class", USER_BOOST)),
    ...symbols.functions.map((name) => option(name, "function", USER_BOOST)),
    ...symbols.variables.map((name) => option(name, "variable", USER_BOOST)),
  ];
  for (const entry of user) byLabel.set(entry.label, entry);
  return [...byLabel.values()];
}

function symbolsOf(doc) {
  if (!symbolCache.has(doc)) {
    symbolCache.set(doc, doc.length > MAX_SCAN_CHARS ? { functions: [], variables: [], types: [] } : collectSymbols(doc.toString()));
  }
  return symbolCache.get(doc);
}

/** CodeMirror completion source: suggests keywords, std names and the names declared in the document. */
export function cppCompletionSource(context) {
  const word = context.matchBefore(/[\w:]*/);
  if (!word || (word.from === word.to && !context.explicit) || /^\d/.test(word.text)) return null;
  if (NOT_IN_CODE.test(syntaxTree(context.state).resolveInner(context.pos, -1).name)) return null;
  const qualifierEnd = word.text.lastIndexOf("::") + 2;
  const qualifier = qualifierEnd > 1 ? word.text.slice(0, qualifierEnd) : "";
  const options = buildOptions(symbolsOf(context.state.doc), qualifier);
  return options.length === 0 ? null : { from: word.from + qualifier.length, options, validFor: /^\w*$/ };
}
