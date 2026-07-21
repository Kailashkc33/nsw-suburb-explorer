const fs = require('node:fs');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const file = process.argv[2];
if (!file) throw new Error('Usage: npm run data:import -- path/to/suburbs.csv');
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for imports');
}
function parseLine(line) {
  const cells = []; let value = ''; let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"' && line[index + 1] === '"') { value += '"'; index += 1; }
    else if (char === '"') quoted = !quoted;
    else if (char === ',' && !quoted) { cells.push(value.trim()); value = ''; }
    else value += char;
  }
  cells.push(value.trim()); return cells;
}
const lines = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
const headers = parseLine(lines.shift()).map(value => value.toLowerCase());
const find = (row, names) => { const index = headers.findIndex(header => names.includes(header)); return index >= 0 ? row[index] : ''; };
const rows = lines.map(parseLine).map(row => ({
  suburb: find(row, ['suburb', 'locality', 'suburb_name', 'name']),
  postcode: find(row, ['postcode', 'post_code']),
  region: find(row, ['region', 'sa4_name', 'district']) || 'Other NSW'
})).filter(row => row.suburb && /^2\d{3}$/.test(row.postcode));
const unique = [...new Map(rows.map(row => [`${row.suburb}|${row.postcode}`, row])).values()];
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
(async () => {
  for (let index = 0; index < unique.length; index += 500) {
    const { error } = await supabase.from('suburbs').upsert(unique.slice(index, index + 500), { onConflict: 'suburb,postcode' });
    if (error) throw error;
  }
  console.log(`Imported ${unique.length} validated NSW suburb rows from ${file}`);
})().catch(error => { console.error(error.message); process.exitCode = 1; });
