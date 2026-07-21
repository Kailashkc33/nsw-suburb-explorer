#!/usr/bin/env node
'use strict';

/**
 * TfNSW GTFS transport enrichment preprocessor.
 *
 * Default: dry-run only (writes data/generated/*, no Supabase writes).
 * Apply: npm run data:gtfs-transport -- --apply
 * Requires SUPABASE_SERVICE_ROLE_KEY and project xawngegfdetdazxgvzab for --apply.
 */

const fs = require('node:fs');
const path = require('node:path');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const {
  loadStops,
  loadRoutes,
  loadTripRouteMap,
  buildStopRouteIndex,
  dedupeStopsByParent,
  attachRoutesToCanonicalStops,
  buildSuburbSpatialIndex,
  matchStopToSuburb,
  buildStopDistanceIndex,
  summarizeSuburbTransport,
  mapRouteType,
} = require('./lib/gtfs-transport');
const {
  downloadSuburbBoundaries,
  indexBoundariesByNamePostcode,
  findBoundaryForSuburb,
  NSW_SUBURB_LAYER,
} = require('./lib/nsw-suburb-boundaries');

const ROOT = path.join(__dirname, '..');
const DEFAULT_ZIP = path.join(ROOT, 'data/raw/tfnsw-gtfs/timetables-complete-gtfs.zip');
const OUT_DIR = path.join(ROOT, 'data/generated');
const BOUNDARY_CACHE = path.join(OUT_DIR, 'nsw-suburb-boundaries-simplified.json');
const REQUIRED_PROJECT = 'xawngegfdetdazxgvzab';

function parseArgs(argv) {
  const options = { zip: process.env.TFNSW_GTFS_ZIP || DEFAULT_ZIP, apply: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--zip') options.zip = argv[++i];
    else if (arg === '--help' || arg === '-h') options.help = true;
  }
  return options;
}

function assertTargetProject() {
  const url = process.env.SUPABASE_URL;
  if (!url) throw new Error('SUPABASE_URL is required');
  const ref = new URL(url).hostname.split('.')[0];
  if (ref !== REQUIRED_PROJECT) {
    throw new Error(`Refusing write: connected project ${ref} is not ${REQUIRED_PROJECT}`);
  }
  return ref;
}

function createSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '').trim();
  if (!url || !key) return null;
  return createClient(url, key);
}

async function loadSuburbs(supabase) {
  if (!supabase) return require(path.join(ROOT, 'data/suburbs.sample.json'));
  const rows = [];
  for (let start = 0; ; start += 1000) {
    const { data, error } = await supabase.from('suburbs').select('id,suburb,postcode,region').range(start, start + 999);
    if (error) throw error;
    rows.push(...data);
    if (data.length < 1000) break;
  }
  return rows;
}

function inspectZipMetadata(zipPath) {
  const { spawnSync } = require('node:child_process');
  const listed = spawnSync('unzip', ['-l', zipPath], { encoding: 'utf8' });
  if (listed.status !== 0) throw new Error(listed.stderr || 'Unable to list GTFS zip');
  const files = {};
  for (const line of listed.stdout.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+\d{2}-\d{2}-\d{4}\s+\d{2}:\d{2}\s+(.+)$/);
    if (!match) continue;
    files[match[2].trim()] = Number(match[1]);
  }
  return files;
}

