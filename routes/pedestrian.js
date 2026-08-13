const express = require("express");
const router = express.Router();
const { getPedestrianSegments } = require("../services/pedestrianSegments");

// Returns segment-based pedestrian activity data for the frontend. The service
// handles sensor mapping, freshness checks, Unknown reasons, and worst-level
// aggregation before this route sends JSON.
router.get("/", async (req, res) => {
  try {
    res.json(await getPedestrianSegments());
  } catch (error) {
    console.error("Pedestrian API failed:", error);
    res.status(500).json({
      error: "Failed to load pedestrian data",
    });
  }
});

module.exports = router;
