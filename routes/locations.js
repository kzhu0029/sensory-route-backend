const express = require("express");
const axios = require("axios");
const supabase = require("../supabaseClient");

const router = express.Router();

const SENSOR_LOCATIONS_URL =
  "https://data.melbourne.vic.gov.au/api/explore/v2.1/catalog/datasets/pedestrian-counting-system-sensor-locations/records";
const CACHE_MS = 60 * 60 * 1000;

let cache = {
  expiresAt: 0,
  locations: [],
};

function numberFrom(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normaliseType(value) {
  const type = String(value || "").trim();
  const lowerType = type.toLowerCase();

  if (lowerType.includes("park")) return "Park";
  if (lowerType.includes("librar")) return "Library";
  if (type) return type;
  return "Potential Quiet Public Space";
}

function makeLocation({ id, label, secondary, latitude, longitude, source }) {
  const lat = numberFrom(latitude);
  const lng = numberFrom(longitude);
  const name = String(label || "").trim();

  if (!name || lat === null || lng === null) return null;

  return {
    id,
    label: name,
    secondary: secondary || "Melbourne CBD",
    position: [lat, lng],
    source,
  };
}

function dedupeLocations(locations) {
  const seen = new Set();

  return locations.filter((location) => {
    const key = [
      location.label.toLowerCase(),
      location.position[0].toFixed(5),
      location.position[1].toFixed(5),
    ].join("|");

    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function getRefugeLocations() {
  const { data, error } = await supabase.from("refuge_locations").select("*");

  if (error) throw error;

  return (data || [])
    .map((row, index) =>
      makeLocation({
        id: `refuge-${row.id ?? index + 1}`,
        label: row.name || row.location_name,
        secondary: `${normaliseType(row.type ?? row.category)} · ${
          row.source_sub_theme || row.source_theme || "Potential quiet public space"
        }`,
        latitude: row.latitude ?? row.lat,
        longitude: row.longitude ?? row.lng ?? row.lon,
        source: "refuge",
      })
    )
    .filter(Boolean);
}

async function getSensorLocations() {
  const firstResponse = await axios.get(SENSOR_LOCATIONS_URL, {
    params: { limit: 100, offset: 0 },
    timeout: 15000,
  });
  const results = firstResponse.data.results || [];
  const totalCount = firstResponse.data.total_count || results.length;

  for (let offset = results.length; offset < totalCount; offset += 100) {
    const response = await axios.get(SENSOR_LOCATIONS_URL, {
      params: { limit: 100, offset },
      timeout: 15000,
    });
    results.push(...(response.data.results || []));
  }

  return results
    .filter((row) => row.status === "A")
    .map((row) =>
      makeLocation({
        id: `sensor-${row.location_id}`,
        label: row.sensor_description,
        secondary: `Pedestrian sensor · ${row.location_type || "Outdoor"}`,
        latitude: row.latitude,
        longitude: row.longitude,
        source: "sensor",
      })
    )
    .filter(Boolean);
}

async function getLocations() {
  if (Date.now() < cache.expiresAt) {
    return cache.locations;
  }

  const [refugeLocations, sensorLocations] = await Promise.all([
    getRefugeLocations(),
    getSensorLocations(),
  ]);

  cache = {
    expiresAt: Date.now() + CACHE_MS,
    locations: dedupeLocations([...sensorLocations, ...refugeLocations]).sort(
      (first, second) => first.label.localeCompare(second.label)
    ),
  };

  return cache.locations;
}

router.get("/search", async (req, res) => {
  try {
    const query = String(req.query.q || "").trim().toLowerCase();
    const limit = Math.min(Number(req.query.limit) || 8, 20);
    const locations = await getLocations();

    if (!query) {
      return res.json(locations.slice(0, limit));
    }

    const matches = locations
      .map((location) => {
        const label = location.label.toLowerCase();
        const secondary = location.secondary.toLowerCase();
        const exactScore = label === query ? 0 : 10;
        const startsScore = label.startsWith(query) ? 0 : 5;
        const includesScore =
          label.includes(query) || secondary.includes(query) ? 0 : 100;

        return {
          location,
          score: exactScore + startsScore + includesScore + label.length / 1000,
        };
      })
      .filter((item) => item.score < 100)
      .sort((first, second) => first.score - second.score)
      .slice(0, limit)
      .map((item) => item.location);

    res.json(matches);
  } catch (error) {
    console.error("Location search failed:", error);
    res.status(500).json({
      error: "Failed to search locations",
    });
  }
});

module.exports = router;