async function applyToSupabase(supabase, { routes, stops, summaries }) {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()) {
    throw new Error('--apply requires SUPABASE_SERVICE_ROLE_KEY');
  }
  assertTargetProject();

  // Parent tables first: routes → stops → summary → suburb_transport_stops
  const routeRows = [...routes.values()].map((route) => ({
    route_id: route.route_id,
    agency_id: route.agency_id,
    route_short_name: route.route_short_name,
    route_long_name: route.route_long_name,
    route_desc: route.route_desc,
    route_type: route.route_type,
    mode: route.mode,
    source: 'TfNSW GTFS',
    updated_at: new Date().toISOString(),
  }));

  const linkRows = [];
  for (const item of summaries) {
    item.nearby_transport.forEach((stop, index) => {
      linkRows.push({
        suburb_id: item.suburb_id,
        stop_id: stop.stop_id,
        distance_m: stop.distance_m,
        rank: index + 1,
        source: 'TfNSW GTFS',
        updated_at: new Date().toISOString(),
      });
    });
  }

  const requiredStopIds = new Set(linkRows.map((row) => row.stop_id));
  const stopsById = new Map(stops.map((stop) => [stop.stop_id, stop]));
  const missingStops = [...requiredStopIds].filter((id) => !stopsById.has(id));
  if (missingStops.length) {
    throw new Error(`Orphan stop_id references before import: ${missingStops.slice(0, 10).join(', ')}`);
  }

  const stopRows = [...requiredStopIds].map((stopId) => {
    const stop = stopsById.get(stopId);
    return {
      stop_id: stop.stop_id,
      stop_name: stop.stop_name,
      stop_lat: stop.stop_lat,
      stop_lon: stop.stop_lon,
      location_type: stop.location_type,
      is_major: stop.is_major,
      modes: stop.modes,
      route_count: stop.route_ids.length,
      wheelchair_boarding: stop.wheelchair_boarding === '1',
      platform_count: stop.platform_count,
      source: 'TfNSW GTFS',
      updated_at: new Date().toISOString(),
    };
  });

  console.log('Upserting transport_routes…');
  for (let i = 0; i < routeRows.length; i += 500) {
    const { error } = await supabase.from('transport_routes').upsert(routeRows.slice(i, i + 500), { onConflict: 'route_id' });
    if (error) throw error;
  }

  console.log('Upserting transport_stops…');
  for (let i = 0; i < stopRows.length; i += 500) {
    const { error } = await supabase.from('transport_stops').upsert(stopRows.slice(i, i + 500), { onConflict: 'stop_id' });
    if (error) throw error;
  }

  const summaryRows = summaries
    .filter((item) => item.transport_summary)
    .map((item) => ({
      suburb_id: item.suburb_id,
      nearest_stop_name: item.transport_summary.nearest_stop_name,
      nearest_stop_distance_m: item.transport_summary.nearest_stop_distance_m,
      nearest_major_stop_name: item.transport_summary.nearest_major_stop_name,
      nearest_major_stop_modes: item.transport_summary.nearest_major_stop_modes || [],
      nearest_major_stop_distance_m: item.transport_summary.nearest_major_stop_distance_m,
      stops_within_500m: item.transport_summary.stops_within_500m,
      stops_within_1km: item.transport_summary.stops_within_1km,
      stops_within_2km: item.transport_summary.stops_within_2km,
      stops_in_suburb: item.transport_summary.stops_in_suburb,
      modes: item.transport_summary.modes || [],
      route_count: item.transport_summary.route_count,
      accessible_stop_count: item.transport_summary.accessible_stop_count,
      match_quality: item.match_quality,
      attribution: item.transport_summary.attribution || 'Transport for NSW',
      source: 'TfNSW GTFS',
      updated_at: new Date().toISOString(),
    }));

  console.log('Upserting suburb_transport_summary…');
  for (let i = 0; i < summaryRows.length; i += 500) {
    const { error } = await supabase.from('suburb_transport_summary').upsert(summaryRows.slice(i, i + 500), { onConflict: 'suburb_id' });
    if (error) throw error;
  }

  const insertedStopIds = new Set(stopRows.map((row) => row.stop_id));
  const orphanLinks = linkRows.filter((row) => !insertedStopIds.has(row.stop_id));
  if (orphanLinks.length) {
    throw new Error(`Refusing suburb_transport_stops upsert: ${orphanLinks.length} orphan stop_id values`);
  }

  console.log('Upserting suburb_transport_stops…');
  for (let i = 0; i < linkRows.length; i += 500) {
    const { error } = await supabase.from('suburb_transport_stops').upsert(linkRows.slice(i, i + 500), { onConflict: 'suburb_id,stop_id' });
    if (error) throw error;
  }

  return {
    transport_routes: routeRows.length,
    transport_stops: stopRows.length,
    suburb_transport_summary: summaryRows.length,
    suburb_transport_stops: linkRows.length,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(`Usage: node scripts/import-gtfs-transport.js [--zip PATH] [--apply]

Builds suburb transport summaries from TfNSW GTFS.
Dry-run by default. --apply upserts transport tables only (never suburbs / suburb_profiles).`);
    return;
  }
  if (!fs.existsSync(options.zip)) throw new Error(`GTFS zip not found: ${options.zip}`);
  fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log('Inspecting GTFS zip…');
  const zipFiles = inspectZipMetadata(options.zip);

  console.log('Loading routes, trips and stops…');
  const routes = await loadRoutes(options.zip);
  const modeCounts = {};
  for (const route of routes.values()) {
    modeCounts[route.mode] = (modeCounts[route.mode] || 0) + 1;
  }
  const tripToRoute = await loadTripRouteMap(options.zip);
  const rawStops = await loadStops(options.zip);
  const parentStations = rawStops.filter((stop) => stop.location_type === '1').length;
  const canonical = dedupeStopsByParent(rawStops);
  console.log(`Stops ${rawStops.length}; parent stations ${parentStations}; canonical after dedupe ${canonical.length}`);

  console.log('Streaming stop_times → stop/route index…');
  const { stopRoutes, rows: stopTimeRows } = await buildStopRouteIndex(
    options.zip,
    tripToRoute,
    (rows) => console.log(`  … ${rows.toLocaleString('en-AU')} stop_times rows`)
  );
  const enrichedStops = attachRoutesToCanonicalStops(canonical, rawStops, stopRoutes, routes)
    .filter((stop) => stop.stop_lat != null && stop.stop_lon != null && stop.route_ids.length > 0);
  console.log(`Canonical stops with routes: ${enrichedStops.length}`);

  console.log('Downloading / loading NSW suburb boundaries for point-in-polygon…');
  const boundaryBundle = await downloadSuburbBoundaries({ cachePath: BOUNDARY_CACHE });
  const spatialIndex = buildSuburbSpatialIndex(boundaryBundle.boundaries);
  const boundaryIndex = indexBoundariesByNamePostcode(boundaryBundle.boundaries);

  const supabase = createSupabase();
  if (options.apply) assertTargetProject();
  const suburbs = await loadSuburbs(supabase);
  console.log(`Matching against ${suburbs.length} suburb rows…`);

  const stopAssignments = { matched: 0, unmatched: 0, ambiguous: 0 };
  const stopsBySuburbKey = new Map();
  const ambiguousStops = [];
  const unmatchedStops = [];

  for (const stop of enrichedStops) {
    const result = matchStopToSuburb(stop, spatialIndex);
    if (result.status === 'matched') {
      stopAssignments.matched += 1;
      const key = `${result.suburb_name.toLocaleLowerCase('en-AU')}|${result.postcode}`;
      if (!stopsBySuburbKey.has(key)) stopsBySuburbKey.set(key, []);
      stopsBySuburbKey.get(key).push(stop);
    } else if (result.status === 'ambiguous') {
      stopAssignments.ambiguous += 1;
      if (ambiguousStops.length < 50) ambiguousStops.push({ stop_id: stop.stop_id, stop_name: stop.stop_name, ...result });
    } else {
      stopAssignments.unmatched += 1;
      if (unmatchedStops.length < 50) unmatchedStops.push({ stop_id: stop.stop_id, stop_name: stop.stop_name, reason: result.reason });
    }
  }

  const stopIndex = buildStopDistanceIndex(enrichedStops);
  const summaries = [];
  const suburbBoundaryReport = { matched: 0, matched_name_only: 0, ambiguous: 0, unmatched: 0 };
  for (const suburb of suburbs) {
    const boundaryHit = findBoundaryForSuburb(suburb, boundaryIndex);
    let centroid = null;
    let memberStops = [];
    if (boundaryHit.status === 'matched' || boundaryHit.status === 'matched_name_only') {
      if (boundaryHit.status === 'matched') suburbBoundaryReport.matched += 1;
      else suburbBoundaryReport.matched_name_only += 1;
      centroid = boundaryHit.boundary.centroid;
      const key = `${boundaryHit.boundary.suburb_name.toLocaleLowerCase('en-AU')}|${boundaryHit.boundary.postcode}`;
      memberStops = stopsBySuburbKey.get(key) || [];
    } else if (boundaryHit.status.startsWith('ambiguous')) {
      suburbBoundaryReport.ambiguous += 1;
    } else {
      suburbBoundaryReport.unmatched += 1;
    }

    summaries.push(summarizeSuburbTransport({
      suburb,
      centroid,
      memberStops,
      stopIndex,
    }));
  }

  const withTransport = summaries.filter((item) => item.transport_summary && (item.transport_summary.stops_within_2km > 0 || item.transport_summary.stops_in_suburb > 0));
  const generatedAt = new Date().toISOString();
  const sourceMeta = {
    attribution: 'Transport for NSW',
    license_note: 'TfNSW open data / GTFS timetable feed. Verify current licensing terms before redistribution.',
    gtfs_zip: path.basename(options.zip),
    gtfs_zip_entry_dates: '2026-07-21 (from zip listing)',
    boundaries_source: NSW_SUBURB_LAYER,
    boundaries_strategy: boundaryBundle.strategy,
    boundaries_limitation: boundaryBundle.limitation,
    generated_at: generatedAt,
    uncompressed_bytes: zipFiles,
    counts: {
      stops_raw: rawStops.length,
      parent_stations: parentStations,
      canonical_stops: canonical.length,
      canonical_stops_with_routes: enrichedStops.length,
      routes: routes.size,
      routes_by_mode: modeCounts,
      trips: tripToRoute.size,
      stop_times_rows: stopTimeRows,
      suburbs: suburbs.length,
      boundaries: boundaryBundle.count,
    },
  };

  const summaryOut = {
    ...sourceMeta,
    summaries: summaries.map((item) => ({
      suburb_id: item.suburb_id,
      suburb: item.suburb,
      postcode: item.postcode,
      match_quality: item.match_quality,
      transport_summary: item.transport_summary,
    })),
  };
  const stopsOut = {
    generated_at: generatedAt,
    max_per_suburb: 12,
    stops_by_suburb: Object.fromEntries(
      summaries.map((item) => [String(item.suburb_id), item.nearby_transport])
    ),
  };
  const reportOut = {
    generated_at: generatedAt,
    stop_assignments: stopAssignments,
    suburb_boundary_links: suburbBoundaryReport,
    suburbs_with_transport: withTransport.length,
    suburbs_without_transport: summaries.length - withTransport.length,
    ambiguous_stop_samples: ambiguousStops,
    unmatched_stop_samples: unmatchedStops,
    estimated_db_rows: {
      transport_routes: routes.size,
      transport_stops_if_all_enriched: enrichedStops.length,
      transport_stops_if_nearby_and_major_only: 'computed at --apply',
      suburb_transport_summary: withTransport.length,
      suburb_transport_stops: summaries.reduce((sum, item) => sum + item.nearby_transport.length, 0),
    },
  };

  fs.writeFileSync(path.join(OUT_DIR, 'suburb-transport-summary.json'), JSON.stringify(summaryOut));
  fs.writeFileSync(path.join(OUT_DIR, 'suburb-transport-stops.json'), JSON.stringify(stopsOut));
  fs.writeFileSync(path.join(OUT_DIR, 'transport-match-report.json'), JSON.stringify(reportOut, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, 'transport-source-metadata.json'), JSON.stringify(sourceMeta, null, 2));

  console.log('\nGTFS / match summary');
  console.log(JSON.stringify({
    uncompressed_bytes: zipFiles,
    routes_by_mode: modeCounts,
    stop_assignments: stopAssignments,
    suburb_boundary_links: suburbBoundaryReport,
    suburbs_with_transport: withTransport.length,
  }, null, 2));

  if (options.apply) {
    console.log('\nApplying transport upserts (--apply)…');
    const applied = await applyToSupabase(supabase, { routes, stops: enrichedStops, summaries: withTransport });
    console.log('Upserted', applied);
  } else {
    console.log('\nDry run only. Review totals, then apply migration SQL and run:');
    console.log('  npm run data:gtfs-transport -- --apply');
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
