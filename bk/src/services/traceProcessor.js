const { LIMITS } = require("../utils/limits");

const SCHEMA_VERSION = 1;
const VALUE_KINDS = new Set(["int", "float", "bool", "char", "enum", "ptr", "raw", "unavailable"]);
const STEP_EVENTS = new Set(["step", "call", "return"]);
const END_STATUSES = new Set(["exited", "crashed", "killed", "step_limit", "line_timeout", "tracer_error"]);
const SIGNAL_NAME = /^SIG[A-Z0-9]{1,12}$/;
const MAX_EXIT_CODE = 255;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const HEX_ADDRESS = /^0x[0-9a-f]{1,16}$/;
const COMPILER_DIAGNOSTIC = /^(?:\/tmp\/)?main\.cpp:(\d+):(\d+): (fatal error|error|warning|note): (.*)$/;
const MAX_COMPILE_DIAGNOSTICS = 50;
const MAX_LINE_NUMBER = 1000000;
const MAX_RECORDS = LIMITS.maxSteps * 2 + 10; // steps + skip markers + end: more than this is a forged file

const isInt = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
const clip = (value, max) => (typeof value === "string" ? value.slice(0, max) : null);

function parseCompileErrors(text) {
  if (!text) return [];
  const diagnostics = [];
  for (const raw of text.split("\n")) {
    const match = COMPILER_DIAGNOSTIC.exec(raw);
    if (match && diagnostics.length < MAX_COMPILE_DIAGNOSTICS) {
      diagnostics.push({
        line: Number(match[1]),
        column: Number(match[2]),
        severity: match[3] === "fatal error" ? "error" : match[3],
        message: clip(match[4], LIMITS.maxTextLength),
      });
    }
  }
  return diagnostics;
}

function parseRecords(traceText) {
  const records = [];
  let dropped = 0;
  for (const line of (traceText || "").split("\n")) {
    if (line.trim() === "") continue;
    if (records.length + dropped >= MAX_RECORDS) break;
    try {
      const parsed = JSON.parse(line);
      if (parsed !== null && typeof parsed === "object") records.push(parsed);
      else dropped += 1;
    } catch {
      dropped += 1; // a killed tracer can leave a half-written last line
    }
  }
  return { records, dropped };
}

function sanitizeVar(entry) {
  if (entry === null || typeof entry !== "object" || !VALUE_KINDS.has(entry.kind)) return null;
  const clean = {
    kind: entry.kind,
    type: clip(entry.type, 200) ?? "?",
    value: clip(entry.value, LIMITS.maxTextLength) ?? "",
  };
  if (typeof entry.addr === "string" && HEX_ADDRESS.test(entry.addr)) clean.addr = entry.addr;
  return clean;
}

function sanitizeFrame(frame) {
  if (frame === null || typeof frame !== "object" || !isInt(frame.line, 0, MAX_LINE_NUMBER)) return null;
  const vars = Object.create(null); // names come from user code: never a plain object ("__proto__")
  const entries = frame.vars && typeof frame.vars === "object" ? Object.entries(frame.vars) : [];
  for (const [name, entry] of entries.slice(0, LIMITS.maxVarsPerFrame)) {
    const clean = IDENTIFIER.test(name) ? sanitizeVar(entry) : null;
    if (clean) vars[name] = clean;
  }
  return { fn: clip(frame.fn, 200) ?? "?", line: frame.line, vars };
}

/** What the function that just returned handed back (primitives only). Forged input becomes null, never a guess. */
function sanitizeReturned(entry) {
  const value = sanitizeVar(entry);
  if (value === null) return null;
  return { fn: clip(entry.fn, 200) ?? "?", ...value };
}

function sanitizeStep(record) {
  if (!isInt(record.n, 0, LIMITS.maxSteps) || !isInt(record.line, 0, MAX_LINE_NUMBER)) return null;
  if (!Array.isArray(record.frames) || record.frames.length > LIMITS.maxFramesPerStep) return null;
  const frames = record.frames.map(sanitizeFrame);
  if (frames.some((frame) => frame === null)) return null;
  return {
    n: record.n,
    line: record.line,
    fn: clip(record.fn, 200) ?? "?",
    event: STEP_EVENTS.has(record.event) ? record.event : "step",
    depth: frames.length,
    stdoutLen: isInt(record.stdoutLen, 0, Number.MAX_SAFE_INTEGER) ? Math.min(record.stdoutLen, LIMITS.maxOutputBytes) : 0,
    frames,
    returned: sanitizeReturned(record.returned),
  };
}

function varChanges(index, previous, current) {
  const changed = [];
  for (const name of Object.keys(current.vars)) {
    const before = previous.vars[name];
    if (before === undefined || JSON.stringify(before) !== JSON.stringify(current.vars[name])) {
      changed.push(`f${index}.vars.${name}`);
    }
  }
  for (const name of Object.keys(previous.vars)) {
    if (current.vars[name] === undefined) changed.push(`f${index}.vars.${name}`);
  }
  return changed;
}

