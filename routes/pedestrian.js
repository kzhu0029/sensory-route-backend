const express = require("express");
const router = express.Router();
const supabase = require("../supabaseClient");

function getWorstCrowdLevel(levels) {
  if (levels.includes("HIGH")) return "HIGH";
  if (levels.includes("MEDIUM")) return "MEDIUM";
  return "LOW";
}

router.get("/", async (req, res) => {
  const { data, error } = await supabase
    .from("pedestrian_counts")
    .select("*")
    .not("sensor_id", "is", null)
    .not("sensing_datetime", "is", null)
    .order("sensing_datetime", { ascending: false });

  if (error) {
    return res.status(500).json(error);
  }

  const latestBySensor = new Map();

  for (const item of data) {
    if (!latestBySensor.has(item.sensor_id)) {
      latestBySensor.set(item.sensor_id, item);
    }
  }

  const groupedBySegment = new Map();

  for (const item of latestBySensor.values()) {
    const existing = groupedBySegment.get(item.segment_id) || [];

    groupedBySegment.set(item.segment_id, [...existing, item]);
  }

  const result = Array.from(groupedBySegment.entries()).map(
    ([segmentId, items]) => {
      const pedestrianCount = Math.max(
        ...items.map((item) => item.pedestrian_count || 0)
      );

      const crowdLevel = getWorstCrowdLevel(
        items.map((item) => item.crowd_level)
      );

      const latestDatetime = items
        .map((item) => item.sensing_datetime)
        .sort()
        .reverse()[0];

      return {
        segment_id: Number(segmentId),
        pedestrian_count: pedestrianCount,
        crowd_level: crowdLevel,
        avoid: crowdLevel === "HIGH",
        sensors: items.map((item) => ({
          sensor_id: item.sensor_id,
          pedestrian_count: item.pedestrian_count,
          crowd_level: item.crowd_level,
          sensing_datetime: item.sensing_datetime,
        })),
        sensing_datetime: latestDatetime,
      };
    }
  );

  res.json(result);
});

module.exports = router;