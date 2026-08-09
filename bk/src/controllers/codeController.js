const { executeCppCode } = require("../services/judge0Service");

async function runCode(req, res) {
  try {
    const { code } = req.body;

    if (!code || typeof code !== "string") {
      return res.status(400).json({
        error: "C++ code is required",
      });
    }

    const result = await executeCppCode(code);

    return res.status(200).json({
      stdout: result.stdout || null,
      stderr: result.stderr || null,
      compile_output: result.compile_output || null,
      status: result.status?.description || "Unknown",
      time: result.time || null,
      memory: result.memory || null,
    });
  } catch (error) {
    console.error("Code execution error:", error.message);

    return res.status(500).json({
      error: "Failed to execute C++ code",
      details: error.message,
    });
  }
}

module.exports = {
  runCode,
};