function diffFrames(previousFrames, frames) {
  const changes = [];
  const changedFrames = [];
  frames.forEach((frame, index) => {
    const previous = previousFrames[index];
    if (!previous || previous.fn !== frame.fn) {
      changes.push(`f${index}`);
      changedFrames.push({ id: `f${index}`, ...frame });
      return;
    }
    const varDiff = varChanges(index, previous, frame);
    if (varDiff.length > 0 || previous.line !== frame.line) changedFrames.push({ id: `f${index}`, ...frame });
    changes.push(...varDiff);
  });
  return { changes, changedFrames };
}

/** Keyframes carry every frame; other steps carry only frames that changed. `depth` says how many are live. */
function encodeSteps(steps, skips) {
  let previousFrames = [];
  return steps.map((step, position) => {
    const { changes, changedFrames } = diffFrames(previousFrames, step.frames);
    const isKeyframe = position % LIMITS.keyframeEvery === 0;
    const encoded = {
      ...step,
      frames: isKeyframe ? step.frames.map((frame, index) => ({ id: `f${index}`, ...frame })) : changedFrames,
      keyframe: isKeyframe,
      changes,
      skipped: skips.get(step.n) ?? null,
    };
    previousFrames = step.frames;
    return encoded;
  });
}

/** Every field of the end record comes from the untrusted tracer side: re-derive each one. */
function sanitizeEnd(record) {
  return {
    status: record.status,
    exitCode: isInt(record.exitCode, -MAX_EXIT_CODE, MAX_EXIT_CODE) ? record.exitCode : null,
    signal: typeof record.signal === "string" && SIGNAL_NAME.test(record.signal) ? record.signal : null,
    line: isInt(record.line, 0, MAX_LINE_NUMBER) ? record.line : null,
  };
}

function collectSteps(records) {
  const steps = [];
  const skips = new Map();
  let end = null;
  let dropped = 0;
  let pendingSkip = null;
  for (const record of records) {
    if (record.t === "step" && steps.length < LIMITS.maxSteps) {
      const step = sanitizeStep(record);
      if (step === null) {
        dropped += 1;
        continue;
      }
      if (pendingSkip) skips.set(step.n, pendingSkip);
      pendingSkip = null;
      steps.push(step);
    } else if (record.t === "skip" && isInt(record.line, 0, MAX_LINE_NUMBER)) {
      pendingSkip = { line: record.line, reason: clip(record.reason, 50) ?? "unknown" };
    } else if (record.t === "end" && END_STATUSES.has(record.status)) {
      end = sanitizeEnd(record);
    } else if (record.t !== "step") {
      dropped += 1;
    }
  }
  return { steps, skips, end, dropped };
}

function decideStatus(raw, end, stepCount) {
  if (raw.compileExitCode !== null && raw.compileExitCode !== 0) {
    return { status: "compile_error", message: raw.compileExitCode === 124 ? "Compilation timed out" : "Compilation failed" };
  }
  if (end) {
    const byEnd = {
      exited: { status: "ok", message: null },
      crashed: { status: "runtime_error", message: `Program crashed with ${end.signal || "a signal"}` },
      tracer_error: { status: "internal_error", message: "The tracer failed while running the program" },
      killed: { status: "runtime_error", message: "Program was killed by the system (for example by the memory limit)" },
      step_limit: { status: "truncated", message: `Stopped after ${LIMITS.maxSteps} steps` },
      line_timeout: { status: "timeout", message: `Line ${end.line} did not finish (possible infinite loop)` },
    };
    return byEnd[end.status];
  }
  if (raw.timedOut || stepCount > 0) return { status: "timeout", message: "Execution exceeded the time limit" };
  return { status: "internal_error", message: "The tracer produced no result" };
}

/**
 * Turns raw runner outputs into the schema-v1 trace the frontend consumes.
 * @param {object} raw  output of runnerService.runTrace
 * @returns {object}
 */
function buildTrace(raw) {
  const { records, dropped: unparsable } = parseRecords(raw.traceText);
  const { steps, skips, end, dropped } = collectSteps(records);
  const { status, message } = decideStatus(raw, end, steps.length);
  const truncated = ["truncated", "timeout"].includes(status) || Boolean(raw.traceTruncated);
  return {
    schema: SCHEMA_VERSION,
    status,
    message,
    exitCode: end ? end.exitCode ?? null : null,
    signal: end ? end.signal ?? null : null,
    crashLine: end && end.status === "crashed" ? end.line ?? null : null,
    limits: { maxSteps: LIMITS.maxSteps, stepsRecorded: steps.length, truncated, stdoutTruncated: Boolean(raw.stdoutTruncated) },
    droppedRecords: unparsable + dropped,
    compileErrors: parseCompileErrors(raw.compileOutput),
    compileOutput: status === "compile_error" ? clip(raw.compileOutput, LIMITS.maxOutputBytes) : null,
    stdout: raw.stdout ?? "",
    stderr: raw.stderr ?? "",
    keyframeEvery: LIMITS.keyframeEvery,
    steps: status === "compile_error" ? [] : encodeSteps(steps, skips),
  };
}

module.exports = { buildTrace, parseCompileErrors, SCHEMA_VERSION };
