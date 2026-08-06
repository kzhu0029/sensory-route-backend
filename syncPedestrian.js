const axios = require("axios");
const supabase = require("./supabaseClient");

const OPEN_DATA_URL =
  "https://data.melbourne.vic.gov.au/api/explore/v2.1/catalog/datasets/pedestrian-counting-system-past-hour-counts-per-minute/records";

const sensorToSegment = {
  36: 2,
  48: 2,
  86: 2,
  138: 2,
};

function getCrowdLevel(count) {
  if (count < 50) return "LOW";
  if (count < 150) return "MEDIUM";
  return "HIGH";
}

async function syncPedestrianData() {
  try {
    const response = await axios.get(OPEN_DATA_URL, {
      params: {
        where: "location_id in (36,48,86,138)",
        limit: 100,
        order_by: "sensing_datetime desc",
      },
      timeout: 15000,
    });

    const records = response.data.results;

    const matchingRecords = records.filter(
      (record) => sensorToSegment[record.location_id]
    );

    if (matchingRecords.length === 0) {
      console.log("No mapped sensor records found.");
      return;
    }

    const latestBySensor = new Map();

    for (const record of matchingRecords) {
      const existing = latestBySensor.get(record.location_id);

      if (
        !existing ||
        new Date(record.sensing_datetime) > new Date(existing.sensing_datetime)
      ) {
        latestBySensor.set(record.location_id, record);
      }
    }

    const rows = Array.from(latestBySensor.values()).map((record) => {
      const count = record.total_of_directions ?? 0;

      return {
        segment_id: sensorToSegment[record.location_id],
        sensor_id: record.location_id,
        sensing_datetime: record.sensing_datetime,
        pedestrian_count: count,
        crowd_level: getCrowdLevel(count),
      };
    });

    const { data, error } = await supabase
      .from("pedestrian_counts")
      .upsert(rows, {
        onConflict: "sensor_id,sensing_datetime",
      })
      .select();

    if (error) {
      throw error;
    }

    console.log("Upserted rows:", data);
  } catch (error) {
    console.error(
      "Sync failed:",
      error.response?.data || error.message || error
    );
  }
}

module.exports = syncPedestrianData;

if (require.main === module) {
  syncPedestrianData();
}