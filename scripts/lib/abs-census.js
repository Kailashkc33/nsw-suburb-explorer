'use strict';

const fs = require('node:fs');
const path = require('node:path');

const CENSUS_YEAR = 2021;
const SOURCE_LABEL = 'ABS 2021 Census GCP';

/** Column map verified against Metadata_2021_GCP_DataPack_R1_R2.xlsx Cell Descriptors. */
const ABS_COLUMNS = Object.freeze({
  population: {
    file: 'G01',
    short: 'Tot_P_P',
    long: 'Total_Persons_Persons',
    label: 'Persons',
  },
  median_age: {
    file: 'G02',
    short: 'Median_age_persons',
    long: 'Median_age_of_persons',
    label: 'Median age of persons',
  },
  median_weekly_household_income: {
    file: 'G02',
    short: 'Median_tot_hhd_inc_weekly',
    long: 'Median_total_household_income_weekly',
    label: 'Median total household income ($/weekly)',
  },
  average_household_size: {
    file: 'G02',
    short: 'Average_household_size',
    long: 'Average_household_size',
    label: 'Average household size',
  },
  median_weekly_rent: {
    file: 'G02',
    short: 'Median_rent_weekly',
    long: 'Median_rent_weekly',
    label: 'Median rent ($/weekly)',
  },
  median_monthly_mortgage: {
    file: 'G02',
    short: 'Median_mortgage_repay_monthly',
    long: 'Median_mortgage_repayment_monthly',
    label: 'Median mortgage repayment ($/monthly)',
  },
  occupied_private_dwellings: {
    file: 'G36',
    short: 'OPDs_Tot_OPDs_Dwellings',
    long: 'Occupied_private_dwellings_Total_occupied_private_dwellings_Dwellings',
    label: 'Occupied private dwellings (dwellings)',
  },
  owned_outright: {
    file: 'G37',
    short: 'O_OR_Total',
    long: 'Owned_outright_Total',
    label: 'Owned outright total',
  },
  owned_with_mortgage: {
    file: 'G37',
    short: 'O_MTG_Total',
    long: 'Owned_with_a_mortgage_Total',
    label: 'Owned with a mortgage total',
  },
  rented_dwellings: {
    file: 'G37',
    short: 'R_Tot_Total',
    long: 'Rented_Total_Total',
    label: 'Rented total',
  },
});

const SPECIAL_SAL_EXCLUSIONS = new Set([
  'no usual address',
  'migratory - offshore - shipping',
]);

function parseCsvLine(line) {
  const cells = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"' && line[index + 1] === '"') {
      value += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === ',' && !quoted) {
      cells.push(value);
      value = '';
    } else {
      value += char;
    }
  }
  cells.push(value);
  return cells;
}

function readCsvObjects(filePath) {
  const text = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const headers = parseCsvLine(lines.shift());
  return lines.map((line) => {
    const cells = parseCsvLine(line);
    const row = {};
    headers.forEach((header, index) => {
      row[header] = cells[index] ?? '';
    });
    return row;
  });
}

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return number;
}

/**
 * Normalize suburb / SAL names for case-insensitive matching.
 * Strips trailing ABS state/disambiguation parentheses, punctuation, and extra spaces.
 */
