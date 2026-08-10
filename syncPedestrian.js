const axios = require("axios");
const supabase = require("./supabaseClient");

const OPEN_DATA_URL =
  "https://data.melbourne.vic.gov.au/api/explore/v2.1/catalog/datasets/pedestrian-counting-system-past-hour-counts-per-minute/records";

// ---------------------------------------------------------
// 1. Convert pedestrian count into crowd level
// ---------------------------------------------------------
function getCrowdLevel(count) {
  if (count < 50) return "LOW";
  if (count < 150) return "MEDIUM";
  return "HIGH";
}

// ---------------------------------------------------------
// 2. Fetch the latest available record for each mapped sensor
// ---------------------------------------------------------
async function fetchLatestPedestrianRecords(sensorIds) {
  const latestRecords = [];

  console.log(
    `Fetching latest data for ${sensorIds.length} mapped sensors...`
  );

  for (const sensorId of sensorIds) {
    try {
      const response = await axios.get(OPEN_DATA_URL, {
        params: {
          where: `location_id = ${sensorId}`,
          limit: 1,
          order_by: "sensing_datetime desc",
        },
        timeout: 15000,
      });

      const records = response.data.results || [];

      if (records.length > 0) {
        latestRecords.push(records[0]);
      }
    } catch (error) {
      console.error(
        `Failed to fetch sensor ${sensorId}:`,
        error.response?.data || error.message || error
      );
    }
  }

  return latestRecords;
}

// ---------------------------------------------------------
// 3. Main pedestrian data sync
// ---------------------------------------------------------
async function syncPedestrianData() {
  try {
    // -----------------------------------------------------
    // Step 1: Read approved sensor -> segment mappings
    // -----------------------------------------------------
    const { data: mappings, error: mappingError } =
      await supabase
        .from("sensor_segment_mapping")
        .select("location_id, segment_id")
        .eq("mapping_status", "Approved");

    if (mappingError) {
      throw mappingError;
    }

    if (!mappings || mappings.length === 0) {
      console.log("No approved sensor mappings found.");
      return;
    }

    // -----------------------------------------------------
    // Step 2: Build sensor -> segment lookup
    // -----------------------------------------------------
    const sensorToSegment = {};

    for (const mapping of mappings) {
      sensorToSegment[mapping.location_id] =
        mapping.segment_id;
    }

    const sensorIds = [
      ...new Set(
        mappings.map((mapping) => mapping.location_id)
      ),
    ];

    console.log(
      `Loaded ${sensorIds.length} approved sensor mappings.`
    );

    // -----------------------------------------------------
    // Step 3: Fetch latest Open Data record
    // for each mapped sensor
    // -----------------------------------------------------
    const records =
      await fetchLatestPedestrianRecords(sensorIds);

    console.log(
      `Fetched latest Open Data records for ${records.length} sensors.`
    );

    // -----------------------------------------------------
    // Step 4: Validate Open Data records
    // -----------------------------------------------------
    const validRecords = records.filter((record) => {
      const hasMappedSensor =
        sensorToSegment[record.location_id] !== undefined;

      const hasValidTime =
        record.sensing_datetime &&
        !Number.isNaN(
          new Date(record.sensing_datetime).getTime()
        );

      const count = record.total_of_directions;

      const hasValidCount =
        typeof count === "number" &&
        Number.isFinite(count) &&
        count >= 0;

      return (
        hasMappedSensor &&
        hasValidTime &&
        hasValidCount
      );
    });

    console.log(
      `Found ${validRecords.length} valid Open Data records.`
    );

    // -----------------------------------------------------
    // Step 5: Keep only latest record for each sensor
    // -----------------------------------------------------
    const latestBySensor = new Map();

    for (const record of validRecords) {
      const existing =
        latestBySensor.get(record.location_id);

      if (
        !existing ||
        new Date(record.sensing_datetime) >
          new Date(existing.sensing_datetime)
      ) {
        latestBySensor.set(
          record.location_id,
          record
        );
      }
    }

    console.log(
      `Found latest data for ${latestBySensor.size} sensors.`
    );

    // -----------------------------------------------------
    // Step 6: Convert Open Data records
    // into our pedestrian_counts format
    // -----------------------------------------------------
    const rows = Array.from(
      latestBySensor.values()
    ).map((record) => {
      const count = record.total_of_directions;

      return {
        segment_id:
          sensorToSegment[record.location_id],

        sensor_id:
          record.location_id,

        sensing_datetime:
          record.sensing_datetime,

        pedestrian_count:
          count,

        crowd_level:
          getCrowdLevel(count),
      };
    });

    // -----------------------------------------------------
    // Step 7: Stop if there is nothing to save
    // -----------------------------------------------------
    if (rows.length === 0) {
      console.log("No rows available to save.");
      return;
    }

    // -----------------------------------------------------
    // Step 8: Save latest records to Supabase
    // -----------------------------------------------------
    const { data, error } = await supabase
      .from("pedestrian_counts")
      .upsert(rows, {
        onConflict:
          "sensor_id,sensing_datetime",
      })
      .select();

    if (error) {
      throw error;
    }

    // -----------------------------------------------------
    // Step 9: Success output
    // -----------------------------------------------------
    console.log(
      `Upserted ${data.length} rows.`
    );

    console.log(
      "Pedestrian sync completed successfully."
    );
  } catch (error) {
    console.error(
      "Sync failed:",
      error.response?.data ||
        error.message ||
        error
    );
  }
}

// ---------------------------------------------------------
// Export for server.js or other files
// ---------------------------------------------------------
module.exports = syncPedestrianData;

// ---------------------------------------------------------
// Run directly:
// node syncPedestrian.js
// ---------------------------------------------------------
if (require.main === module) {
  syncPedestrianData();
}
