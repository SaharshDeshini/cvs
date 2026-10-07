const childProcess = require("child_process"); // used as a module object so tests can mock spawn/execFile
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { LIMITS } = require("../utils/limits");
const { parseFrames } = require("../utils/frames");

const RUNNER_IMAGE = process.env.RUNNER_IMAGE || "cvis-runner:2";
const FRAME_NAMES = new Set(["compile.txt", "compile.rc", "trace.jsonl", "stdout.txt", "stderr.txt"]);
const DOCKER_STDERR_CAP = 4096;
const DOCKER_DAEMON_DOWN_EXIT = 125;

// Clients only ever see these; the technical detail stays on RunnerError.detail for the server log.
const PUBLIC_MESSAGES = Object.freeze({
  BUSY: "Too many runs in progress; try again shortly",
  RUNNER_UNAVAILABLE: "The code runner is unavailable",
  RUNNER_FAILED: "The code runner failed to produce a result",
});

class RunnerError extends Error {
  constructor(code, detail = null) {
    super(PUBLIC_MESSAGES[code] || "Runner error");
    this.name = "RunnerError";
    this.code = code;
    this.detail = detail;
  }
}

let activeRuns = 0;

const toDockerPath = (hostPath) => hostPath.replace(/\\/g, "/");

function buildDockerArgs(name, srcDir) {
  return [
    "run", "--rm", "--name", name,
    "--network", "none", "--read-only",
    "--memory", LIMITS.containerMemory, "--memory-swap", LIMITS.containerMemory,
    "--pids-limit", String(LIMITS.containerPids),
    "--cpus", LIMITS.containerCpus,
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--tmpfs", `/tmp:rw,exec,nosuid,size=${LIMITS.containerTmpSize}`,
    "--tmpfs", `/out:rw,noexec,nosuid,size=${LIMITS.containerOutSize},mode=1777`,
    "--ulimit", "core=0",
    "--ulimit", `fsize=${LIMITS.containerFileSizeBytes}:${LIMITS.containerFileSizeBytes}`,
    "--ulimit", `nofile=${LIMITS.containerOpenFiles}:${LIMITS.containerOpenFiles}`,
    "-e", `MAX_STEPS=${LIMITS.maxSteps}`,
    "-e", `COMPILE_SECONDS=${LIMITS.compileSeconds}`,
    "-e", `TRACE_SECONDS=${LIMITS.traceSeconds}`,
    "-e", `MAX_TRACE_BYTES=${LIMITS.maxTraceBytes}`,
    "-e", `MAX_OUTPUT_BYTES=${LIMITS.maxOutputBytes}`,
    "-e", `MAX_COMPILE_OUTPUT_BYTES=${LIMITS.maxCompileOutputBytes}`,
    "--mount", `type=bind,src=${toDockerPath(srcDir)},dst=/src,readonly`,
    RUNNER_IMAGE,
  ];
}

/**
 * Runs docker without a shell and collects stdout (the result frames) under a hard cap.
 * Kills the container at the wall clock; if docker itself will not stop, gives up after a grace period so a
 * stuck daemon cannot hold a concurrency slot forever.
 */
