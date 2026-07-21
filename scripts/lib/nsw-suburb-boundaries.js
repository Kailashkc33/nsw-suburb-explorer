'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  polygonCentroid,
  ringBBox,
} = require('./gtfs-transport');

const NSW_SUBURB_LAYER = 'https://portal.spatial.nsw.gov.au/server/rest/services/NSW_Administrative_Boundaries_Theme/FeatureServer/2/query';

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`NSW Spatial HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.error) throw new Error(payload.error.message || JSON.stringify(payload.error));
  return payload;
}

/**
 * Download simplified NSW suburb polygons (WGS84) for point-in-polygon matching.
 * Uses maxAllowableOffset to keep geometry compact for preprocessing.
 */
async function downloadSuburbBoundaries({
  cachePath = null,
  pageSize = 400,
  maxAllowableOffset = 0.0008,
} = {}) {
  if (cachePath && fs.existsSync(cachePath)) {
    return JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  }

  const boundaries = [];
  for (let offset = 0; ; offset += pageSize) {
    const params = new URLSearchParams({
      where: "postcode IS NOT NULL AND suburbname IS NOT NULL",
      outFields: 'suburbname,postcode',
      returnGeometry: 'true',
      outSR: '4326',
      maxAllowableOffset: String(maxAllowableOffset),
      resultOffset: String(offset),
      resultRecordCount: String(pageSize),
      orderByFields: 'suburbname',
      f: 'json',
    });
    const payload = await fetchJson(`${NSW_SUBURB_LAYER}?${params}`);
    const features = payload.features || [];
    for (const feature of features) {
      const name = String(feature.attributes?.suburbname || '').trim();
      const postcode = String(feature.attributes?.postcode || '').trim();
      const rings = feature.geometry?.rings;
      if (!name || !postcode || !rings?.length) continue;
      const centroid = polygonCentroid(rings);
      boundaries.push({
        suburb_name: name,
        postcode,
        rings,
        bbox: ringBBox(rings),
        centroid,
      });
    }
    if (features.length < pageSize) break;
  }

  const bundle = {
    source: NSW_SUBURB_LAYER,
    downloaded_at: new Date().toISOString(),
    count: boundaries.length,
    strategy: 'point_in_polygon_simplified_polygons',
    limitation: 'Polygons are simplified with maxAllowableOffset for preprocessing performance. Distance bands still use polygon centroids.',
    boundaries,
  };

  if (cachePath) {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(bundle));
  }
  return bundle;
}

function indexBoundariesByNamePostcode(boundaries) {
  const map = new Map();
  for (const boundary of boundaries) {
    const key = `${boundary.suburb_name.toLocaleLowerCase('en-AU')}|${boundary.postcode}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(boundary);
  }
  return map;
}

function findBoundaryForSuburb(suburb, boundaryIndex) {
  const key = `${String(suburb.suburb).toLocaleLowerCase('en-AU')}|${String(suburb.postcode)}`;
  const hits = boundaryIndex.get(key) || [];
  if (hits.length === 1) return { status: 'matched', boundary: hits[0] };
  if (hits.length > 1) return { status: 'ambiguous', boundaries: hits };
  // fallback: unique name-only match
  const nameKey = String(suburb.suburb).toLocaleLowerCase('en-AU');
  const nameHits = [];
  for (const [mapKey, list] of boundaryIndex) {
    if (mapKey.startsWith(`${nameKey}|`)) nameHits.push(...list);
  }
  if (nameHits.length === 1) return { status: 'matched_name_only', boundary: nameHits[0] };
  if (nameHits.length > 1) return { status: 'ambiguous_name', boundaries: nameHits };
  return { status: 'unmatched' };
}

module.exports = {
  NSW_SUBURB_LAYER,
  downloadSuburbBoundaries,
  indexBoundariesByNamePostcode,
  findBoundaryForSuburb,
};
