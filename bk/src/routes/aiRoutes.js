const express = require("express");
const { createAiController } = require("../controllers/aiController");
const { getAiRuntime } = require("../services/ai/runtime");

/** @param {ReturnType<typeof createAiController>} controller */
function createAiRoutes(controller) {
  const router = express.Router();
  router.get("/status", controller.status);
  router.post("/ask", controller.ask);
  return router;
}

module.exports = createAiRoutes(createAiController({ getRuntime: getAiRuntime }));
module.exports.createAiRoutes = createAiRoutes;
