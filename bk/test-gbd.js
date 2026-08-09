const { spawn } = require("child_process");

const gdb = spawn("gdb", ["--interpreter=mi2", ".\\main.exe"]);

gdb.stdout.on("data", (data) => {
  console.log("GDB:");
  console.log(data.toString());
});

gdb.stderr.on("data", (data) => {
  console.log("GDB ERROR:");
  console.log(data.toString());
});

gdb.on("close", (code) => {
  console.log(`GDB exited with code ${code}`);
});

function sendCommand(command) {
  console.log(`\n>>> ${command}`);
  gdb.stdin.write(`${command}\n`);
}

// Set breakpoint
setTimeout(() => {
  sendCommand("-break-insert main");
}, 1000);

// Start program
setTimeout(() => {
  sendCommand("-exec-run");
}, 2000);

// Get local variables
setTimeout(() => {
  sendCommand("-stack-list-locals 1");
}, 4000);

// Step to next source line
setTimeout(() => {
  sendCommand("-exec-next");
}, 5000);

// Get variables again
setTimeout(() => {
  sendCommand("-stack-list-locals 1");
}, 7000);
