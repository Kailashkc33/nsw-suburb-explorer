'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SUMMARY_PATH = path.join(__dirname, '../data/generated/suburb-transport-summary.json');
const STOPS_PATH = path.join(__dirname, '../data/generated/suburb-transport-stops.json');

function loadTransportBundle() {
  if (!fs.existsSync(SUMMARY_PATH)) {
    return { summariesById: new Map(), stopsById: new Map(), source: 'none' };
  }
  const summaryPayload = JSON.parse(fs.readFileSync(SUMMARY_PATH, 'utf8'));
  const stopsPayload = fs.existsSync(STOPS_PATH)
    ? JSON.parse(fs.readFileSync(STOPS_PATH, 'utf8'))
    : { stops_by_suburb: {} };

  const summariesById = new Map(
    (summaryPayload.summaries || []).map((item) => [String(item.suburb_id), item])
  );
  const stopsById = new Map(
    Object.entries(stopsPayload.stops_by_suburb || {})
  );

  return {
    summariesById,
    stopsById,
    source: 'generated',
    attribution: summaryPayload.attribution || 'Transport for NSW',
  };
}

function createTransportLookup(options = {}) {
  let bundle = options.bundle || null;

  function getBundle() {
    if (!bundle) bundle = loadTransportBundle();
    if (bundle.source === 'none' && fs.existsSync(SUMMARY_PATH)) {
      bundle = loadTransportBundle();
    }
    return bundle;
  }

  async function fromDatabase(supabase, suburb) {
    if (!supabase) return null;
    try {
      const { data: summary, error } = await supabase
        .from('suburb_transport_summary')
        .select('*')
        .eq('suburb_id', suburb.id)
        .maybeSingle();
      if (error) throw error;
      if (!summary) return null;

      const { data: stops, error: stopError } = await supabase
        .from('suburb_transport_stops')
        .select('distance_m, rank, stop:transport_stops(stop_id, stop_name, stop_lat, stop_lon, modes, route_count, is_major, wheelchair_boarding)')
        .eq('suburb_id', suburb.id)
        .order('rank')
        .limit(12);
      if (stopError) throw stopError;

      return {
        transport_summary: {
          nearest_stop_name: summary.nearest_stop_name,
          nearest_stop_distance_m: summary.nearest_stop_distance_m,
          nearest_major_stop_name: summary.nearest_major_stop_name,
          nearest_major_stop_modes: summary.nearest_major_stop_modes || [],
          nearest_major_stop_distance_m: summary.nearest_major_stop_distance_m,
          distance_basis: summary.distance_basis || 'Approximate distance from suburb centre',
          stops_within_500m: summary.stops_within_500m,
          stops_within_1km: summary.stops_within_1km,
          stops_within_2km: summary.stops_within_2km,
          stops_in_suburb: summary.stops_in_suburb,
          modes: summary.modes || [],
          route_count: summary.route_count,
          accessible_stop_count: summary.accessible_stop_count,
          attribution: summary.attribution || 'Transport for NSW',
          data_date: summary.data_date || '2026-07-21',
        },
        nearby_transport: (stops || []).map((row) => ({
          stop_id: row.stop?.stop_id,
          stop_name: row.stop?.stop_name,
          stop_lat: row.stop?.stop_lat,
          stop_lon: row.stop?.stop_lon,
          modes: row.stop?.modes || [],
          route_count: row.stop?.route_count || 0,
          distance_m: row.distance_m,
          is_major: Boolean(row.stop?.is_major),
          wheelchair_boarding: Boolean(row.stop?.wheelchair_boarding),
        })),
      };
    } catch {
      return null;
    }
  }

  return {
    async forSuburb(suburb, supabase = null) {
      if (!suburb) {
        return { transport_summary: null, nearby_transport: [] };
      }
      const dbHit = await fromDatabase(supabase, suburb);
      if (dbHit) return dbHit;

      const current = getBundle();
      const summary = current.summariesById.get(String(suburb.id));
      const nearby = current.stopsById.get(String(suburb.id)) || [];
      const transportSummary = summary?.transport_summary
        ? {
            ...summary.transport_summary,
            distance_basis: summary.transport_summary.distance_basis || 'Approximate distance from suburb centre',
            attribution: summary.transport_summary.attribution || 'Transport for NSW',
            data_date: summary.transport_summary.data_date || '2026-07-21',
          }
        : null;
      return {
        transport_summary: transportSummary,
        nearby_transport: nearby,
      };
    },
  };
}

module.exports = {
  createTransportLookup,
  loadTransportBundle,
};
