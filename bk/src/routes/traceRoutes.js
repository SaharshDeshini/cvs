const express = require("express");
const { createTrace } = require("../controllers/traceController");

const router = express.Router();

router.post("/", createTrace);

module.exports = router;
