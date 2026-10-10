// Finds the classic memory bugs in a finished trace and pins each to the step where it first shows. Everything here is read
// from what the tracer saw (a freed block still named by a pointer, an unreachable block, the end-of-run signal). What it
// cannot know for sure (why a SIGSEGV happened) is worded as a guess: "likely", "often".
import { classifyOrphans } from "./heapLifetime";
import { identifiersIn } from "./inlineValues";
import { walkValue } from "./valueKeys";

const plural = (n, noun) => `${n} ${noun}${n === 1 ? "" : "s"}`;
const DANGLING_STEPS = 2; // `delete p; p = next;` leaves p dangling for one step: that is the normal idiom, not a bug
const DEEP_STACK = 50; // the tracer keeps at most 64 frames: a crash this deep is almost always runaway recursion
const GENERIC_SEGFAULT = "Likely cause: an invalid or dangling pointer, or an index outside an array.";

function leakEvents(views, runFinished, lifetimes) {
  if (!runFinished) return []; // a run that stopped early never got to store or free what it still held
  const seen = new Set();
  const events = [];
  (lifetimes ?? classifyOrphans(views, { complete: true })).forEach((verdicts, step) => {
    const fresh = [...verdicts].filter(([address, state]) => state === "leaked" && !seen.has(address)).map(([address]) => address);
    if (fresh.length === 0) return;
    fresh.forEach((address) => seen.add(address));
    const bytes = fresh.reduce((sum, address) => sum + (views[step].heap[address]?.size ?? 0), 0);
    events.push({
      id: `leak@${step}`, step, kind: "leak", severity: "bad", line: views[step].line,
      title: `Leak: ${plural(fresh.length, "block")}`,
      detail: `${plural(fresh.length, "block")} (${plural(bytes, "byte")}) can no longer be reached and are never freed.`,
    });
  });
  return events;
}

/** Every pointer that targets freed memory at this step: id (frame index + function + path) -> its path. */
function danglingIds(view) {
  const ids = new Map();
  view.frames.forEach((frame, frameIndex) => {
    for (const [name, entry] of Object.entries(frame.vars)) {
      walkValue(entry, name, (inner, key) => {
        if (inner.kind === "ptr" && inner.state === "freed") ids.set(`${frameIndex}:${frame.fn}:${key}`, key);
      });
    }
  });
  return ids;
}

function danglingEvents(views, crashed) {
  const stretches = new Map(); // id -> { began, key }: the pointers dangling right now, and since which step
  const events = [];
  const report = (id, { began, key }) => events.push({
    id: `dangling@${began}:${id}`, step: began, kind: "dangling", severity: "warn", line: views[began].line,
    title: `Dangling pointer: ${key}`,
    detail: `${key} still holds the address of memory that was freed. Reading or writing through it is undefined behaviour.`,
  });
  views.forEach((view, step) => {
    const now = danglingIds(view);
    for (const id of stretches.keys()) if (!now.has(id)) stretches.delete(id);
    for (const [id, key] of now) {
      if (!stretches.has(id)) stretches.set(id, { began: step, key });
      const stretch = stretches.get(id);
      if (step - stretch.began + 1 === DANGLING_STEPS) report(id, stretch);
    }
  });
  if (crashed) { // the run ended while a pointer was still freshly dangling: that is the likely culprit, not an idiom
    for (const [id, stretch] of stretches) if (views.length - stretch.began < DANGLING_STEPS) report(id, stretch);
  }
  return events;
}

function nullPointerNames(view) {
  const names = [];
  for (const frame of view.frames) {
    for (const [name, entry] of Object.entries(frame.vars)) {
      walkValue(entry, name, (inner, key) => { if (inner.kind === "ptr" && inner.addr === "0x0") names.push(key); });
    }
  }
  return names;
}

/** A segfault's likely cause. A null pointer is only named when the crashing line actually uses it. */
function segfaultDetail(view, crashLine, source) {
  if (view.frames.length >= DEEP_STACK) return `Likely cause: runaway recursion. The call stack was ${view.frames.length} frames deep when it crashed.`;
  const nulls = nullPointerNames(view);
  const lineText = source.split("\n")[crashLine - 1];
  if (lineText === undefined) return nulls.length > 0 ? `Likely cause: a null pointer (null in scope: ${nulls.join(", ")}).` : GENERIC_SEGFAULT;
  const used = new Set(identifiersIn(lineText));
  const named = nulls.filter((key) => used.has(key.split(/[.[]/)[0]));
  if (named.length === 0) return GENERIC_SEGFAULT;
  const many = named.length > 1;
  return `Likely cause: ${named.join(", ")} ${many ? "are" : "is"} null when line ${crashLine} reads through ${many ? "them" : "it"}.`;
}

function crashDetail(signal, view, crashLine, source) {
  if (signal === "SIGSEGV") return segfaultDetail(view, crashLine, source);
  if (signal === "SIGABRT") return "The program aborted. This is often a double free, a corrupted heap, or a failed assert.";
  if (signal === "SIGFPE") return "Arithmetic fault: often an integer division by zero.";
  return "The operating system stopped the program with this signal.";
}

function endEvent(views, trace, source) {
  const step = views.length - 1;
  const view = views[step];
  if (trace.status === "runtime_error" && trace.signal) {
    const line = trace.crashLine ?? view.line;
    return { id: `crash@${step}`, step, kind: "crash", severity: "bad", line, title: `Crash: ${trace.signal}`, detail: crashDetail(trace.signal, view, line, source) };
  }
  if (trace.status === "timeout" || trace.status === "truncated") {
    return { id: `stop@${step}`, step, kind: "timeout", severity: "warn", line: view.line, title: trace.status === "timeout" ? "Run timed out" : "Stopped at the step limit", detail: trace.message ?? "The run did not finish." };
  }
  return null;
}

/**
 * @param {{ heap: object, frames: object[], line: number }[]} views one reconstructed view per step
 * @param {{ status: string, signal?: string|null, crashLine?: number|null, message?: string|null }} trace
 * @param {{ source?: string, lifetimes?: Map[] }} [options] `source`: the program text the trace came from (lets a crash name
 *   only variables its line uses); `lifetimes`: the result of classifyOrphans, when the caller already has it
 * @returns {{ id: string, step: number, kind: "leak"|"dangling"|"crash"|"timeout", severity: "bad"|"warn", line: number, title: string, detail: string }[]}
 *   in step order
 */
export function detectBugs(views, trace, { source = "", lifetimes } = {}) {
  if (views.length === 0) return [];
  const end = endEvent(views, trace, source);
  const events = [...leakEvents(views, trace.status === "ok", lifetimes), ...danglingEvents(views, trace.status === "runtime_error"), ...(end ? [end] : [])];
  return events.sort((a, b) => a.step - b.step);
}

/** The step of the next (direction 1) or previous (-1) finding relative to `index`, or null when there is none that way. */
export function findingStep(bugs, index, direction) {
  const steps = bugs.map((bug) => bug.step);
  const candidates = direction > 0 ? steps.filter((step) => step > index) : steps.filter((step) => step < index);
  if (candidates.length === 0) return null;
  return direction > 0 ? Math.min(...candidates) : Math.max(...candidates);
}
