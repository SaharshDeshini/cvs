// One command to run CVis: `npm start` (this machine only) or `npm start -- --share` (reachable from other devices).
// Installs missing dependencies, rebuilds the frontend when its source changed, checks Docker + the runner image,
// then starts the backend, which also serves the built frontend. Everything runs from this folder, nothing is deployed.
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const FE = path.join(ROOT, "fe");
const BK = path.join(ROOT, "bk");
const RUNNER_IMAGE = process.env.RUNNER_IMAGE || "cvis-runner:2";
const PORT = Number(process.env.PORT) || 5000;
const SHARE = process.argv.includes("--share");
const HOST = SHARE ? "0.0.0.0" : "127.0.0.1";
const DOCKER_TIMEOUT_MS = 20_000;
const PROBE_TIMEOUT_MS = 1_500;
const SOURCE_DIRS = ["src", "index.html", "package.json", "vite.config.js"];

const say = (message) => console.log(`[cvis] ${message}`);
const fail = (message) => {
  console.error(`[cvis] ${message}`);
  process.exit(1);
};

// Fixed command strings only (no user input), run through the shell so npm.cmd works on Windows.
function run(command, cwd) {
  const result = spawnSync(command, { cwd, stdio: "inherit", shell: true });
  if (result.status !== 0) fail(`"${command}" failed in ${path.relative(ROOT, cwd) || "."}`);
}

function newestMtime(target) {
  if (!fs.existsSync(target)) return 0;
  const stat = fs.statSync(target);
  if (!stat.isDirectory()) return stat.mtimeMs;
  return fs.readdirSync(target).reduce((newest, name) => Math.max(newest, newestMtime(path.join(target, name))), 0);
}

function installMissingDependencies() {
  for (const dir of [BK, FE]) {
    if (!fs.existsSync(path.join(dir, "node_modules"))) {
      say(`installing dependencies in ${path.basename(dir)}/ (first run only)`);
      run("npm install", dir);
    }
  }
}

function buildFrontendIfStale() {
  const built = newestMtime(path.join(FE, "dist", "index.html"));
  const source = Math.max(...SOURCE_DIRS.map((name) => newestMtime(path.join(FE, name))));
  if (built > source) return say("frontend is up to date");
  say("building the frontend");
  run("npm run build", FE);
}

const docker = (...args) => spawnSync("docker", args, { encoding: "utf8", timeout: DOCKER_TIMEOUT_MS });

function checkRunner() {
  if (docker("info").status !== 0) {
    return say("WARNING: Docker is not running. The page will load, but Run will say the runner is unavailable. Start Docker Desktop.");
  }
  if (docker("image", "inspect", RUNNER_IMAGE).status === 0) return say(`runner image ${RUNNER_IMAGE} is ready`);
  say(`building the runner image ${RUNNER_IMAGE} (first run only, a few minutes)`);
  const build = spawnSync("docker", ["build", "-t", RUNNER_IMAGE, "."], { cwd: path.join(BK, "runner"), stdio: "inherit" });
  if (build.status !== 0) fail(`building the runner image failed (docker build -t ${RUNNER_IMAGE} in bk/runner)`);
}

// Asks "does anything accept connections here?" instead of trying to bind: on Windows a bind to 127.0.0.1 succeeds even
// when another process already holds the wildcard address (0.0.0.0 / ::), which is exactly what a stale server looks like.
function isListening(host) {
  return new Promise((resolve) => {
    const socket = net.connect({ port: PORT, host });
    socket.setTimeout(PROBE_TIMEOUT_MS);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("timeout", () => { socket.destroy(); resolve(false); });
    socket.once("error", () => resolve(false));
  });
}

async function assertPortFree() {
  const taken = (await Promise.all(["127.0.0.1", "::1"].map(isListening))).some(Boolean);
  if (taken) fail(`port ${PORT} is already in use (an old CVis server?). Stop it, or pick another port: PORT=5001 npm start`);
}

function lanAddresses() {
  return Object.values(os.networkInterfaces()).flat().filter((entry) => entry && entry.family === "IPv4" && !entry.internal).map((entry) => entry.address);
}

function announce() {
  say(`ready:  http://127.0.0.1:${PORT}/`);
  if (!SHARE) return say("only this computer can reach it. For other devices (phone, laptop): npm start -- --share");
  for (const address of lanAddresses()) say(`        http://${address}:${PORT}/  (other devices, same network or Tailscale)`);
  say("there is no login: anyone who can reach this address can run C++ on this machine. Use it on a private network only.");
}

function startServer() {
  const server = spawn(process.execPath, ["server.js"], { cwd: BK, stdio: "inherit", env: { ...process.env, HOST, PORT: String(PORT) } });
  const stop = () => server.kill();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  server.on("exit", (code) => process.exit(code ?? 0));
}

async function main() {
  installMissingDependencies();
  buildFrontendIfStale();
  checkRunner();
  await assertPortFree();
  announce();
  startServer();
}

main().catch((error) => fail(error.message));