function normalizeSuburbName(value) {
  return String(value || '')
    .toLocaleLowerCase('en-AU')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isSpecialSalName(name) {
  const normalized = normalizeSuburbName(name);
  return SPECIAL_SAL_EXCLUSIONS.has(normalized) || /no usual address|migratory|offshore|shipping/i.test(String(name || ''));
}

function isNswSalCode(code) {
  return /^SAL1\d+$/i.test(String(code || ''));
}

function loadNswSalGeography(geogWorkbookPath, xlsx) {
  const workbook = xlsx.readFile(geogWorkbookPath);
  const sheet = workbook.Sheets['2021_ASGS_Non_ABS_Structures'];
  if (!sheet) throw new Error('Missing sheet 2021_ASGS_Non_ABS_Structures in geography descriptor');
  const rows = xlsx.utils.sheet_to_json(sheet, { defval: null });
  return rows
    .filter((row) => row.ASGS_Structure === 'SAL')
    .filter((row) => isNswSalCode(row.Census_Code_2021))
    .filter((row) => !isSpecialSalName(row.Census_Name_2021))
    .map((row) => ({
      sal_code: String(row.Census_Code_2021),
      suburb_name: String(row.Census_Name_2021),
      suburb_name_normalized: normalizeSuburbName(row.Census_Name_2021),
      area_sqkm: toNumber(row['Area sqkm']),
    }));
}

function indexBySal(rows, codeField = 'SAL_CODE_2021') {
  const map = new Map();
  for (const row of rows) {
    map.set(String(row[codeField]), row);
  }
  return map;
}

function resolveSalCsvPath(salDir, tableCode) {
  const expected = path.join(salDir, `2021Census_${tableCode}_AUST_SAL.csv`);
  if (!fs.existsSync(expected)) {
    throw new Error(`Missing ABS SAL file for ${tableCode}: ${expected}`);
  }
  return expected;
}

function extractNswProfiles({ salDir, geographyRows }) {
  const g01 = indexBySal(readCsvObjects(resolveSalCsvPath(salDir, 'G01')));
  const g02 = indexBySal(readCsvObjects(resolveSalCsvPath(salDir, 'G02')));
  const g36 = indexBySal(readCsvObjects(resolveSalCsvPath(salDir, 'G36')));
  const g37 = indexBySal(readCsvObjects(resolveSalCsvPath(salDir, 'G37')));

  const requiredShortNames = Object.values(ABS_COLUMNS).map((item) => item.short);
  const sample = g01.values().next().value || {};
  const sample2 = g02.values().next().value || {};
  const sample36 = g36.values().next().value || {};
  const sample37 = g37.values().next().value || {};
  const available = new Set([
    ...Object.keys(sample),
    ...Object.keys(sample2),
    ...Object.keys(sample36),
    ...Object.keys(sample37),
  ]);
  const missing = requiredShortNames.filter((name) => !available.has(name));
  if (missing.length) {
    throw new Error(`ABS short-header columns missing from SAL CSVs: ${missing.join(', ')}`);
  }

  return geographyRows.map((geo) => {
    const row01 = g01.get(geo.sal_code) || {};
    const row02 = g02.get(geo.sal_code) || {};
    const row36 = g36.get(geo.sal_code) || {};
    const row37 = g37.get(geo.sal_code) || {};
    return {
      sal_code: geo.sal_code,
      census_year: CENSUS_YEAR,
      suburb_name: geo.suburb_name,
      suburb_name_normalized: geo.suburb_name_normalized,
      population: toNumber(row01.Tot_P_P),
      median_age: toNumber(row02.Median_age_persons),
      median_weekly_household_income: toNumber(row02.Median_tot_hhd_inc_weekly),
      average_household_size: toNumber(row02.Average_household_size),
      occupied_private_dwellings: toNumber(row36.OPDs_Tot_OPDs_Dwellings),
      owned_outright: toNumber(row37.O_OR_Total),
      owned_with_mortgage: toNumber(row37.O_MTG_Total),
      rented_dwellings: toNumber(row37.R_Tot_Total),
      median_weekly_rent: toNumber(row02.Median_rent_weekly),
      median_monthly_mortgage: toNumber(row02.Median_mortgage_repay_monthly),
      source: SOURCE_LABEL,
    };
  });
}

/**
 * Match census profiles to existing suburb rows.
 * Postcode is not used unless a correspondence map is supplied (none in this DataPack).
 * Never silently picks among multiple SAL candidates for the same normalized name.
 */
function matchProfilesToSuburbs(profiles, suburbs, options = {}) {
  const postcodeCorrespondence = options.postcodeCorrespondence || null;
  const profilesByName = new Map();
  for (const profile of profiles) {
    const key = profile.suburb_name_normalized;
    if (!profilesByName.has(key)) profilesByName.set(key, []);
    profilesByName.get(key).push(profile);
  }

  const suburbsByName = new Map();
  for (const suburb of suburbs) {
    const key = normalizeSuburbName(suburb.suburb);
    if (!suburbsByName.has(key)) suburbsByName.set(key, []);
    suburbsByName.get(key).push(suburb);
  }

  const matched = [];
  const unmatchedSuburbs = [];
  const ambiguous = [];
  const matchedSuburbIds = new Set();
  const matchedSalCodes = new Set();

  for (const [name, suburbGroup] of suburbsByName) {
    let candidates = profilesByName.get(name) || [];

    if (postcodeCorrespondence && candidates.length > 1) {
      const narrowed = [];
      for (const suburb of suburbGroup) {
        const allowed = postcodeCorrespondence.get(String(suburb.postcode));
        if (!allowed) continue;
        for (const profile of candidates) {
          if (allowed.has(profile.sal_code)) narrowed.push({ suburb, profile });
        }
      }
      if (narrowed.length === 1) {
        const { suburb, profile } = narrowed[0];
        matched.push({
          suburb_id: suburb.id,
          suburb: suburb.suburb,
          postcode: suburb.postcode,
          sal_code: profile.sal_code,
          census_name: profile.suburb_name,
          quality: 'matched_postcode',
        });
        matchedSuburbIds.add(String(suburb.id));
        matchedSalCodes.add(profile.sal_code);
        continue;
      }
      if (narrowed.length > 1) {
        ambiguous.push({
          name,
          reason: 'multiple_postcode_correspondence_hits',
          suburbs: suburbGroup.map((item) => ({ id: item.id, suburb: item.suburb, postcode: item.postcode })),
          profiles: candidates.map((item) => ({ sal_code: item.sal_code, suburb_name: item.suburb_name })),
        });
        continue;
      }
    }

    if (candidates.length === 0) {
      unmatchedSuburbs.push(...suburbGroup.map((item) => ({
        id: item.id,
        suburb: item.suburb,
        postcode: item.postcode,
        reason: 'no_sal_name_match',
      })));
      continue;
    }

    if (candidates.length > 1) {
      ambiguous.push({
        name,
        reason: 'multiple_sal_candidates',
        suburbs: suburbGroup.map((item) => ({ id: item.id, suburb: item.suburb, postcode: item.postcode })),
        profiles: candidates.map((item) => ({ sal_code: item.sal_code, suburb_name: item.suburb_name })),
      });
      continue;
    }

    const profile = candidates[0];
    for (const suburb of suburbGroup) {
      matched.push({
        suburb_id: suburb.id,
        suburb: suburb.suburb,
        postcode: suburb.postcode,
        sal_code: profile.sal_code,
        census_name: profile.suburb_name,
        quality: 'matched_name',
      });
      matchedSuburbIds.add(String(suburb.id));
      matchedSalCodes.add(profile.sal_code);
    }
  }

  const unmatchedProfiles = profiles.filter((profile) => !matchedSalCodes.has(profile.sal_code));

  return {
    totals: {
      profiles: profiles.length,
      suburbs: suburbs.length,
      matched_links: matched.length,
      matched_unique_suburbs: matchedSuburbIds.size,
      matched_unique_sal: matchedSalCodes.size,
      unmatched_suburbs: unmatchedSuburbs.length,
      unmatched_profiles: unmatchedProfiles.length,
      ambiguous_groups: ambiguous.length,
    },
    matched,
    unmatched_suburbs: unmatchedSuburbs,
    unmatched_profiles: unmatchedProfiles.map((item) => ({
      sal_code: item.sal_code,
      suburb_name: item.suburb_name,
    })),
    ambiguous,
    postcode_correspondence_available: Boolean(postcodeCorrespondence),
  };
}

function findProfileForSuburb(profiles, suburb, matchReport = null) {
  if (!suburb) return null;
  if (matchReport?.matched?.length) {
    const link = matchReport.matched.find((item) => String(item.suburb_id) === String(suburb.id));
    if (link) return profiles.find((profile) => profile.sal_code === link.sal_code) || null;
    const ambiguousHit = matchReport.ambiguous?.some((group) => group.suburbs.some((item) => String(item.id) === String(suburb.id)));
    if (ambiguousHit) return null;
  }

  const key = normalizeSuburbName(suburb.suburb);
  const candidates = profiles.filter((profile) => profile.suburb_name_normalized === key);
  if (candidates.length === 1) return candidates[0];
  return null;
}

module.exports = {
  ABS_COLUMNS,
  CENSUS_YEAR,
  SOURCE_LABEL,
  parseCsvLine,
  readCsvObjects,
  toNumber,
  normalizeSuburbName,
  isSpecialSalName,
  isNswSalCode,
  loadNswSalGeography,
  extractNswProfiles,
  matchProfilesToSuburbs,
  findProfileForSuburb,
};
