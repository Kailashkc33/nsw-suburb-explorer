const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp, clean, rankSuburb } = require('../src/index');

let server;
let baseUrl;
test.before(async () => {
  server = createApp({ supabase: null }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

test('health reports fallback data is available', async () => {
  const response = await fetch(`${baseUrl}/api/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok', dataAvailable: true });
});
test('unified search finds suburb and postcode matches', async () => {
  const suburb = await (await fetch(`${baseUrl}/api/suburbs/search?query=Parramatta`)).json();
  const postcode = await (await fetch(`${baseUrl}/api/suburbs/search?query=2150`)).json();
  assert.equal(suburb.results[0].suburb, 'Parramatta');
  assert.ok(postcode.results.some(item => item.postcode === '2150'));
});
test('search validates short input', async () => {
  const response = await fetch(`${baseUrl}/api/suburbs/search?query=p`);
  assert.equal(response.status, 400);
});
test('region and detail endpoints return related suburbs', async () => {
  const region = await (await fetch(`${baseUrl}/api/suburbs/region/${encodeURIComponent('Sydney - Parramatta')}`)).json();
  const detail = await (await fetch(`${baseUrl}/api/suburbs/sample-1`)).json();
  assert.equal(region.suburbs.length, 3);
  assert.equal(detail.suburb.suburb, 'Parramatta');
  assert.ok(detail.nearby.length > 0);
  assert.ok('census_profile' in detail);
  assert.ok('transport_summary' in detail);
  assert.ok('nearby_transport' in detail);
});
test('query sanitising and ranking are deterministic', () => {
  assert.equal(clean('  Syd,ney(%)  '), 'Sydney');
  assert.ok(rankSuburb({ suburb: 'Sydney', postcode: '2000', region: 'City' }, 'Sydney') < rankSuburb({ suburb: 'North Sydney', postcode: '2060', region: 'City' }, 'Sydney'));
});
