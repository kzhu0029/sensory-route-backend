const express = require("express");
const router = express.Router();
const supabase = require("../supabaseClient");

const ACTIVITY_RANK = {
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  UNKNOWN: 4,
};

function normaliseMaximumActivity(value) {
  const level = String(value || "MEDIUM").toUpperCase();

  return ["LOW", "MEDIUM", "HIGH"].includes(level) ? level : "MEDIUM";
}

function exceedsMaximumActivity(crowdLevel, maximumActivityLevel) {
  if (crowdLevel === "UNKNOWN") return false;

  return ACTIVITY_RANK[crowdLevel] > ACTIVITY_RANK[maximumActivityLevel];
}

function scoreRouteOption(route, pedestrian, maximumActivityLevel) {
  const crowdLevel = pedestrian?.crowd_level || "UNKNOWN";
  const pedestrianCount = pedestrian?.pedestrian_count;
  const accessible = route.accessible ?? true;
  const isUnknown = crowdLevel === "UNKNOWN";
  const exceedsPreference = exceedsMaximumActivity(
    crowdLevel,
    maximumActivityLevel
  );

  let score = 0;

  if (!accessible) score += 300;
  if (isUnknown) score += 200;
  if (exceedsPreference) score += 500;

  score += (ACTIVITY_RANK[crowdLevel] || ACTIVITY_RANK.UNKNOWN) * 30;
  score += Number.isFinite(Number(pedestrianCount))
    ? Number(pedestrianCount) / 10
    : 25;

  return score;
}

function buildWarnings(route, pedestrian, maximumActivityLevel) {
  const warnings = [];
  const crowdLevel = pedestrian?.crowd_level || "UNKNOWN";
  const accessible = route.accessible ?? true;

  if (!accessible) {
    warnings.push("Not accessible");
  }

  if (crowdLevel === "UNKNOWN") {
    warnings.push(pedestrian?.unknown_reason || "Unknown pedestrian data");
  }

  if (exceedsMaximumActivity(crowdLevel, maximumActivityLevel)) {
    warnings.push(`Exceeds ${maximumActivityLevel} activity preference`);
  }

  return warnings;
}

router.get("/", async (req, res) => {
  try {
    const maximumActivityLevel = normaliseMaximumActivity(
      req.query.maxActivity
    );

    const { data: routes, error: routesError } = await supabase
      .from("route_segments")
      .select("*")
      .order("id", { ascending: true });

    if (routesError) {
      return res.status(500).json(routesError);
    }

    const { data: pedestrianRows, error: pedestrianError } = await supabase
      .from("pedestrian_counts")
      .select("*")
      .not("segment_id", "is", null)
      .not("sensing_datetime", "is", null)
      .order("sensing_datetime", { ascending: false });

    if (pedestrianError) {
      return res.status(500).json(pedestrianError);
    }

    const latestBySegment = new Map();

    for (const row of pedestrianRows || []) {
      const segmentId = Number(row.segment_id);

      if (!latestBySegment.has(segmentId)) {
        latestBySegment.set(segmentId, row);
      }
    }

    const options = (routes || [])
      .filter((route) => latestBySegment.has(Number(route.id)))
      .map((route) => {
        const pedestrian = latestBySegment.get(Number(route.id));
        const crowdLevel = pedestrian?.crowd_level || "UNKNOWN";
        const warnings = buildWarnings(route, pedestrian, maximumActivityLevel);
        const score = scoreRouteOption(route, pedestrian, maximumActivityLevel);
        const accessible = route.accessible ?? true;

        return {
          segment_id: route.id,
          segment_name: route.segment_name,
          start_location: route.start_location,
          end_location: route.end_location,
          accessible,
          pedestrian_count: pedestrian?.pedestrian_count ?? null,
          crowd_level: crowdLevel,
          avoid: crowdLevel === "HIGH",
          is_unknown: crowdLevel === "UNKNOWN",
          unknown_reason:
            crowdLevel === "UNKNOWN"
              ? pedestrian?.unknown_reason || "Missing Data"
              : null,
          sensing_datetime: pedestrian?.sensing_datetime ?? null,
          score,
          warnings,
          suitability:
            warnings.length === 0 ? "RECOMMENDED" : "USE_WITH_CAUTION",
        };
      })
      .sort((first, second) => first.score - second.score)
      .slice(0, 10);

    const recommendedRoute = options[0] || null;

    res.json({
      settings: {
        maximum_activity_level: maximumActivityLevel,
      },
      recommended_route: recommendedRoute,
      route_options: options.map((option) => ({
        ...option,
        is_recommended:
          recommendedRoute?.segment_id === option.segment_id,
      })),
      message: recommendedRoute
        ? "Recommended route is selected by accessibility, pedestrian activity, and unknown-data risk."
        : "No route options are available.",
    });
  } catch (error) {
    console.error("Recommendation API failed:", error);
    res.status(500).json({
      error: "Failed to build route recommendation",
    });
  }
});

module.exports = router;
