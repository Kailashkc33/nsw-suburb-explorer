'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');

const EARTH_RADIUS_M = 6371000;
const MAJOR_MODES = new Set(['Train', 'Metro', 'Ferry', 'Light Rail']);

const ROUTE_TYPE_MAP = Object.freeze({
  2: 'Train',
  4: 'Ferry',
  100: 'Train',
  101: 'Train',
  102: 'Train',
  103: 'Train',
  106: 'Train',
  200: 'Coach',
  201: 'Coach',
  202: 'Coach',
  203: 'Coach',
  204: 'Coach',
  205: 'Coach',
  400: 'Metro',
  401: 'Metro',
  700: 'Bus',
  701: 'Bus',
  702: 'Bus',
  703: 'Bus',
  704: 'Bus',
  705: 'Bus',
  712: 'Bus',
  713: 'Bus',
  714: 'Bus',
  715: 'Bus',
  900: 'Light Rail',
  901: 'Light Rail',
  902: 'Light Rail',
});

function parseCsvLine(line) {
  const cells = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"' && line[index + 1] === '"') {
      value += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === ',' && !quoted) {
      cells.push(value);
      value = '';
    } else {
      value += char;
    }
  }
  cells.push(value);
  return cells;
}

function mapRouteType(routeType) {
  const value = Number(routeType);
  if (!Number.isFinite(value)) return 'Other';
  if (ROUTE_TYPE_MAP[value]) return ROUTE_TYPE_MAP[value];
  if (value >= 100 && value < 200) return 'Train';
  if (value >= 200 && value < 300) return 'Coach';
  if (value >= 400 && value < 500) return 'Metro';
  if (value >= 700 && value < 800) return 'Bus';
  if (value >= 900 && value < 1000) return 'Light Rail';
  if (value >= 1000 && value < 1100) return 'Ferry';
  return 'Other';
}

function isMajorMode(mode) {
  return MAJOR_MODES.has(mode);
}

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function haversineMetres(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const intersects = ((yi > lat) !== (yj > lat))
      && (lon < ((xj - xi) * (lat - yi)) / ((yj - yi) || Number.EPSILON) + xi);
    if (intersects) inside = !inside;
  }
  return inside;
}

function pointInPolygon(lon, lat, rings) {
  if (!rings?.length) return false;
  if (!pointInRing(lon, lat, rings[0])) return false;
  for (let index = 1; index < rings.length; index += 1) {
    if (pointInRing(lon, lat, rings[index])) return false;
  }
  return true;
}

function polygonCentroid(rings) {
  const ring = rings?.[0];
  if (!ring?.length) return null;
  let area = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [x1, y1] = ring[j];
    const [x2, y2] = ring[i];
    const f = (x1 * y2) - (x2 * y1);
    area += f;
    cx += (x1 + x2) * f;
    cy += (y1 + y2) * f;
  }
  area *= 0.5;
  if (Math.abs(area) < Number.EPSILON) {
    const avgX = ring.reduce((sum, point) => sum + point[0], 0) / ring.length;
    const avgY = ring.reduce((sum, point) => sum + point[1], 0) / ring.length;
    return { lon: avgX, lat: avgY };
  }
  return { lon: cx / (6 * area), lat: cy / (6 * area) };
}

function ringBBox(rings) {
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const ring of rings || []) {
    for (const [lon, lat] of ring) {
      minLon = Math.min(minLon, lon);
      minLat = Math.min(minLat, lat);
      maxLon = Math.max(maxLon, lon);
      maxLat = Math.max(maxLat, lat);
    }
  }
  return { minLon, minLat, maxLon, maxLat };
}

