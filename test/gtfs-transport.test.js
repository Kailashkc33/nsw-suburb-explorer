const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseCsvLine,
  mapRouteType,
  haversineMetres,
  pointInPolygon,
  dedupeStopsByParent,
  buildSuburbSpatialIndex,
  matchStopToSuburb,
  summarizeSuburbTransport,
  buildStopDistanceIndex,
} = require('../scripts/lib/gtfs-transport');
const { createApp } = require('../src/index');
const { createTransportLookup } = require('../src/transport-lookup');

test('GTFS CSV parsing keeps quoted commas', () => {
  const cells = parseCsvLine('"Central Station, Forecourt","-33.88","151.20"');
  assert.equal(cells[0], 'Central Station, Forecourt');
  assert.equal(cells[1], '-33.88');
});

test('route_type mapping covers TfNSW extended modes', () => {
  assert.equal(mapRouteType(2), 'Train');
  assert.equal(mapRouteType(4), 'Ferry');
  assert.equal(mapRouteType(401), 'Metro');
  assert.equal(mapRouteType(700), 'Bus');
  assert.equal(mapRouteType(712), 'Bus');
  assert.equal(mapRouteType(900), 'Light Rail');
  assert.equal(mapRouteType(204), 'Coach');
  assert.equal(mapRouteType(9999), 'Other');
});

test('parent-station deduplication collapses platforms', () => {
  const stops = [
    { stop_id: 'S1', stop_name: 'Station', stop_lat: '-33.8', stop_lon: '151.2', location_type: '1', parent_station: '', wheelchair_boarding: '1' },
    { stop_id: 'P1', stop_name: 'Platform 1', stop_lat: '-33.8001', stop_lon: '151.2001', location_type: '0', parent_station: 'S1', wheelchair_boarding: '0' },
    { stop_id: 'P2', stop_name: 'Platform 2', stop_lat: '-33.8002', stop_lon: '151.2002', location_type: '0', parent_station: 'S1', wheelchair_boarding: '0' },
  ];
  const canonical = dedupeStopsByParent(stops);
  assert.equal(canonical.length, 1);
  assert.equal(canonical[0].stop_id, 'S1');
  assert.equal(canonical[0].platform_members.length, 3);
  assert.equal(canonical[0].wheelchair_boarding, '1');
});

test('distance calculation is symmetric and sane for short hops', () => {
  const metres = haversineMetres(-33.8688, 151.2093, -33.8700, 151.2093);
  assert.ok(metres > 100 && metres < 200);
  assert.equal(Math.round(haversineMetres(-33.8, 151.2, -33.8, 151.2)), 0);
});

test('point-in-polygon and ambiguous suburb matching', () => {
  const square = {
    suburb_name: 'Testville',
    postcode: '2000',
    rings: [[[151.0, -34.0], [151.2, -34.0], [151.2, -33.8], [151.0, -33.8], [151.0, -34.0]]],
    bbox: { minLon: 151.0, minLat: -34.0, maxLon: 151.2, maxLat: -33.8 },
    centroid: { lon: 151.1, lat: -33.9 },
  };
  assert.equal(pointInPolygon(151.1, -33.9, square.rings), true);
  assert.equal(pointInPolygon(151.5, -33.9, square.rings), false);

  const index = buildSuburbSpatialIndex([square, {
    ...square,
    suburb_name: 'Overlap',
    postcode: '2001',
  }]);
  const matched = matchStopToSuburb({ stop_id: '1', stop_lat: -33.9, stop_lon: 151.1 }, index);
  assert.equal(matched.status, 'ambiguous');

  const unmatched = matchStopToSuburb({ stop_id: '2', stop_lat: -30.0, stop_lon: 140.0 }, buildSuburbSpatialIndex([square]));
  assert.equal(unmatched.status, 'unmatched');
});

test('stop → trip → route join style aggregation via summarize output', () => {
  const stops = [{
    stop_id: 'S1',
    stop_name: 'Northmead Station',
    stop_lat: -33.783,
    stop_lon: 150.998,
    modes: ['Train', 'Bus'],
    route_ids: ['R1', 'R2'],
    is_major: true,
    wheelchair_boarding: '1',
    platform_count: 2,
  }, {
    stop_id: 'B1',
    stop_name: 'Bus stop',
    stop_lat: -33.784,
    stop_lon: 150.999,
    modes: ['Bus'],
    route_ids: ['R2'],
    is_major: false,
    wheelchair_boarding: '0',
    platform_count: 1,
  }];
  const stopIndex = buildStopDistanceIndex(stops);
  const result = summarizeSuburbTransport({
    suburb: { id: 1, suburb: 'Northmead', postcode: '2152' },
    centroid: { lat: -33.7835, lon: 150.9985 },
    memberStops: stops,
    stopIndex,
  });
  assert.ok(result.transport_summary);
  assert.equal(result.transport_summary.route_count, 2);
  assert.ok(result.transport_summary.modes.includes('Train'));
  assert.ok(result.nearby_transport.length >= 1);
  assert.equal(result.nearby_transport[0].is_major, true);
});

test('API returns transport fields and graceful missing state', async () => {
  const transportLookup = {
    async forSuburb() {
      return { transport_summary: null, nearby_transport: [] };
    },
  };
  const server = createApp({ supabase: null, transportLookup }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const detail = await (await fetch(`${baseUrl}/api/suburbs/sample-1`)).json();
    assert.equal(detail.suburb.suburb, 'Parramatta');
    assert.ok('transport_summary' in detail);
    assert.ok('nearby_transport' in detail);
    assert.equal(detail.transport_summary, null);
    assert.deepEqual(detail.nearby_transport, []);
  } finally {
    server.close();
  }
});

test('transport lookup reads generated bundle when present', () => {
  const lookup = createTransportLookup({
    bundle: {
      source: 'test',
      summariesById: new Map([['9', {
        suburb_id: 9,
        transport_summary: {
          nearest_major_stop_name: 'Test Station',
          nearest_major_stop_distance_m: 120,
          modes: ['Train'],
          route_count: 3,
          stops_within_500m: 1,
          stops_within_1km: 2,
          stops_within_2km: 4,
          stops_in_suburb: 1,
          accessible_stop_count: 1,
          attribution: 'Transport for NSW',
        },
      }]]),
      stopsById: new Map([['9', [{ stop_id: 'S', stop_name: 'Test Station', distance_m: 120, is_major: true, modes: ['Train'] }]]]),
    },
  });
  return lookup.forSuburb({ id: 9, suburb: 'Test' }).then((result) => {
    assert.equal(result.transport_summary.nearest_major_stop_name, 'Test Station');
    assert.equal(result.nearby_transport.length, 1);
  });
});
