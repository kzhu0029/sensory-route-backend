const express = require("express");
const router = express.Router();
const supabase = require("../supabaseClient");
const { getPedestrianSegments } = require("../services/pedestrianSegments");

const ACTIVITY_PENALTY = {
  LOW: 1,
  MEDIUM: 1.12,
  HIGH: 1.35,
  UNKNOWN: 1.2,
};

const NODE_SNAP_TOLERANCE_METRES = 10;
const NETWORK_BRIDGE_LIMIT_METRES = 180;
const NETWORK_BRIDGE_PENALTY = 3;

function parseCoordinatePair(pair) {
  if (!Array.isArray(pair) || pair.length < 2) return null;

  const first = Number(pair[0]);
  const second = Number(pair[1]);

  if (!Number.isFinite(first) || !Number.isFinite(second)) return null;

  return Math.abs(first) > 90 ? [second, first] : [first, second];
}

function parseGeometry(value) {
  if (!value) return null;
  if (typeof value === "object") return value;

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function getSegmentPositions(row) {
  const geometry = parseGeometry(row.geo_shape || row.geometry);
  const coordinates = geometry?.coordinates || row.coordinates;

  if (!Array.isArray(coordinates)) return [];

  return coordinates.map(parseCoordinatePair).filter(Boolean);
}

function toNodeKey(position) {
  return `${position[0].toFixed(6)},${position[1].toFixed(6)}`;
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

function routeQueryPosition(query, latKey, lngKey) {
  const lat = Number(query[latKey]);
  const lng = Number(query[lngKey]);

  return Number.isFinite(lat) && Number.isFinite(lng) ? [lat, lng] : null;
}

function formatCoordinate(value) {
  return Number(value).toFixed(5);
}

function formatNetworkPoint(position, label) {
  if (!position) return `${label} unavailable`;

  return `${label} (${formatCoordinate(position[0])}, ${formatCoordinate(position[1])})`;
}

function getSensorDescription(pedestrian) {
  return pedestrian?.sensors
    ?.map((sensor) => sensor.sensor_description)
    .filter(Boolean)
    .join(" / ");
}

function normaliseRouteSegment(row, index, pedestrian) {
  const crowdLevel = pedestrian?.crowd_level || "UNKNOWN";
  const segmentId = row.id ?? row.segment_id ?? `route-segment-${index + 1}`;
  const hasPedestrianData = Boolean(pedestrian);
  const positions = getSegmentPositions(row);
  const startPosition = positions[0];
  const endPosition = positions[positions.length - 1];
  const sensorDescription = getSensorDescription(pedestrian);

  return {
    ...row,
    id: row.id ?? segmentId,
    segment_id: segmentId,
    segment_name:
      row.segment_name ||
      row.name ||
      row.street_name ||
      (sensorDescription
        ? `${sensorDescription} monitored segment`
        : `Monitored pedestrian segment ${segmentId}`),
    start_location:
      row.start_location || formatNetworkPoint(startPosition, "Segment start"),
    end_location:
      row.end_location || formatNetworkPoint(endPosition, "Segment end"),
    accessible: row.accessible ?? true,
    pedestrian_count: pedestrian?.pedestrian_count ?? null,
    crowd_level: crowdLevel,
    avoid: pedestrian?.avoid ?? crowdLevel === "HIGH",
    sensors: pedestrian?.sensors ?? [],
    sensing_datetime: pedestrian?.sensing_datetime ?? null,
    observed_at: pedestrian?.observed_at ?? pedestrian?.sensing_datetime ?? null,
    updated_at: pedestrian?.updated_at ?? pedestrian?.data_refreshed_at ?? null,
    observation_window_start: pedestrian?.observation_window_start ?? null,
    observation_window_end: pedestrian?.observation_window_end ?? null,
    data_refreshed_at: pedestrian?.data_refreshed_at ?? null,
    is_unknown: crowdLevel === "UNKNOWN",
    unknown_reason:
      crowdLevel === "UNKNOWN"
        ? pedestrian?.unknown_reason ||
          (hasPedestrianData
            ? "Missing Data"
            : "No sensor mapped to this segment")
        : null,
  };
}

function createNetworkBridge(startPosition, endPosition) {
  const connector = createConnector(
    "connector-network-bridge",
    startPosition,
    endPosition,
    formatNetworkPoint(startPosition, "Pedestrian network"),
    formatNetworkPoint(endPosition, "Pedestrian network")
  );

  return connector
    ? {
        ...connector,
        recommendation: "Connector section",
        reason:
          "This section links nearby monitored pedestrian segments where the source network data is not physically connected.",
      }
    : null;
}

function createConnector(id, startPosition, endPosition, startLocation, endLocation) {
  const distance = distanceInMetres(startPosition, endPosition);

  if (distance < 8) return null;

  return {
    id,
    segment_id: id,
    segment_name: "Walking connector",
    start_location: startLocation,
    end_location: endLocation,
    accessible: true,
    pedestrian_count: null,
    crowd_level: "CONNECTOR",
    avoid: false,
    sensors: [],
    sensing_datetime: null,
    observed_at: null,
    updated_at: null,
    observation_window_start: null,
    observation_window_end: null,
    data_refreshed_at: null,
    is_unknown: false,
    unknown_reason: null,
    route_generated: true,
    is_connector: true,
    distance_m: distance,
    coordinates: [startPosition, endPosition],
  };
}

function createRouteFallback(origin, destination, query, reason) {
  const originLabel = query.originLabel || "Selected start";
  const destinationLabel = query.destinationLabel || "Selected destination";
  const connector = createConnector(
    "connector-route-fallback",
    origin,
    destination,
    originLabel,
    destinationLabel
  );

  return connector
    ? [
        {
          ...connector,
          route_generated: false,
          route_fallback: true,
          recommendation: "Use caution",
          reason,
        },
      ]
    : [];
}

function buildGraph(rows) {
  const nodes = new Map();
  const graph = new Map();

  function addNode(position) {
    for (const [existingKey, existingPosition] of nodes) {
      if (
        distanceInMetres(position, existingPosition) <=
        NODE_SNAP_TOLERANCE_METRES
      ) {
        return existingKey;
      }
    }

    const key = toNodeKey(position);
    if (!nodes.has(key)) nodes.set(key, position);
    if (!graph.has(key)) graph.set(key, []);
    return key;
  }

  rows.forEach((row, index) => {
    const positions = getSegmentPositions(row);
    if (positions.length < 2) return;

    const penalty = ACTIVITY_PENALTY[row.crowd_level] || ACTIVITY_PENALTY.UNKNOWN;

    positions.slice(1).forEach((position, partIndex) => {
      const previousPosition = positions[partIndex];
      const startKey = addNode(previousPosition);
      const endKey = addNode(position);

      if (startKey === endKey) return;

      const baseDistance = distanceInMetres(previousPosition, position);
      const cost = Math.max(baseDistance, 1) * penalty;

      graph.get(startKey).push({
        to: endKey,
        cost,
        row,
        index,
        partIndex,
        coordinates: [previousPosition, position],
        reversed: false,
      });
      graph.get(endKey).push({
        to: startKey,
        cost,
        row,
        index,
        partIndex,
        coordinates: [position, previousPosition],
        reversed: true,
      });
    });
  });

  const nodeEntries = [...nodes.entries()];

  nodeEntries.forEach(([startKey, startPosition], startIndex) => {
    nodeEntries.slice(startIndex + 1).forEach(([endKey, endPosition]) => {
      if (graph.get(startKey)?.some((edge) => edge.to === endKey)) return;

      const distance = distanceInMetres(startPosition, endPosition);
      if (
        distance <= NODE_SNAP_TOLERANCE_METRES ||
        distance > NETWORK_BRIDGE_LIMIT_METRES
      ) {
        return;
      }

      const bridge = createNetworkBridge(startPosition, endPosition);
      if (!bridge) return;

      const cost = Math.max(distance, 1) * NETWORK_BRIDGE_PENALTY;
      graph.get(startKey).push({
        to: endKey,
        cost,
        row: bridge,
        index: -1,
        partIndex: 0,
        coordinates: [startPosition, endPosition],
        reversed: false,
      });
      graph.get(endKey).push({
        to: startKey,
        cost,
        row: bridge,
        index: -1,
        partIndex: 0,
        coordinates: [endPosition, startPosition],
        reversed: true,
      });
    });
  });

  return { nodes, graph };
}

function findClosestNode(nodes, target) {
  let closestKey = null;
  let closestDistance = Infinity;

  for (const [key, position] of nodes) {
    const distance = distanceInMetres(target, position);
    if (distance < closestDistance) {
      closestKey = key;
      closestDistance = distance;
    }
  }

  return closestKey;
}

function findShortestPath(graph, startKey, endKey) {
  const distances = new Map([[startKey, 0]]);
  const previous = new Map();
  const visited = new Set();

  while (visited.size < graph.size) {
    let currentKey = null;
    let currentDistance = Infinity;

    for (const [key, distance] of distances) {
      if (!visited.has(key) && distance < currentDistance) {
        currentKey = key;
        currentDistance = distance;
      }
    }

    if (!currentKey || currentKey === endKey) break;

    visited.add(currentKey);

    for (const edge of graph.get(currentKey) || []) {
      const nextDistance = currentDistance + edge.cost;
      if (nextDistance < (distances.get(edge.to) ?? Infinity)) {
        distances.set(edge.to, nextDistance);
        previous.set(edge.to, { from: currentKey, edge });
      }
    }
  }

  if (!previous.has(endKey)) return [];

  const path = [];
  let currentKey = endKey;

  while (currentKey !== startKey) {
    const step = previous.get(currentKey);
    if (!step) return [];

    path.unshift(step.edge);
    currentKey = step.from;
  }

  return path;
}

function withRouteGeometry(edge, routeOrder) {
  const segmentId = edge.row.segment_id ?? edge.row.id;
  return {
    ...edge.row,
    id: `${segmentId}-part-${edge.partIndex}-${routeOrder}`,
    original_segment_id: segmentId,
    segment_id: segmentId,
    coordinates: edge.coordinates,
    start_location: formatNetworkPoint(edge.coordinates[0], "Segment start"),
    end_location: formatNetworkPoint(edge.coordinates[edge.coordinates.length - 1], "Segment end"),
    distance_m: distanceInMetres(edge.coordinates[0], edge.coordinates[edge.coordinates.length - 1]),
  };
}

function buildRouteResponse(rows, origin, destination, query) {
  const { nodes, graph } = buildGraph(rows);

  if (!nodes.size) {
    return createRouteFallback(
      origin,
      destination,
      query,
      "No pedestrian network geometry is available"
    );
  }

  const startKey = findClosestNode(nodes, origin);
  const endKey = findClosestNode(nodes, destination);

  if (!startKey || !endKey) {
    return createRouteFallback(
      origin,
      destination,
      query,
      "No nearby pedestrian network node was found"
    );
  }

  const path = findShortestPath(graph, startKey, endKey);

  if (!path.length) {
    return createRouteFallback(
      origin,
      destination,
      query,
      "No connected pedestrian network route was found"
    );
  }

  const result = [];
  const firstPosition = nodes.get(startKey);
  const lastPosition = nodes.get(endKey);
  const originLabel = query.originLabel || "Selected start";
  const destinationLabel = query.destinationLabel || "Selected destination";
  const firstConnector = createConnector(
    "connector-origin",
    origin,
    firstPosition,
    originLabel,
    path[0]?.row?.segment_name || "Pedestrian network"
  );

  if (firstConnector) result.push(firstConnector);

  path.forEach((edge, index) => {
    result.push({
      ...withRouteGeometry(edge, index + 1),
      route_generated: true,
      route_order: index + 1,
    });
  });

  const finalConnector = createConnector(
    "connector-destination",
    lastPosition,
    destination,
    path[path.length - 1]?.row?.segment_name || "Pedestrian network",
    destinationLabel
  );

  if (finalConnector) result.push(finalConnector);

  return result;
}

router.get("/", async (req, res) => {
  try {
    const [{ data, error }, pedestrianRows] = await Promise.all([
      supabase
        .from("route_segments")
        .select("*")
        .order("id", { ascending: true }),
      getPedestrianSegments(),
    ]);

    if (error) {
      return res.status(500).json(error);
    }

    const pedestrianBySegment = new Map(
      pedestrianRows.map((row) => [Number(row.segment_id), row])
    );

    const result = (data || []).map((row, index) =>
      normaliseRouteSegment(
        row,
        index,
        pedestrianBySegment.get(Number(row.id))
      )
    );

    const origin =
      routeQueryPosition(req.query, "originLat", "originLng") ||
      routeQueryPosition(req.query, "startLat", "startLng");
    const destination =
      routeQueryPosition(req.query, "destinationLat", "destinationLng") ||
      routeQueryPosition(req.query, "destLat", "destLng");

    if (origin && destination) {
      return res.json(
        buildRouteResponse(result, origin, destination, req.query)
      );
    }

    res.json(result);
  } catch (error) {
    console.error("Routes API failed:", error);
    res.status(500).json({
      error: "Failed to load route segments",
    });
  }
});

module.exports = router;
