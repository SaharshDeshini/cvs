// Every resource limit in one place. Values are measured/justified in docs/RESEARCH.md (Phase 1/2).
const LIMITS = Object.freeze({
  maxCodeBytes: 100 * 1024,
  maxStdinBytes: 10 * 1024,
  maxSteps: 5000,
  keyframeEvery: 50,
  maxFramesPerStep: 64,
  maxVarsPerFrame: 200,
  maxValueNodes: 3000, // entries (values, fields, items) in one step; the tracer stops at 2,500
  maxItems: 64, // array / container elements shown per value (the tracer's window)
  maxFields: 40,
  maxHeapBlocks: 150,
  maxTextLength: 1000,
  maxTraceBytes: 5 * 1024 * 1024, // an honest 5,000-step trace is well under this
  maxOutputBytes: 1024 * 1024, // each of stdout / stderr / compiler output
  maxCompileOutputBytes: 20000,
  maxRunnerStdoutBytes: 8 * 1024 * 1024, // all frames together; more means a forged stream
  maxConcurrentRuns: 2,
  compileSeconds: 20,
  traceSeconds: 25,
  wallClockMs: 60 * 1000, // must exceed compileSeconds + traceSeconds so the in-container timeouts answer first
  killGraceMs: 10 * 1000,
  containerMemory: "512m",
  containerPids: 64,
  containerCpus: "1",
  containerOpenFiles: 256,
  containerFileSizeBytes: 16 * 1024 * 1024, // per file; /out is 48m, so one noisy file cannot starve the trace
  containerTmpSize: "64m",
  containerOutSize: "48m",
});

module.exports = { LIMITS };
