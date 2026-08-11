const express = require("express");
const router = express.Router();
const { getPedestrianSegments } = require("../services/pedestrianSegments");

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
