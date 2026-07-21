'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { normalizeSuburbName, findProfileForSuburb } = require('../scripts/lib/abs-census');

const GENERATED_PROFILES = path.join(__dirname, '../data/generated/nsw-suburb-profiles-2021.json');
const GENERATED_REPORT = path.join(__dirname, '../data/generated/nsw-suburb-profile-match-report.json');

function shapeProfile(profile) {
  if (!profile) return null;
  return {
    sal_code: profile.sal_code,
    census_year: profile.census_year || 2021,
    suburb_name: profile.suburb_name,
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
    source: profile.source || 'ABS 2021 Census GCP',
    attribution: 'ABS 2021 Census',
    disclaimer: 'Census rent and mortgage values are historical demographic indicators, not current market prices.',
  };
}

function loadGeneratedBundle() {
  if (!fs.existsSync(GENERATED_PROFILES)) {
    return { profiles: [], matchReport: null, source: 'none' };
  }
  const payload = JSON.parse(fs.readFileSync(GENERATED_PROFILES, 'utf8'));
  const matchReport = fs.existsSync(GENERATED_REPORT)
    ? JSON.parse(fs.readFileSync(GENERATED_REPORT, 'utf8'))
    : null;
  return {
    profiles: payload.profiles || [],
    matchReport,
    source: 'generated',
  };
}

function createProfileLookup(options = {}) {
  let generated = options.generated || null;
  let databaseProfiles = null;

  function getGenerated() {
    if (!generated) generated = loadGeneratedBundle();
    // If the process started before profiles were generated, reload once they appear.
    if (generated.source === 'none' && fs.existsSync(GENERATED_PROFILES)) {
      generated = loadGeneratedBundle();
    }
    return generated;
  }

  async function fromDatabase(supabase, suburb) {
    if (!supabase) return null;
    try {
      const key = normalizeSuburbName(suburb.suburb);
      const { data, error } = await supabase
        .from('suburb_profiles')
        .select('*')
        .eq('suburb_name_normalized', key)
        .limit(2);
      if (error) throw error;
      if (!data?.length) return null;
      if (data.length > 1) return null;
      return shapeProfile(data[0]);
    } catch {
      return null;
    }
  }

  return {
    async forSuburb(suburb, supabase = null) {
      if (!suburb) return null;
      const dbProfile = await fromDatabase(supabase, suburb);
      if (dbProfile) return dbProfile;

      const bundle = getGenerated();
      const profile = findProfileForSuburb(bundle.profiles, suburb, bundle.matchReport);
      return shapeProfile(profile);
    },
    async allFromDatabase(supabase) {
      if (!supabase) return null;
      if (databaseProfiles) return databaseProfiles;
      const rows = [];
      for (let start = 0; ; start += 1000) {
        const { data, error } = await supabase.from('suburb_profiles').select('*').range(start, start + 999);
        if (error) throw error;
        rows.push(...data);
        if (data.length < 1000) break;
      }
      databaseProfiles = rows;
      return rows;
    },
  };
}

module.exports = {
  createProfileLookup,
  shapeProfile,
  loadGeneratedBundle,
};
