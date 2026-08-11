const supabase = require("../supabaseClient");
const axios = require("axios");

const FRESHNESS_LIMIT_MINUTES = 360;
const SENSOR_LOCATIONS_URL =
  "https://data.melbourne.vic.gov.au/api/explore/v2.1/catalog/datasets/pedestrian-counting-system-sensor-locations/records";
const SENSOR_METADATA_CACHE_MS = 60 * 60 * 1000;

let sensorMetadataCache = {
  expiresAt: 0,
  byId: new Map(),
};

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

async function getSensorMetadata() {
  if (Date.now() < sensorMetadataCache.expiresAt) {
    return sensorMetadataCache.byId;
  }

  try {
    const response = await axios.get(SENSOR_LOCATIONS_URL, {
      params: { limit: 100, offset: 0 },
      timeout: 15000,
    });
    const byId = new Map();
    const results = response.data.results || [];
    const totalCount = response.data.total_count || results.length;

    for (let offset = results.length; offset < totalCount; offset += 100) {
      const nextResponse = await axios.get(SENSOR_LOCATIONS_URL, {
        params: { limit: 100, offset },
        timeout: 15000,
      });
      results.push(...(nextResponse.data.results || []));
    }

    for (const item of results) {
      byId.set(Number(item.location_id), {
        sensor_description: item.sensor_description || null,
        sensor_name: item.sensor_name || null,
      });
    }

    sensorMetadataCache = {
      expiresAt: Date.now() + SENSOR_METADATA_CACHE_MS,
      byId,
    };
  } catch (error) {
    console.error(
      "Sensor metadata lookup failed:",
      error.response?.data || error.message || error
    );
  }

  return sensorMetadataCache.byId;
}

function formatSensors(items, sensorMetadata) {
  return items.map((item) => ({
    sensor_id: item.sensor_id ?? item.location_id,
    sensor_description:
      sensorMetadata.get(Number(item.sensor_id ?? item.location_id))
        ?.sensor_description ?? null,
    sensor_name:
      sensorMetadata.get(Number(item.sensor_id ?? item.location_id))
        ?.sensor_name ?? null,
    pedestrian_count: item.pedestrian_count ?? null,
    crowd_level: item.crowd_level ?? null,
    sensing_datetime: item.sensing_datetime ?? null,
  }));
}

function buildUnknownSegment(
  segmentId,
  reason,
  items = [],
  dataRefreshedAt,
  sensorMetadata
) {
  const observationWindow = getObservationWindow(items);

  return {
    segment_id: segmentId,
    pedestrian_count: null,
    crowd_level: "UNKNOWN",
    avoid: false,
    sensors: formatSensors(items, sensorMetadata),
    sensing_datetime: getLatestDatetime(items),
    observed_at: getLatestDatetime(items),
    updated_at: dataRefreshedAt,
    ...observationWindow,
    data_refreshed_at: dataRefreshedAt,
    is_unknown: true,
    unknown_reason: reason,
  };
}

async function getPedestrianSegments() {
  const dataRefreshedAt = new Date().toISOString();
  const sensorMetadata = await getSensorMetadata();

  const { data: mappings, error: mappingsError } = await supabase
    .from("sensor_segment_mapping")
    .select("location_id, segment_id")
    .eq("mapping_status", "Approved");

  if (mappingsError) throw mappingsError;

  const segmentIds = [
    ...new Set((mappings || []).map((item) => Number(item.segment_id))),
  ].sort((a, b) => a - b);

  const { data: counts, error: countsError } = await supabase
    .from("pedestrian_counts")
    .select("*")
    .not("sensor_id", "is", null)
    .not("sensing_datetime", "is", null)
    .order("sensing_datetime", { ascending: false });

  if (countsError) throw countsError;

  const latestBySensor = new Map();

  for (const item of counts || []) {
    if (!latestBySensor.has(item.sensor_id)) {
      latestBySensor.set(item.sensor_id, item);
    }
  }

  const groupedBySegment = new Map();
  const staleGroupedBySegment = new Map();
  const invalidGroupedBySegment = new Map();

  for (const item of latestBySensor.values()) {
    const segmentId = Number(item.segment_id);

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

  return segmentIds.map((segmentId) => {
    const segmentMappings = (mappings || []).filter(
      (item) => Number(item.segment_id) === segmentId
    );
    const items = groupedBySegment.get(segmentId) || [];

    if (items.length === 0) {
      const staleItems = staleGroupedBySegment.get(segmentId) || [];
      const invalidItems = invalidGroupedBySegment.get(segmentId) || [];

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
        unknownItems.length > 0 ? unknownItems : segmentMappings,
        dataRefreshedAt,
        sensorMetadata
      );
    }

    const pedestrianCount = Math.max(
      ...items.map((item) => item.pedestrian_count || 0)
    );

    const crowdLevel = getWorstCrowdLevel(
      items.map((item) => item.crowd_level)
    );
    const observationWindow = getObservationWindow(items);
    const observedAt = getLatestDatetime(items);

    return {
      segment_id: segmentId,
      pedestrian_count: pedestrianCount,
      crowd_level: crowdLevel,
      avoid: crowdLevel === "HIGH",
      sensors: formatSensors(items, sensorMetadata),
      sensing_datetime: observedAt,
      observed_at: observedAt,
      updated_at: dataRefreshedAt,
      ...observationWindow,
      data_refreshed_at: dataRefreshedAt,
      is_unknown: false,
      unknown_reason: null,
    };
  });
}

module.exports = {
  getPedestrianSegments,
};
