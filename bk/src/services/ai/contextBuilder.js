// Builds the ONLY facts the model gets about a run: the numbered source, how the run ended, a map of calls/returns, a timeline of
// each variable's changes, and a detailed snapshot of the step being asked about. Everything is read from the server-held trace;
// every section is size-capped (free-tier token budgets are small) and text that came from the user's program is fenced as data.
// Step numbers written for the model are 1-based, exactly as the UI shows them ("Step 3"); the views are indexed from 0.
const { stdoutAt } = require("./traceDecoder");

const CAP = Object.freeze({
  sourceChars: 16_000, compileOutputChars: 3000, streamChars: 1500, valueChars: 200, timelineValueChars: 40,
  arrayItems: 16, structFields: 12, valueDepth: 3, runMapLines: 100, timelineKeys: 40, timelineChanges: 30,
  timelineChars: 5000, heapBlocks: 12, lookahead: 3, findings: 20, changedVars: 12,
});

const clip = (text, max) => (text.length > max ? `${text.slice(0, max)}…` : text);
// program text may contain our fence markers; break them so it cannot close its own fence
const neutralize = (text) => String(text).replaceAll("<<<", "<‹<").replaceAll(">>>", ">›>");
const fence = (label, text) => `<<<${label}\n${neutralize(text)}\n>>>`;

function fmtPointer(value) {
  if (value.addr === "0x0" || value.state === "null") return "nullptr";
  const where = value.state === "freed" ? " (FREED)" : value.state === "heap" ? " (heap)" : "";
  return `-> ${value.addr ?? "?"}${where}`;
}

function fmtItem(item, depth) {
  return typeof item === "string" ? clip(item, 40) : fmtValue(item, depth);
}

function fmtValue(value, depth = 0) {
  if (value === null || typeof value !== "object") return "?";
  if (value.kind === "ptr") return fmtPointer(value);
  if (value.kind === "unavailable") return "<unreadable>";
  if (value.kind === "raw") return `raw(${clip(value.value ?? "", CAP.valueChars)})`;
  if (value.kind === "string") return JSON.stringify(clip(value.value ?? "", CAP.valueChars));
  if (value.kind === "array" || value.kind === "seq") {
    const items = (value.items ?? []).slice(0, CAP.arrayItems).map((item) => fmtItem(item, depth + 1));
    const total = value.len ?? items.length;
    const rest = total > items.length ? `, … ${total - items.length} more` : "";
    return `${value.kind === "seq" ? `${value.container}(${total}) ` : ""}[${items.join(", ")}${rest}]`;
  }
  if (value.kind === "map") {
    const pairs = (value.items ?? []).slice(0, CAP.arrayItems).map((pair) => `${fmtItem(pair.k, depth + 1)}: ${fmtItem(pair.v, depth + 1)}`);
    return `${value.container}(${value.len ?? pairs.length}) {${pairs.join(", ")}}`;
  }
  if (value.kind === "struct") {
    if (depth >= CAP.valueDepth) return "{…}";
    const fields = (value.fields ?? []).slice(0, CAP.structFields).map((field) => `${field.name}=${fmtValue(field.v, depth + 1)}`);
    return `{${fields.join(", ")}${value.more ? ", …" : ""}}`;
  }
  return clip(String(value.value ?? "?"), CAP.valueChars);
}

const fmtVars = (vars) => Object.entries(vars).map(([name, value]) => `${name} = ${fmtValue(value)}`).join(", ") || "(no variables yet)";

function numberedSource(code) {
  const lines = code.split("\n");
  const width = String(lines.length).length;
  const text = lines.map((line, index) => `${String(index + 1).padStart(width)} | ${line}`).join("\n");
  return clip(text, CAP.sourceChars);
}

function outcomeText(run, findings) {
  const { trace } = run;
  const out = [`status: ${trace.status}${trace.message ? ` (${trace.message})` : ""}`];
  if (trace.exitCode !== null && trace.exitCode !== undefined) out.push(`exit code: ${trace.exitCode}`);
  if (trace.signal) out.push(`signal: ${trace.signal}${trace.crashLine ? ` on line ${trace.crashLine}` : ""}`);
  out.push(`steps recorded: ${trace.steps.length}${trace.limits?.truncated ? " (the run was cut short)" : ""}`);
  if (trace.compileErrors?.length) {
    out.push("compiler diagnostics:", ...trace.compileErrors.map((d) => `  line ${d.line}:${d.column} ${d.severity}: ${neutralize(d.message ?? "")}`));
  }
  if (trace.compileOutput) out.push(fence("COMPILER_OUTPUT", clip(trace.compileOutput, CAP.compileOutputChars)));
  if (trace.stderr) out.push(fence("PROGRAM_STDERR", clip(trace.stderr, CAP.streamChars)));
  if (findings.length) {
    out.push("problems found by CVis' analyzer (derived from this trace):");
    out.push(...findings.map((f) => `  step ${f.step + 1} [${f.severity}] line ${f.line}: ${f.title}. ${f.detail}`));
  }
  return out.join("\n");
}

