const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  normalizeSuburbName,
  isNswSalCode,
  isSpecialSalName,
  extractNswProfiles,
  matchProfilesToSuburbs,
  findProfileForSuburb,
  ABS_COLUMNS,
} = require('../scripts/lib/abs-census');
const { createApp } = require('../src/index');
const { createProfileLookup, shapeProfile } = require('../src/census-profiles');

function writeCsv(dir, name, headers, rows) {
  const body = [headers.join(',')].concat(rows.map((row) => headers.map((header) => row[header] ?? '').join(','))).join('\n');
  fs.writeFileSync(path.join(dir, name), body);
}

test('NSW SAL code filter keeps SAL1 and drops other states', () => {
  assert.equal(isNswSalCode('SAL13167'), true);
  assert.equal(isNswSalCode('SAL20001'), false);
  assert.equal(isSpecialSalName('No usual address (NSW)'), true);
  assert.equal(isSpecialSalName('Parramatta'), false);
});

test('name normalization strips punctuation, case and ABS parentheses', () => {
  assert.equal(normalizeSuburbName('Abbotsford (NSW)'), 'abbotsford');
  assert.equal(normalizeSuburbName('  Bondi-Junction  '), 'bondi-junction');
  assert.equal(normalizeSuburbName('Alison (Central Coast - NSW)'), 'alison');
  assert.equal(normalizeSuburbName("O'Connell"), "o'connell");
});

test('SAL joins extract verified ABS short-header columns', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abs-sal-'));
  writeCsv(dir, '2021Census_G01_AUST_SAL.csv', ['SAL_CODE_2021', 'Tot_P_P'], [
    { SAL_CODE_2021: 'SAL13167', Tot_P_P: '25700' },
  ]);
  writeCsv(dir, '2021Census_G02_AUST_SAL.csv', [
    'SAL_CODE_2021',
    'Median_age_persons',
    'Median_tot_hhd_inc_weekly',
    'Average_household_size',
    'Median_rent_weekly',
    'Median_mortgage_repay_monthly',
  ], [{
    SAL_CODE_2021: 'SAL13167',
    Median_age_persons: '34',
    Median_tot_hhd_inc_weekly: '1900',
    Average_household_size: '2.5',
    Median_rent_weekly: '480',
    Median_mortgage_repay_monthly: '2200',
  }]);
  writeCsv(dir, '2021Census_G36_AUST_SAL.csv', ['SAL_CODE_2021', 'OPDs_Tot_OPDs_Dwellings'], [
    { SAL_CODE_2021: 'SAL13167', OPDs_Tot_OPDs_Dwellings: '9000' },
  ]);
  writeCsv(dir, '2021Census_G37_AUST_SAL.csv', ['SAL_CODE_2021', 'O_OR_Total', 'O_MTG_Total', 'R_Tot_Total'], [
    { SAL_CODE_2021: 'SAL13167', O_OR_Total: '2000', O_MTG_Total: '3000', R_Tot_Total: '4000' },
  ]);

  const profiles = extractNswProfiles({
    salDir: dir,
    geographyRows: [{
      sal_code: 'SAL13167',
      suburb_name: 'Parramatta',
      suburb_name_normalized: 'parramatta',
    }],
  });

  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].population, 25700);
  assert.equal(profiles[0].median_weekly_rent, 480);
  assert.equal(profiles[0].owned_with_mortgage, 3000);
  assert.equal(ABS_COLUMNS.population.short, 'Tot_P_P');
  assert.equal(ABS_COLUMNS.rented_dwellings.file, 'G37');
});

test('ambiguous matching never silently chooses between multiple SAL candidates', () => {
  const profiles = [
    { sal_code: 'SAL10034', suburb_name: 'Alison (Central Coast - NSW)', suburb_name_normalized: 'alison' },
    { sal_code: 'SAL10035', suburb_name: 'Alison (Dungog - NSW)', suburb_name_normalized: 'alison' },
  ];
  const suburbs = [{ id: 1, suburb: 'Alison', postcode: '2420', region: 'Hunter' }];
  const report = matchProfilesToSuburbs(profiles, suburbs);
  assert.equal(report.totals.matched_links, 0);
  assert.equal(report.totals.ambiguous_groups, 1);
  assert.equal(findProfileForSuburb(profiles, suburbs[0], report), null);
});

test('unique name matches link suburbs to a single SAL profile', () => {
  const profiles = [
    { sal_code: 'SAL13167', suburb_name: 'Parramatta', suburb_name_normalized: 'parramatta', population: 100 },
  ];
  const suburbs = [
    { id: 'a', suburb: 'PARRAMATTA', postcode: '2150', region: 'GWS' },
    { id: 'b', suburb: 'Westmead', postcode: '2145', region: 'GWS' },
  ];
  const report = matchProfilesToSuburbs(profiles, suburbs);
  assert.equal(report.totals.matched_links, 1);
  assert.equal(report.matched[0].sal_code, 'SAL13167');
  assert.equal(findProfileForSuburb(profiles, suburbs[0], report).sal_code, 'SAL13167');
  assert.equal(findProfileForSuburb(profiles, suburbs[1], report), null);
});

test('profile API output includes census_profile when available', async () => {
  const profiles = [{
    sal_code: 'SAL13167',
    census_year: 2021,
    suburb_name: 'Parramatta',
    suburb_name_normalized: 'parramatta',
    population: 25700,
    median_age: 34,
    median_weekly_household_income: 1900,
    average_household_size: 2.5,
    occupied_private_dwellings: 9000,
    owned_outright: 2000,
    owned_with_mortgage: 3000,
    rented_dwellings: 4000,
    median_weekly_rent: 480,
    median_monthly_mortgage: 2200,
    source: 'ABS 2021 Census GCP',
  }];
  const matchReport = matchProfilesToSuburbs(profiles, [
    { id: 'sample-1', suburb: 'Parramatta', postcode: '2150', region: 'Sydney - Parramatta' },
  ]);
  const lookup = createProfileLookup({
    generated: { profiles, matchReport, source: 'test' },
  });
  const server = createApp({
    supabase: null,
    profileLookup: lookup,
  }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const detail = await (await fetch(`${baseUrl}/api/suburbs/sample-1`)).json();
    assert.equal(detail.suburb.suburb, 'Parramatta');
    assert.ok(detail.census_profile);
    assert.equal(detail.census_profile.population, 25700);
    assert.equal(detail.census_profile.attribution, 'ABS 2021 Census');
    assert.match(detail.census_profile.disclaimer, /not current market prices/i);

    const shaped = shapeProfile(profiles[0]);
    assert.equal(shaped.sal_code, 'SAL13167');
  } finally {
    server.close();
  }
});
