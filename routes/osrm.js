const express = require("express");

const router = express.Router();

const OSRM_BASE_URL =
  process.env.OSRM_BASE_URL || "https://router.project-osrm.org";
const ALLOWED_PROFILES = new Set(["foot", "bike", "car", "driving"]);

function numberFrom(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parsePosition(query, latKey, lngKey) {
  const lat = numberFrom(query[latKey]);
  const lng = numberFrom(query[lngKey]);

  if (lat === null || lng === null) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;

  return { lat, lng };
}

function normaliseProfile(value) {
  const profile = String(value || "foot").toLowerCase();

  if (profile === "walking") return "foot";
  if (profile === "cycling") return "bike";
  if (profile === "driving") return "driving";

  return ALLOWED_PROFILES.has(profile) ? profile : "foot";
}

function toCoordinatesParam(origin, destination) {
  return `${origin.lng},${origin.lat};${destination.lng},${destination.lat}`;
}

function normaliseSteps(legs = []) {
  return legs.flatMap((leg) =>
    (leg.steps || []).map((step) => ({
      name: step.name || null,
      mode: step.mode || null,
      driving_side: step.driving_side || null,
      distance_m: step.distance ?? null,
      duration_s: step.duration ?? null,
      maneuver: step.maneuver
        ? {
            type: step.maneuver.type || null,
            modifier: step.maneuver.modifier || null,
            location: Array.isArray(step.maneuver.location)
              ? [step.maneuver.location[1], step.maneuver.location[0]]
              : null,
          }
        : null,
      geometry:
        step.geometry?.type === "LineString"
          ? step.geometry.coordinates.map(([lng, lat]) => [lat, lng])
          : [],
    }))
  );
}

function normaliseRoute(route, index) {
  const coordinatesLatLng =
    route.geometry?.type === "LineString"
      ? route.geometry.coordinates.map(([lng, lat]) => [lat, lng])
      : [];

  return {
    id: `osrm-route-${index + 1}`,
    distance_m: route.distance ?? null,
    duration_s: route.duration ?? null,
    coordinates: coordinatesLatLng,
    geometry: route.geometry || null,
    steps: normaliseSteps(route.legs),
  };
}

router.get("/route", async (req, res) => {
  try {
    const origin =
      parsePosition(req.query, "originLat", "originLng") ||
      parsePosition(req.query, "startLat", "startLng");
    const destination =
      parsePosition(req.query, "destinationLat", "destinationLng") ||
      parsePosition(req.query, "destLat", "destLng");

    if (!origin || !destination) {
      return res.status(400).json({
        error:
          "originLat/originLng and destinationLat/destinationLng are required.",
      });
    }

    const profile = normaliseProfile(req.query.profile);
    const coordinates = toCoordinatesParam(origin, destination);
    const url = new URL(`/route/v1/${profile}/${coordinates}`, OSRM_BASE_URL);
    url.searchParams.set("overview", "full");
    url.searchParams.set("geometries", "geojson");
    url.searchParams.set("steps", "true");
    url.searchParams.set(
      "alternatives",
      req.query.alternatives === "true" ? "true" : "false"
    );

    const response = await fetch(url, {
      headers: { Accept: "application/json" },
    });
    const payload = await response.json();

    if (!response.ok || payload.code !== "Ok" || !payload.routes?.length) {
      return res.status(response.ok ? 502 : response.status).json({
        error: "OSRM route request failed",
        code: payload.code || null,
        message: payload.message || null,
      });
    }

    const routes = payload.routes.map(normaliseRoute);
    const route = routes[0];

    res.json({
      provider: "OSRM",
      profile,
      distance_m: route.distance_m,
      duration_s: route.duration_s,
      coordinates: route.coordinates,
      geometry: route.geometry,
      waypoints: (payload.waypoints || []).map((waypoint) => ({
        name: waypoint.name || null,
        location: Array.isArray(waypoint.location)
          ? [waypoint.location[1], waypoint.location[0]]
          : null,
        distance_m: waypoint.distance ?? null,
      })),
      steps: route.steps,
      routes,
      raw_code: payload.code,
    });
  } catch (error) {
    console.error("OSRM API failed:", error);
    res.status(500).json({
      error: "Failed to load OSRM route",
    });
  }
});

module.exports = router;