function callText(view) {
  const top = view.frames.at(-1);
  const args = top ? Object.entries(top.vars).slice(0, 4).map(([name, value]) => `${name}=${clip(fmtValue(value), 24)}`).join(", ") : "";
  return `${view.fn}(${args})`;
}

function runMap(views) {
  const events = [];
  views.forEach((view, index) => {
    if (view.event === "call") events.push(`step ${index + 1}: call ${callText(view)} [depth ${view.depth}]`);
    else if (view.event === "return" && view.returned) events.push(`step ${index + 1}: ${view.returned.fn}() returned ${fmtValue(view.returned)}`);
  });
  if (events.length <= CAP.runMapLines) return events.join("\n") || "(no function calls were recorded)";
  const half = CAP.runMapLines / 2;
  return [...events.slice(0, half), `… ${events.length - CAP.runMapLines} events omitted …`, ...events.slice(-half)].join("\n");
}

/**
 * Every variable's displayed value over the whole run, as "fn[frame].name" -> its changes. A decoded frame that did not change
 * is the SAME object as at the previous step, so it is skipped without looking inside.
 */
function buildSeries(views) {
  const series = new Map();
  const seenAt = []; // the frame object last looked at for each stack position
  views.forEach((view, index) => {
    view.frames.forEach((frame, frameIndex) => {
      if (seenAt[frameIndex] === frame) return;
      seenAt[frameIndex] = frame;
      for (const [name, value] of Object.entries(frame.vars)) {
        const key = `${frame.fn}[${frameIndex}].${name}`;
        const shown = clip(fmtValue(value), CAP.timelineValueChars);
        const entry = series.get(key) ?? { last: undefined, changes: [] };
        if (entry.last !== shown && entry.changes.length < CAP.timelineChanges) entry.changes.push(`s${index + 1}=${shown}`);
        entry.last = shown;
        series.set(key, entry);
      }
    });
    seenAt.length = view.frames.length; // frames above the live depth have returned
  });
  return series;
}

// What does not depend on the step asked about is computed once per run (the views array identifies a run) and then reused:
// measured 0.4-1.0 s per question on a 5,000-step run before this, and it blocks the server's event loop while it runs.
const derivedByRun = new WeakMap();
function derived(views) {
  let result = derivedByRun.get(views);
  if (!result) {
    result = { series: buildSeries(views), runMap: runMap(views) };
    derivedByRun.set(views, result);
  }
  return result;
}

/** Per variable: the steps where its value changed and what it became. Variables alive at the focus step come first. */
function variableTimeline(views, focus) {
  const { series } = derived(views);
  const live = new Set(views[focus]?.frames.flatMap((frame, i) => Object.keys(frame.vars).map((name) => `${frame.fn}[${i}].${name}`)) ?? []);
  const ordered = [...series.keys()].sort((a, b) => Number(live.has(b)) - Number(live.has(a))).slice(0, CAP.timelineKeys);
  return clip(ordered.map((key) => `${key}: ${series.get(key).changes.join(" ")}`).join("\n"), CAP.timelineChars);
}

/** The variable names a change path stands for: "f1.vars.n" is one variable, a whole-frame change "f1" (a call) is all of its variables. */
function changedNames(view, path) {
  const single = /^f(\d+)\.vars\.(.+)$/.exec(path);
  if (single) return [[Number(single[1]), single[2]]];
  const whole = /^f(\d+)$/.exec(path);
  return whole ? Object.keys(view.frames[Number(whole[1])]?.vars ?? {}).map((name) => [Number(whole[1]), name]) : [];
}

