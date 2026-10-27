// Checks a model answer against the run it is about. It cannot prove an explanation right, but it catches the two ways a
// hallucination shows up in this product: a citation to a step that does not exist, and a quoted number or address that appears
// nowhere in the facts the model was given. Invalid citations are removed; unmatched values are reported, never silently fixed.
const CITATION = /\[\[step:(\d{1,6})\]\]/g;
const BACKTICKED = /`([^`\n]{1,40})`/g;
const NUMBER_OR_HEX = /^(?:-?\d+(?:\.\d+)?|0x[0-9a-fA-F]+)$/;
const TOKEN = /0x[0-9a-fA-F]+|-?\d+(?:\.\d+)?/g;
const MAX_REPORTED = 8;

/** Every number and hex address in a text, plus the unsigned form of negatives ("-5" also gives "5"). */
function tokensOf(text) {
  const tokens = new Set();
  for (const token of text.match(TOKEN) ?? []) {
    tokens.add(token.toLowerCase());
    if (token.startsWith("-")) tokens.add(token.slice(1));
  }
  return tokens;
}

function extractCitations(text, totalSteps) {
  const valid = new Set();
  let invalid = 0;
  const cleaned = text.replace(CITATION, (marker, digits) => {
    const step = Number(digits) - 1; // the text uses the UI numbering (from 1); everything else uses 0-based indexes
    if (step >= 0 && step < totalSteps) {
      valid.add(step);
      return marker;
    }
    invalid += 1;
    return "";
  });
  return { cleaned: cleaned.replace(/ {2,}/g, " ").replace(/ +([.,;:!?])/g, "$1"), valid: [...valid].sort((a, b) => a - b), invalid };
}

/**
 * @param {string} answer the model's text
 * @param {{ totalSteps: number, focusStep: number | null, factsForStep: (step: number) => string, globalFacts: string }} facts
 * @returns {{ text: string, citations: number[], invalidCitations: number, unverifiedValues: string[] }}
 */
function verifyAnswer(answer, { totalSteps, focusStep, factsForStep, globalFacts }) {
  const { cleaned, valid, invalid } = extractCitations(answer, totalSteps);
  const known = tokensOf(globalFacts);
  for (const step of new Set([...valid, ...(focusStep === null ? [] : [focusStep])])) {
    for (const token of tokensOf(factsForStep(step))) known.add(token);
  }
  const unverified = new Set();
  for (const [, quoted] of cleaned.matchAll(BACKTICKED)) {
    const value = quoted.trim();
    if (NUMBER_OR_HEX.test(value) && !known.has(value.toLowerCase())) unverified.add(value);
  }
  return { text: cleaned, citations: valid, invalidCitations: invalid, unverifiedValues: [...unverified].slice(0, MAX_REPORTED) };
}

module.exports = { verifyAnswer, tokensOf };
