const express = require("express");
const router = express.Router();
const supabase = require("../supabaseClient");

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

function distanceInMetres(first, second) {
  const toRadians = (value) => (value * Math.PI) / 180;
  const [firstLat, firstLng] = first;
  const [secondLat, secondLng] = second;
  const deltaLat = toRadians(secondLat - firstLat);
  const deltaLng = toRadians(secondLng - firstLng);
  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(toRadians(firstLat)) *
      Math.cos(toRadians(secondLat)) *
      Math.sin(deltaLng / 2) ** 2;

  return Math.round(
    6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  );
}

function normaliseRefuge(row, index) {
  const name = String(row.name || row.location_name || "").trim();
  const latitude = numberFrom(row.latitude ?? row.lat);
  const longitude = numberFrom(row.longitude ?? row.lng ?? row.lon);

  if (!name || latitude === null || longitude === null) return null;

  return {
    id: row.id ?? `refuge-${index + 1}`,
    name,
    type: normaliseType(row.type ?? row.category),
    latitude,
    longitude,
    source_theme: row.source_theme ?? null,
    source_sub_theme: row.source_sub_theme ?? null,
  };
}

function dedupeRefuges(refuges) {
  const seen = new Set();

  return refuges.filter((refuge) => {
    const key = [
      refuge.name.toLowerCase(),
      refuge.type.toLowerCase(),
      refuge.latitude.toFixed(6),
      refuge.longitude.toFixed(6),
    ].join("|");

    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parseTypes(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

router.get("/", async (req, res) => {
  const { data, error } = await supabase.from("refuge_locations").select("*");

  if (error) {
    return res.status(500).json(error);
  }

  const originLat = numberFrom(req.query.lat ?? req.query.originLat);
  const originLng = numberFrom(req.query.lng ?? req.query.originLng);
  const typeFilters = parseTypes(req.query.type ?? req.query.types);
  const origin =
    originLat !== null && originLng !== null ? [originLat, originLng] : null;

  let refuges = dedupeRefuges(
    (data || []).map(normaliseRefuge).filter(Boolean)
  );

  if (typeFilters.length) {
    refuges = refuges.filter((refuge) =>
      typeFilters.includes(refuge.type.toLowerCase())
    );
  }

  if (!origin) {
    return res.json(
      refuges.sort((first, second) => first.name.localeCompare(second.name))
    );
  }

  const withDistance = refuges
    .map((refuge) => {
      const distanceM = distanceInMetres(origin, [
        refuge.latitude,
        refuge.longitude,
      ]);

      return {
        ...refuge,
        distance_m: distanceM,
        distance: distanceM,
      };
    })
    .sort((first, second) => first.distance_m - second.distance_m);

  const withinOneKm = withDistance.filter((refuge) => refuge.distance_m <= 1000);
  const searchRadiusKm = withinOneKm.length ? 1 : 2;
  const result = withDistance
    .filter((refuge) => refuge.distance_m <= searchRadiusKm * 1000)
    .map((refuge) => ({
      ...refuge,
      search_radius_km: searchRadiusKm,
    }));

  res.json(result);
});

module.exports = router;
