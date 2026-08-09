const axios = require("axios");

const JUDGE0_URL =
  process.env.JUDGE0_URL ||
  "https://ce.judge0.com/submissions?base64_encoded=false&wait=true";

const CPP_LANGUAGE_ID = 54;

async function executeCppCode(code) {
  if (!code || typeof code !== "string") {
    throw new Error("C++ code is required");
  }

  const response = await axios.post(
    JUDGE0_URL,
    {
      language_id: CPP_LANGUAGE_ID,
      source_code: code,
      cpu_time_limit: 20,
      wall_time_limit: 30,
      memory_limit: 512000,
    },
    {
      headers: {
        "Content-Type": "application/json",
      },
    },
  );

  return response.data;
}

module.exports = {
  executeCppCode,
};
