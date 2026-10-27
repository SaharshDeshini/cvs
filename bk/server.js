require("dotenv").config();
const app = require("./src/app");

const PORT = process.env.PORT || 5000;
// This server runs user code (in Docker) and has no login, so it listens on this computer only. HOST=0.0.0.0 opts in to
// other devices; `npm start -- --share` does that and prints a warning.
const HOST = process.env.HOST || "127.0.0.1";

app.listen(PORT, HOST, () => {
  console.log(`Server is running on ${HOST}:${PORT}`);
});