function runDocker(args, name, { wallClockMs, killGraceMs }) {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const chunks = [];
    let received = 0;
    let overflow = false;
    let timedOut = false;
    let stderr = "";
    let graceTimer = null;
    const killContainer = () => childProcess.execFile("docker", ["kill", name], () => {});
    const wallTimer = setTimeout(() => {
      timedOut = true;
      killContainer();
      graceTimer = setTimeout(() => {
        child.kill("SIGKILL");
        childProcess.execFile("docker", ["rm", "-f", name], () => {});
        reject(new RunnerError("RUNNER_FAILED", `docker did not stop ${name} within ${killGraceMs} ms of the kill`));
      }, killGraceMs);
    }, wallClockMs);
    const clearTimers = () => {
      clearTimeout(wallTimer);
      clearTimeout(graceTimer);
    };
    child.stdout.on("data", (chunk) => {
      if (overflow) return;
      received += chunk.length;
      if (received > LIMITS.maxRunnerStdoutBytes) {
        overflow = true;
        killContainer();
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString().slice(0, Math.max(0, DOCKER_STDERR_CAP - stderr.length));
    });
    child.on("error", (err) => {
      clearTimers();
      reject(new RunnerError("RUNNER_UNAVAILABLE", `cannot start docker: ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimers();
      resolve({ code, timedOut, overflow, stdout: Buffer.concat(chunks), stderr });
    });
  });
}

function looksLikeDaemonDown(docker) {
  return docker.code === DOCKER_DAEMON_DOWN_EXIT || /cannot connect to the docker daemon|error during connect/i.test(docker.stderr);
}

/** Turns docker's stdout frames into the raw run result; throws RunnerError when there is no usable result. */
function interpretRun(docker) {
  if (docker.overflow) {
    throw new RunnerError("RUNNER_FAILED", `runner output exceeded ${LIMITS.maxRunnerStdoutBytes} bytes (forged stream?)`);
  }
  const frames = parseFrames(docker.stdout, FRAME_NAMES);
  const text = (name) => (frames.has(name) ? frames.get(name).text : null);
  const truncated = (name) => (frames.has(name) ? frames.get(name).truncated : false);
  const parsedExit = text("compile.rc") === null ? Number.NaN : Number.parseInt(text("compile.rc").trim(), 10);
  const compileExitCode = Number.isInteger(parsedExit) ? parsedExit : null;
  if (compileExitCode === null && !docker.timedOut) {
    const code = looksLikeDaemonDown(docker) ? "RUNNER_UNAVAILABLE" : "RUNNER_FAILED";
    throw new RunnerError(code, `no result frames (docker exit ${docker.code}): ${docker.stderr.trim()}`);
  }
  return {
    compileOutput: text("compile.txt"),
    compileExitCode,
    traceText: text("trace.jsonl"),
    traceTruncated: truncated("trace.jsonl"),
    stdout: text("stdout.txt"),
    stdoutTruncated: truncated("stdout.txt"),
    stderr: text("stderr.txt"),
    timedOut: docker.timedOut,
  };
}

async function removeWorkspace(root) {
  try {
    await fs.promises.rm(root, { recursive: true, force: true });
  } catch (err) {
    console.error("Workspace cleanup failed:", err.message); // never turn a finished run into an error
  }
}

/** Only the source (and stdin) go to the host temp dir, mounted read-only; results never come back through it. */
async function prepareWorkspace(code, stdin) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "cvis-"));
  try {
    if (root.includes(",")) {
      throw new RunnerError("RUNNER_FAILED", `temp path contains a comma, which breaks --mount: ${root}`);
    }
    await fs.promises.writeFile(path.join(root, "main.cpp"), code);
    if (stdin.length > 0) await fs.promises.writeFile(path.join(root, "stdin.txt"), stdin);
    return root;
  } catch (err) {
    await removeWorkspace(root);
    throw err;
  }
}

/**
 * Compiles and traces `code` inside the runner container.
 * @param {{ code: string, stdin: string }} request  already validated
 * @param {{ wallClockMs?: number, killGraceMs?: number }} [options]  overridable for tests
 * @returns {Promise<object>} raw outputs plus { timedOut }
 */
async function runTrace({ code, stdin }, options = {}) {
  if (activeRuns >= LIMITS.maxConcurrentRuns) throw new RunnerError("BUSY");
  activeRuns += 1;
  let root = null;
  try {
    const name = `cvis-${crypto.randomBytes(6).toString("hex")}`;
    root = await prepareWorkspace(code, stdin);
    const timing = { wallClockMs: LIMITS.wallClockMs, killGraceMs: LIMITS.killGraceMs, ...options };
    return interpretRun(await runDocker(buildDockerArgs(name, root), name, timing));
  } finally {
    activeRuns -= 1;
    if (root) await removeWorkspace(root);
  }
}

const getActiveRuns = () => activeRuns;

module.exports = { runTrace, buildDockerArgs, interpretRun, getActiveRuns, RunnerError };
