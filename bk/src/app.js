const express = require("express");
const cors = require("cors");
const codeRoutes = require("./routes/codeRoutes");

const app = express();
app.use(cors());
app.use(express.json());

app.use("/api/code", codeRoutes);

module.exports = app;
