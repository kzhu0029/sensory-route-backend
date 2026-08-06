const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY
);

const SENSOR_LOCATIONS_URL =
  "https://data.melbourne.vic.gov.au/api/explore/v2.1/catalog/datasets/pedestrian-counting-system-sensor-locations/records";

const QUEEN_SENSOR_SEGMENT_MAP = {
  36: "queen-st-west",
  48: "qvm-queen-st-east",
  86: "queensberry-errol-south",
  138: "queens-bridge-enterprize-park",
};

async function fetchQueenSensors() {
  const { data } = await axios.get(SENSOR_LOCATIONS_URL, {
    params: {
      select:
        "location_id,sensor_description,sensor_name,installation_date,note,location_type,status,direction_1,direction_2,latitude,longitude,location",
      where: 'search("Queen")',
      limit: 100,
    },
    timeout: 15000,
  });

  return data.results
    .filter((row) => row.status === "A")
    .map((row) => ({
      sensor_id: row.location_id,
      location_id: row.location_id,
      segment_id: QUEEN_SENSOR_SEGMENT_MAP[row.location_id] || null,
      sensor_name: row.sensor_name,
      description: row.sensor_description,
      installation_date: row.installation_date,
      note: row.note,
      location_type: row.location_type,
      status: row.status,
      direction_1: row.direction_1,
      direction_2: row.direction_2,
      latitude: row.latitude,
      longitude: row.longitude,
      raw: row,
      updated_at: new Date().toISOString(),
    }))
    .filter((row) => row.segment_id);
}

async function syncQueenSensors() {
  try {
    const sensors = await fetchQueenSensors();

    if (!sensors.length) {
      console.warn("No Queen sensors found.");
      return;
    }

    const { error } = await supabase
      .from("pedestrian_sensors")
      .upsert(sensors, { onConflict: "sensor_id" });

    if (error) throw error;

    console.log(`Synced ${sensors.length} Queen sensors`);
    console.table(
      sensors.map((sensor) => ({
        sensor_id: sensor.sensor_id,
        segment_id: sensor.segment_id,
        sensor_name: sensor.sensor_name,
        description: sensor.description,
      }))
    );
  } catch (error) {
    console.error("Failed to sync Queen sensors:", error.message);

    if (error.response && error.response.data) {
      console.error(error.response.data);
    }

    process.exit(1);
  }
}

syncQueenSensors();