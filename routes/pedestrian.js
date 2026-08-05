const express = require("express");
const router = express.Router();
const supabase = require("../supabaseClient");

router.get("/", async (req, res) => {
  const { data, error } = await supabase
    .from("pedestrian_counts")
    .select("*")
    .order("id", { ascending: true });

  if (error) {
    return res.status(500).json(error);
  }

  // Add congestion logic
  const result = data.map(item => ({
    ...item,
    avoid: item.crowd_level === "HIGH"
  }));

  res.json(result);
});

module.exports = router;