function openZipEntryStream(zipPath, entryName) {
  const child = spawn('unzip', ['-p', zipPath, entryName], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', () => {});
  return child.stdout;
}

async function forEachCsvRowFromZip(zipPath, entryName, onRow) {
  const stream = openZipEntryStream(zipPath, entryName);
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let header = null;
  let count = 0;
  for await (const raw of rl) {
    const line = raw.replace(/^\uFEFF/, '');
    if (!line.trim()) continue;
    if (!header) {
      header = parseCsvLine(line);
      continue;
    }
    const cells = parseCsvLine(line);
    const row = Object.fromEntries(header.map((name, index) => [name, cells[index] ?? '']));
    count += 1;
    onRow(row, count);
  }
  return { header, count };
}

function dedupeStopsByParent(stops) {
  const byId = new Map(stops.map((stop) => [stop.stop_id, stop]));
  const canonical = new Map();

  for (const stop of stops) {
    const parentId = stop.parent_station || '';
    const parent = parentId ? byId.get(parentId) : null;
    const useParent = Boolean(parent && (stop.location_type !== '1'));
    const target = useParent ? parent : stop;
    const id = target.stop_id;
    if (!canonical.has(id)) {
      canonical.set(id, {
        stop_id: id,
        stop_name: target.stop_name,
        stop_lat: toNumber(target.stop_lat),
        stop_lon: toNumber(target.stop_lon),
        location_type: target.location_type || '0',
        parent_station: target.parent_station || null,
        wheelchair_boarding: target.wheelchair_boarding || '0',
        platform_members: new Set(),
        route_ids: new Set(),
        modes: new Set(),
      });
    }
    canonical.get(id).platform_members.add(stop.stop_id);
    if (stop.wheelchair_boarding === '1') {
      canonical.get(id).wheelchair_boarding = '1';
    }
  }

  return [...canonical.values()].map((item) => ({
    ...item,
    platform_members: [...item.platform_members],
  }));
}

async function loadStops(zipPath) {
  const stops = [];
  await forEachCsvRowFromZip(zipPath, 'stops.txt', (row) => {
    stops.push({
      stop_id: row.stop_id,
      stop_code: row.stop_code,
      stop_name: row.stop_name,
      stop_lat: row.stop_lat,
      stop_lon: row.stop_lon,
      location_type: row.location_type || '',
      parent_station: row.parent_station || '',
      wheelchair_boarding: row.wheelchair_boarding || '0',
      platform_code: row.platform_code || '',
    });
  });
  return stops;
}

async function loadRoutes(zipPath) {
  const routes = new Map();
  await forEachCsvRowFromZip(zipPath, 'routes.txt', (row) => {
    routes.set(row.route_id, {
      route_id: row.route_id,
      agency_id: row.agency_id,
      route_short_name: row.route_short_name,
      route_long_name: row.route_long_name,
      route_desc: row.route_desc,
      route_type: Number(row.route_type),
      mode: mapRouteType(row.route_type),
    });
  });
  return routes;
}

async function loadTripRouteMap(zipPath) {
  const tripToRoute = new Map();
  await forEachCsvRowFromZip(zipPath, 'trips.txt', (row) => {
    tripToRoute.set(row.trip_id, row.route_id);
  });
  return tripToRoute;
}

/**
 * Stream stop_times and build stop_id -> Set(route_id).
 * Uses trip -> route map; does not retain times or sequences.
 */
async function buildStopRouteIndex(zipPath, tripToRoute, onProgress) {
  const stopRoutes = new Map();
  let rows = 0;
  await forEachCsvRowFromZip(zipPath, 'stop_times.txt', (row) => {
    rows += 1;
    if (onProgress && rows % 1_000_000 === 0) onProgress(rows);
    const routeId = tripToRoute.get(row.trip_id);
    if (!routeId) return;
    if (!stopRoutes.has(row.stop_id)) stopRoutes.set(row.stop_id, new Set());
    stopRoutes.get(row.stop_id).add(routeId);
  });
  return { stopRoutes, rows };
}

function attachRoutesToCanonicalStops(canonicalStops, rawStops, stopRoutes, routes) {
  const memberToCanonical = new Map();
  for (const stop of canonicalStops) {
    for (const memberId of stop.platform_members) {
      memberToCanonical.set(memberId, stop.stop_id);
    }
    memberToCanonical.set(stop.stop_id, stop.stop_id);
  }

  const byId = new Map(canonicalStops.map((stop) => [stop.stop_id, stop]));
  for (const [stopId, routeIds] of stopRoutes) {
    const canonicalId = memberToCanonical.get(stopId);
    if (!canonicalId) continue;
    const target = byId.get(canonicalId);
    if (!target) continue;
    for (const routeId of routeIds) {
      target.route_ids.add(routeId);
      const route = routes.get(routeId);
      if (route) target.modes.add(route.mode);
    }
  }

  return canonicalStops.map((stop) => ({
    stop_id: stop.stop_id,
    stop_name: stop.stop_name,
    stop_lat: stop.stop_lat,
    stop_lon: stop.stop_lon,
    location_type: stop.location_type,
    wheelchair_boarding: stop.wheelchair_boarding,
    route_ids: [...stop.route_ids],
    modes: [...stop.modes].sort(),
    is_major: [...stop.modes].some(isMajorMode),
    platform_count: stop.platform_members.length,
  }));
}

function buildSuburbSpatialIndex(boundaries) {
  const cells = new Map();
  const cellSize = 0.05; // ~5km
  for (const boundary of boundaries) {
    const { minLon, minLat, maxLon, maxLat } = boundary.bbox;
    const x0 = Math.floor(minLon / cellSize);
    const x1 = Math.floor(maxLon / cellSize);
    const y0 = Math.floor(minLat / cellSize);
    const y1 = Math.floor(maxLat / cellSize);
    for (let x = x0; x <= x1; x += 1) {
      for (let y = y0; y <= y1; y += 1) {
        const key = `${x}:${y}`;
        if (!cells.has(key)) cells.set(key, []);
        cells.get(key).push(boundary);
      }
    }
  }
  return { cells, cellSize, boundaries };
}

function matchStopToSuburb(stop, spatialIndex) {
  if (stop.stop_lat == null || stop.stop_lon == null) {
    return { status: 'unmatched', reason: 'missing_coordinates' };
  }
  const x = Math.floor(stop.stop_lon / spatialIndex.cellSize);
  const y = Math.floor(stop.stop_lat / spatialIndex.cellSize);
  const candidates = spatialIndex.cells.get(`${x}:${y}`) || [];
  const hits = [];
  for (const boundary of candidates) {
    const { minLon, minLat, maxLon, maxLat } = boundary.bbox;
    if (stop.stop_lon < minLon || stop.stop_lon > maxLon || stop.stop_lat < minLat || stop.stop_lat > maxLat) {
      continue;
    }
    if (pointInPolygon(stop.stop_lon, stop.stop_lat, boundary.rings)) {
      hits.push(boundary);
    }
  }
  if (hits.length === 0) return { status: 'unmatched', reason: 'outside_all_polygons' };
  if (hits.length > 1) {
    return {
      status: 'ambiguous',
      reason: 'multiple_polygons',
      suburbs: hits.map((item) => ({
        suburb_name: item.suburb_name,
        postcode: item.postcode,
      })),
    };
  }
  return {
    status: 'matched',
    suburb_name: hits[0].suburb_name,
    postcode: hits[0].postcode,
    centroid: hits[0].centroid,
  };
}

function buildStopDistanceIndex(stops, cellSize = 0.05) {
  const cells = new Map();
  for (const stop of stops) {
    if (stop.stop_lat == null || stop.stop_lon == null) continue;
    const x = Math.floor(stop.stop_lon / cellSize);
    const y = Math.floor(stop.stop_lat / cellSize);
    const key = `${x}:${y}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(stop);
  }
  return { cells, cellSize, stops };
}

function stopsNearPoint(index, lat, lon, radiusMetres) {
  // ~111km per degree latitude; pad cells for requested radius.
  const pad = Math.max(1, Math.ceil((radiusMetres / 111_000) / index.cellSize) + 1);
  const x = Math.floor(lon / index.cellSize);
  const y = Math.floor(lat / index.cellSize);
  const out = [];
  for (let dx = -pad; dx <= pad; dx += 1) {
    for (let dy = -pad; dy <= pad; dy += 1) {
      const bucket = index.cells.get(`${x + dx}:${y + dy}`);
      if (!bucket) continue;
      for (const stop of bucket) {
        const distance_m = Math.round(haversineMetres(lat, lon, stop.stop_lat, stop.stop_lon));
        if (distance_m <= radiusMetres) out.push({ ...stop, distance_m });
      }
    }
  }
  out.sort((a, b) => a.distance_m - b.distance_m);
  return out;
}

function summarizeSuburbTransport({ suburb, centroid, memberStops, stopIndex, maxNearby = 12, searchRadiusM = 5000 }) {
  const lat = centroid?.lat;
  const lon = centroid?.lon;
  if (lat == null || lon == null) {
    return {
      suburb_id: suburb.id,
      suburb: suburb.suburb,
      postcode: suburb.postcode,
      match_quality: 'no_centroid',
      transport_summary: null,
      nearby_transport: [],
    };
  }

  const withDistance = stopsNearPoint(stopIndex, lat, lon, searchRadiusM);
  const within = (metres) => withDistance.filter((stop) => stop.distance_m <= metres);
  const stops500 = within(500);
  const stops1k = within(1000);
  const stops2k = within(2000);
  const nearest = withDistance[0] || null;
  const nearestMajor = withDistance.find((stop) => stop.is_major) || null;

  const modeSet = new Set();
  const routeSet = new Set();
  let accessible = 0;
  const modeSource = memberStops.length ? memberStops : stops2k;
  for (const stop of modeSource) {
    for (const mode of stop.modes || []) modeSet.add(mode);
    for (const routeId of stop.route_ids || []) routeSet.add(routeId);
    if (stop.wheelchair_boarding === '1') accessible += 1;
  }

  const ranked = [...withDistance]
    .sort((a, b) => {
      const majorDelta = Number(b.is_major) - Number(a.is_major);
      if (majorDelta) return majorDelta;
      return a.distance_m - b.distance_m;
    })
    .slice(0, maxNearby)
    .map((stop) => ({
      stop_id: stop.stop_id,
      stop_name: stop.stop_name,
      stop_lat: stop.stop_lat,
      stop_lon: stop.stop_lon,
      modes: stop.modes,
      route_count: stop.route_ids.length,
      distance_m: stop.distance_m,
      is_major: stop.is_major,
      wheelchair_boarding: stop.wheelchair_boarding === '1',
    }));

  return {
    suburb_id: suburb.id,
    suburb: suburb.suburb,
    postcode: suburb.postcode,
    match_quality: memberStops.length ? 'point_in_polygon' : 'centroid_radius_only',
    transport_summary: {
      nearest_stop_name: nearest?.stop_name || null,
      nearest_stop_distance_m: nearest?.distance_m ?? null,
      nearest_major_stop_name: nearestMajor?.stop_name || null,
      nearest_major_stop_modes: nearestMajor?.modes || [],
      nearest_major_stop_distance_m: nearestMajor?.distance_m ?? null,
      distance_basis: 'Approximate distance from suburb centre',
      stops_within_500m: stops500.length,
      stops_within_1km: stops1k.length,
      stops_within_2km: stops2k.length,
      stops_in_suburb: memberStops.length,
      modes: [...modeSet].sort(),
      route_count: routeSet.size,
      accessible_stop_count: accessible,
      attribution: 'Transport for NSW',
      data_date: '2026-07-21',
    },
    nearby_transport: ranked,
  };
}

module.exports = {
  MAJOR_MODES,
  ROUTE_TYPE_MAP,
  parseCsvLine,
  mapRouteType,
  isMajorMode,
  toNumber,
  haversineMetres,
  pointInPolygon,
  polygonCentroid,
  ringBBox,
  forEachCsvRowFromZip,
  dedupeStopsByParent,
  loadStops,
  loadRoutes,
  loadTripRouteMap,
  buildStopRouteIndex,
  attachRoutesToCanonicalStops,
  buildSuburbSpatialIndex,
  matchStopToSuburb,
  buildStopDistanceIndex,
  stopsNearPoint,
  summarizeSuburbTransport,
};
