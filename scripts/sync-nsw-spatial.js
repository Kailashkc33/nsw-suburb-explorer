const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const SOURCE = 'https://portal.spatial.nsw.gov.au/server/rest/services/NSW_Administrative_Boundaries_Theme/FeatureServer/2/query';
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
}

async function fetchPage(offset) {
  const params = new URLSearchParams({
    where: 'postcode IS NOT NULL',
    outFields: 'suburbname,postcode',
    returnGeometry: 'false',
    orderByFields: 'suburbname',
    resultOffset: String(offset),
    resultRecordCount: '2000',
    f: 'json'
  });
  const response = await fetch(`${SOURCE}?${params}`);
  if (!response.ok) throw new Error(`NSW Spatial Services returned HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.error) throw new Error(payload.error.message);
  return payload.features || [];
}

(async () => {
  const records = [];
  for (let offset = 0; ; offset += 2000) {
    const features = await fetchPage(offset);
    records.push(...features.map(({ attributes }) => ({
      suburb: String(attributes.suburbname).trim(),
      postcode: String(attributes.postcode),
      region: 'Other NSW'
    })));
    if (features.length < 2000) break;
  }
  const unique = [...new Map(records.map(row => [`${row.suburb}|${row.postcode}`, row])).values()];
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { count, error: countError } = await supabase.from('suburbs').select('*', { count: 'exact', head: true });
  if (countError) throw countError;
  const firstImport = process.argv.includes('--first-import') || Number(count) === 0;
  for (let index = 0; index < unique.length; index += 500) {
    const query = firstImport
      ? supabase.from('suburbs').insert(unique.slice(index, index + 500))
      : supabase.from('suburbs').upsert(unique.slice(index, index + 500), { onConflict: 'suburb,postcode' });
    const { error } = await query;
    if (error) throw error;
    console.log(`Synced ${Math.min(index + 500, unique.length)} of ${unique.length}`);
  }
  console.log(`Complete: ${unique.length} official NSW suburb/postcode records synced.`);
})().catch(error => { console.error(error.message || error); process.exitCode = 1; });
