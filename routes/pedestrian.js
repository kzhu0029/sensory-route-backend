const express = require("express");
const router = express.Router();
const supabase = require("../supabaseClient");

const FRESHNESS_LIMIT_MINUTES = 360;

function getWorstCrowdLevel(levels) {
  if (levels.includes("HIGH")) return "HIGH";
  if (levels.includes("MEDIUM")) return "MEDIUM";
  if (levels.includes("LOW")) return "LOW";
  return "UNKNOWN";
}

function isFresh(sensingDatetime) {
  if (!sensingDatetime) return false;

  const observedAt = new Date(sensingDatetime);

  if (Number.isNaN(observedAt.getTime())) return false;

  const ageMs = Date.now() - observedAt.getTime();
  const limitMs = FRESHNESS_LIMIT_MINUTES * 60 * 1000;

  return ageMs >= 0 && ageMs <= limitMs;
}

function getSortedDatetimes(items) {
  return items
    .map((item) => item.sensing_datetime)
    .filter(Boolean)
    .sort();
}

function getLatestDatetime(items) {
  const datetimes = getSortedDatetimes(items);
  return datetimes[datetimes.length - 1] || null;
}

function getObservationWindow(items) {
  const datetimes = getSortedDatetimes(items);

  return {
    observation_window_start: datetimes[0] || null,
    observation_window_end: datetimes[datetimes.length - 1] || null,
  };
}

function hasValidPedestrianRecord(item) {
  const count = item.pedestrian_count;
  const validLevels = ["LOW", "MEDIUM", "HIGH"];

  return (
    typeof count === "number" &&
    Number.isFinite(count) &&
    count >= 0 &&
    validLevels.includes(item.crowd_level)
  );
}

function formatSensors(items) {
  return items.map((item) => ({
    sensor_id: item.sensor_id,
    pedestrian_count: item.pedestrian_count,
    crowd_level: item.crowd_level,
    sensing_datetime: item.sensing_datetime,
  }));
}

function buildUnknownSegment(
  segmentId,
  reason,
  items = [],
  dataRefreshedAt
) {
  const observationWindow = getObservationWindow(items);

  return {
    segment_id: segmentId,
    pedestrian_count: null,
    crowd_level: "UNKNOWN",
    avoid: false,
    sensors: formatSensors(items),
    sensing_datetime: getLatestDatetime(items),
    ...observationWindow,
    data_refreshed_at: dataRefreshedAt,
    is_unknown: true,
    unknown_reason: reason,
  };
}

router.get("/", async (req, res) => {
  try {
    const dataRefreshedAt = new Date().toISOString();

    // 1. Get approved sensor → segment mappings
    const { data: mappings, error: mappingsError } = await supabase
      .from("sensor_segment_mapping")
      .select("location_id, segment_id")
      .eq("mapping_status", "Approved");

    if (mappingsError) {
      return res.status(500).json(mappingsError);
    }

    // Get unique real segment IDs
    const segmentIds = [
      ...new Set((mappings || []).map((item) => Number(item.segment_id))),
    ].sort((a, b) => a - b);

    // 2. Get pedestrian count records
    const { data: counts, error: countsError } = await supabase
      .from("pedestrian_counts")
      .select("*")
      .not("sensor_id", "is", null)
      .not("sensing_datetime", "is", null)
      .order("sensing_datetime", { ascending: false });

    if (countsError) {
      return res.status(500).json(countsError);
    }

    // 3. Keep latest record for each sensor
    const latestBySensor = new Map();

    for (const item of counts || []) {
      if (!latestBySensor.has(item.sensor_id)) {
        latestBySensor.set(item.sensor_id, item);
      }
    }

    // 4. Group fresh/stale records by segment
    const groupedBySegment = new Map();
    const staleGroupedBySegment = new Map();
    const invalidGroupedBySegment = new Map();

    for (const item of latestBySensor.values()) {
      const segmentId = Number(item.segment_id);

      // Ignore old demo segment IDs or anything not in approved mapping
      if (!segmentIds.includes(segmentId)) {
        continue;
      }

      let targetMap = groupedBySegment;

      if (!isFresh(item.sensing_datetime)) {
        targetMap = staleGroupedBySegment;
      } else if (!hasValidPedestrianRecord(item)) {
        targetMap = invalidGroupedBySegment;
      }

      const existing = targetMap.get(segmentId) || [];
      targetMap.set(segmentId, [...existing, item]);
    }

    // 5. Build response for real mapped segments
    const result = segmentIds.map((segmentId) => {
      const items = groupedBySegment.get(segmentId) || [];

      if (items.length === 0) {
        const staleItems =
          staleGroupedBySegment.get(segmentId) || [];
        const invalidItems =
          invalidGroupedBySegment.get(segmentId) || [];

        let reason = "Missing Data";
        let unknownItems = [];

        if (staleItems.length > 0) {
          reason = "Stale Data";
          unknownItems = staleItems;
        } else if (invalidItems.length > 0) {
          reason = "Invalid Data";
          unknownItems = invalidItems;
        }

        return buildUnknownSegment(
          segmentId,
          reason,
          unknownItems,
          dataRefreshedAt
        );
      }

      const pedestrianCount = Math.max(
        ...items.map((item) => item.pedestrian_count || 0)
      );

      const crowdLevel = getWorstCrowdLevel(
        items.map((item) => item.crowd_level)
      );
      const observationWindow = getObservationWindow(items);

      return {
        segment_id: segmentId,
        pedestrian_count: pedestrianCount,
        crowd_level: crowdLevel,
        avoid: crowdLevel === "HIGH",
        sensors: formatSensors(items),
        sensing_datetime: getLatestDatetime(items),
        ...observationWindow,
        data_refreshed_at: dataRefreshedAt,
        is_unknown: false,
        unknown_reason: null,
      };
    });

    res.json(result);
  } catch (error) {
    console.error("Pedestrian API failed:", error);
    res.status(500).json({
      error: "Failed to load pedestrian data",
    });
  }
});

module.exports = router;
