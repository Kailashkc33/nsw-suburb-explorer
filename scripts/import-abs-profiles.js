#!/usr/bin/env node
'use strict';

/**
 * ABS 2021 Census SAL suburb-profile import / transformation.
 *
 * Default behaviour is dry-run safe:
 *   - reads the local DataPack
 *   - writes NSW profiles + match report under data/generated/
 *   - does NOT write to Supabase unless --apply is passed
 *
 * Usage:
 *   npm run data:abs-profiles -- [--datapack /path/to/pack] [--apply]
 */

const fs = require('node:fs');
const path = require('node:path');
const { createClient } = require('@supabase/supabase-js');
const XLSX = require('xlsx');
require('dotenv').config();

const {
  ABS_COLUMNS,
  CENSUS_YEAR,
  SOURCE_LABEL,
  loadNswSalGeography,
  extractNswProfiles,
  matchProfilesToSuburbs,
} = require('./lib/abs-census');

const ROOT = path.join(__dirname, '..');
const DEFAULT_DATAPACK = '/Users/kailashkc/Downloads/2021_GCP_all_for_AUS_short-header';
const OUT_DIR = path.join(ROOT, 'data', 'generated');

function parseArgs(argv) {
  const options = {
    datapack: process.env.ABS_DATAPACK_PATH || DEFAULT_DATAPACK,
    apply: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--datapack') options.datapack = argv[++index];
    else if (arg === '--help' || arg === '-h') options.help = true;
  }
  return options;
}

function resolvePackPaths(datapackRoot) {
  const salDir = path.join(datapackRoot, '2021 Census GCP All Geographies for AUS', 'SAL', 'AUS');
  const geog = path.join(datapackRoot, 'Metadata', '2021Census_geog_desc_1st_2nd_3rd_release.xlsx');
  if (!fs.existsSync(salDir)) throw new Error(`SAL directory not found: ${salDir}`);
  if (!fs.existsSync(geog)) throw new Error(`Geography descriptor not found: ${geog}`);
  return { salDir, geog };
}

async function loadExistingSuburbs(supabase) {
  if (!supabase) {
    const sample = require(path.join(ROOT, 'data', 'suburbs.sample.json'));
    console.warn('No Supabase client configured; matching against sample suburbs only.');
    return sample;
  }
  const rows = [];
  for (let start = 0; ; start += 1000) {
    const { data, error } = await supabase
      .from('suburbs')
      .select('id, suburb, postcode, region')
      .range(start, start + 999);
    if (error) throw error;
    rows.push(...data);
    if (data.length < 1000) break;
  }
  return rows;
}

function createSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '').trim();
  if (!url || !key) return null;
  return createClient(url, key);
}

async function applyProfiles(supabase, profiles) {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()) {
    throw new Error('--apply requires SUPABASE_SERVICE_ROLE_KEY');
  }
  const payload = profiles.map((profile) => ({
    sal_code: profile.sal_code,
    census_year: profile.census_year,
    suburb_name: profile.suburb_name,
    suburb_name_normalized: profile.suburb_name_normalized,
    population: profile.population,
    median_age: profile.median_age,
    median_weekly_household_income: profile.median_weekly_household_income,
    average_household_size: profile.average_household_size,
    occupied_private_dwellings: profile.occupied_private_dwellings,
    owned_outright: profile.owned_outright,
    owned_with_mortgage: profile.owned_with_mortgage,
    rented_dwellings: profile.rented_dwellings,
    median_weekly_rent: profile.median_weekly_rent,
    median_monthly_mortgage: profile.median_monthly_mortgage,
    source: profile.source,
    updated_at: new Date().toISOString(),
  }));

  for (let index = 0; index < payload.length; index += 500) {
    const chunk = payload.slice(index, index + 500);
    const { error } = await supabase.from('suburb_profiles').upsert(chunk, { onConflict: 'sal_code' });
    if (error) throw error;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(`Usage: node scripts/import-abs-profiles.js [--datapack PATH] [--apply]

Writes NSW ABS 2021 suburb profiles and a match report to data/generated/.
Does not modify Supabase unless --apply is provided.`);
    return;
  }

  const { salDir, geog } = resolvePackPaths(options.datapack);
  fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log('Loading NSW SAL geography…');
  const geographyRows = loadNswSalGeography(geog, XLSX);
  console.log(`NSW SAL localities (excluding special areas): ${geographyRows.length}`);

  console.log('Extracting metrics from G01 / G02 / G36 / G37…');
  const profiles = extractNswProfiles({ salDir, geographyRows });

  const supabase = createSupabase();
  const suburbs = await loadExistingSuburbs(supabase);
  console.log(`Matching against ${suburbs.length} suburb rows…`);
  // No reliable SAL↔POA correspondence ships in this DataPack, so postcode is unused.
  const matchReport = matchProfilesToSuburbs(profiles, suburbs, { postcodeCorrespondence: null });

  const generatedAt = new Date().toISOString();
  const profilesPath = path.join(OUT_DIR, 'nsw-suburb-profiles-2021.json');
  const csvPath = path.join(OUT_DIR, 'nsw-suburb-profiles-2021.csv');
  const reportPath = path.join(OUT_DIR, 'nsw-suburb-profile-match-report.json');
  const columnsPath = path.join(OUT_DIR, 'abs-source-columns.json');

  const compactProfiles = {
    census_year: CENSUS_YEAR,
    source: SOURCE_LABEL,
    generated_at: generatedAt,
    count: profiles.length,
    profiles,
  };

  fs.writeFileSync(profilesPath, JSON.stringify(compactProfiles));
  fs.writeFileSync(reportPath, JSON.stringify({ generated_at: generatedAt, ...matchReport }, null, 2));
  fs.writeFileSync(columnsPath, JSON.stringify(ABS_COLUMNS, null, 2));

  const csvHeaders = [
    'sal_code',
    'census_year',
    'suburb_name',
    'suburb_name_normalized',
    'population',
    'median_age',
    'median_weekly_household_income',
    'average_household_size',
    'occupied_private_dwellings',
    'owned_outright',
    'owned_with_mortgage',
    'rented_dwellings',
    'median_weekly_rent',
    'median_monthly_mortgage',
    'source',
  ];
  const csvLines = [csvHeaders.join(',')];
  for (const profile of profiles) {
    csvLines.push(csvHeaders.map((key) => {
      const value = profile[key];
      if (value === null || value === undefined) return '';
      const text = String(value);
      return /["\n,]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    }).join(','));
  }
  fs.writeFileSync(csvPath, csvLines.join('\n'));

  console.log('\nMatch-quality totals');
  console.log(JSON.stringify(matchReport.totals, null, 2));
  console.log(`\nWrote:\n  ${profilesPath}\n  ${csvPath}\n  ${reportPath}\n  ${columnsPath}`);

  if (options.apply) {
    console.log('\nApplying upserts to suburb_profiles (--apply)…');
    await applyProfiles(supabase, profiles);
    console.log(`Upserted ${profiles.length} suburb_profiles rows.`);
  } else {
    console.log('\nDry run only. Pass --apply after reviewing schema/match totals to upsert into Supabase.');
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