function changedVars(views, index) {
  const view = views[index];
  const before = views[index - 1];
  const lines = [];
  for (const path of view.changes) {
    for (const [frameIndex, name] of changedNames(view, path)) {
      const frame = view.frames[frameIndex];
      const earlier = before?.frames[frameIndex];
      const now = frame?.vars[name];
      const was = earlier?.fn === frame?.fn ? earlier?.vars[name] : undefined; // a different function in that slot is a new frame
      lines.push(`${frame?.fn ?? "?"}.${name}: ${was ? fmtValue(was) : "(not declared)"} -> ${now ? fmtValue(now) : "(out of scope)"}`);
    }
  }
  return lines.slice(0, CAP.changedVars);
}

function heapText(view) {
  const blocks = Object.entries(view.heap).slice(0, CAP.heapBlocks).map(([address, block]) => {
    const state = block.live ? "live" : "FREED";
    return `${address} [${block.ty || "?"}, ${block.size} bytes, ${state}]${block.v ? ` ${fmtValue(block.v)}` : ""}`;
  });
  const extra = Object.keys(view.heap).length - blocks.length;
  return [...blocks, ...(extra > 0 ? [`… ${extra} more blocks`] : [])].join("\n") || "(no heap allocations)";
}

/** The facts about ONE step, as text. The verifier checks the model's quoted numbers against this same text. */
function snapshotText(run, index) {
  const view = run.views[index];
  if (!view) return "";
  const sourceLine = run.code.split("\n")[view.line - 1] ?? "";
  const out = [
    `STEP ${index + 1} of ${run.views.length} (event: ${view.event}; function: ${view.fn}; stack depth: ${view.depth})`,
    `Line ${view.line} is about to run (variables below are the state BEFORE it runs): ${fence("SOURCE_LINE", sourceLine.trim())}`,
    "Call stack (outermost first):",
    ...view.frames.map((frame, i) => `  #${i} ${frame.fn} at line ${frame.line}: ${fmtVars(frame.vars)}`),
    "Heap blocks:", heapText(view),
  ];
  const changes = changedVars(run.views, index);
  if (changes.length) out.push("Variables that changed at this step:", ...changes.map((line) => `  ${line}`));
  if (view.returned) out.push(`The call that just finished: ${view.returned.fn}() returned ${fmtValue(view.returned)}`);
  if (view.skipped) out.push(`A one-line loop at line ${view.skipped.line} was run at full speed (its iterations are not stepped).`);
  const stdout = stdoutAt(run.trace, run.views, index);
  out.push(`Program output so far: ${stdout ? fence("PROGRAM_OUTPUT", clip(stdout, CAP.streamChars)) : "(none)"}`);
  return out.join("\n");
}

function neighbourText(views, index) {
  const brief = (i) => `step ${i + 1}: line ${views[i].line} in ${views[i].fn} (${views[i].event})`;
  const lines = index > 0 ? [`Previous: ${brief(index - 1)}`] : ["Previous: (this is the first step)"];
  const upcoming = views.slice(index + 1, index + 1 + CAP.lookahead).map((_, offset) => brief(index + 1 + offset));
  return [...lines, ...(upcoming.length ? ["Next:", ...upcoming.map((line) => `  ${line}`)] : ["Next: (this is the last step)"])].join("\n");
}

/**
 * @param {{ code: string, stdin: string, trace: object, views: object[] }} run
 * @param {{ step: number | null, findings?: object[] }} focus
 * @returns {string}
 */
function buildContext(run, { step, findings = [] }) {
  const parts = [
    `PROGRAM (C++, line-numbered):\n${fence("SOURCE", numberedSource(run.code))}`,
    `RUN OUTCOME:\n${outcomeText(run, findings.slice(0, CAP.findings))}`,
  ];
  if (run.views.length > 0) {
    parts.push(`CALLS AND RETURNS (whole run):\n${derived(run.views).runMap}`);
    parts.push(`VARIABLE TIMELINE (step=value, only when it changed):\n${variableTimeline(run.views, step ?? 0)}`);
  }
  if (step !== null && run.views[step]) {
    parts.push(`CURRENT STEP:\n${snapshotText(run, step)}`, `NEIGHBOURING STEPS:\n${neighbourText(run.views, step)}`);
  }
  return parts.join("\n\n");
}

/** Everything the model may legitimately quote that is not tied to one step. The verifier uses it as the "global" fact text. */
function globalFactText(run, findings = []) {
  return [run.code, outcomeText(run, findings), run.trace.stdout ?? "", derived(run.views).runMap, variableTimeline(run.views, 0)].join("\n");
}

module.exports = { buildContext, snapshotText, globalFactText, fmtValue, CAP };
