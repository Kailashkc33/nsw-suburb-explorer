const express = require('express');
const cors = require('cors');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const fallbackSuburbs = require('../data/suburbs.sample.json');
const { createProfileLookup } = require('./census-profiles');
const { createTransportLookup } = require('./transport-lookup');
require('dotenv').config();

const publicPath = path.join(__dirname, '../public');
const clean = value => String(value || '').trim().replace(/[,%()']/g, '').slice(0, 80);
const normalise = value => String(value || '').toLocaleLowerCase('en-AU');

function rankSuburb(item, query) {
  const q = normalise(query);
  const name = normalise(item.suburb);
  const postcode = String(item.postcode);
  if (name === q || postcode === q) return 0;
  if (name.startsWith(q) || postcode.startsWith(q)) return 1;
  if (normalise(item.region).startsWith(q)) return 2;
  return 3;
}

function createDataSource(supabase, profileLookup = createProfileLookup(), transportLookup = createTransportLookup()) {
  async function fromDatabase(builder) {
    if (!supabase) return null;
    const { data, error, count } = await builder(supabase);
    if (error) throw error;
    return { data, count };
  }

  async function allDatabaseRows(builder) {
    if (!supabase) return null;
    const rows = [];
    for (let start = 0; ; start += 1000) {
      const { data, error } = await builder(supabase).range(start, start + 999);
      if (error) throw error;
      rows.push(...data);
      if (data.length < 1000) return rows;
    }
  }

  return {
    async all(page = 1, limit = 24) {
      const start = (page - 1) * limit;
      const result = await fromDatabase(db => db.from('suburbs')
        .select('id, region, suburb, postcode', { count: 'exact' })
        .order('suburb').range(start, start + limit - 1));
      if (result?.data?.length) return { ...result, source: 'database' };
      return { data: fallbackSuburbs.slice(start, start + limit), count: fallbackSuburbs.length, source: 'sample' };
    },
    async search(query, limit = 12) {
      const safeQuery = clean(query);
      const result = await fromDatabase(db => db.from('suburbs')
        .select('id, region, suburb, postcode')
        .or(`suburb.ilike.%${safeQuery}%,postcode.ilike.%${safeQuery}%,region.ilike.%${safeQuery}%`)
        .limit(limit));
      const source = result?.data?.length ? result.data : fallbackSuburbs.filter(item =>
        [item.suburb, item.postcode, item.region].some(value => normalise(value).includes(normalise(safeQuery)))
      );
      return source.sort((a, b) => rankSuburb(a, safeQuery) - rankSuburb(b, safeQuery) || a.suburb.localeCompare(b.suburb)).slice(0, limit);
    },
    async regions() {
      const databaseRows = await allDatabaseRows(db => db.from('suburbs').select('region').order('id'));
      const rows = databaseRows?.length ? databaseRows : fallbackSuburbs;
      const counts = rows.reduce((map, row) => map.set(row.region, (map.get(row.region) || 0) + 1), new Map());
      return [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name));
    },
    async byRegion(region) {
      const safeRegion = clean(region);
      const databaseRows = await allDatabaseRows(db => db.from('suburbs')
        .select('id, region, suburb, postcode').ilike('region', safeRegion).order('suburb'));
      return databaseRows?.length ? databaseRows : fallbackSuburbs.filter(item => normalise(item.region) === normalise(safeRegion));
    },
    async byId(id) {
      if (supabase && /^\d+$/.test(String(id))) {
        const result = await fromDatabase(db => db.from('suburbs').select('id, region, suburb, postcode').eq('id', id).maybeSingle());
        if (result?.data) return result.data;
      }
      return fallbackSuburbs.find(item => String(item.id) === String(id)) || null;
    },
    async profileFor(suburb) {
      return profileLookup.forSuburb(suburb, supabase);
    },
    async transportFor(suburb) {
      return transportLookup.forSuburb(suburb, supabase);
    }
  };
}

function createApp(options = {}) {
  const app = express();
  const suppliedClient = Object.prototype.hasOwnProperty.call(options, 'supabase') ? options.supabase : undefined;
  const supabase = suppliedClient !== undefined ? suppliedClient : (
    process.env.SUPABASE_URL && (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY)
      ? createClient(process.env.SUPABASE_URL, (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY).trim())
      : null
  );
  const profileLookup = options.profileLookup || createProfileLookup(options);
  const transportLookup = options.transportLookup || createTransportLookup(options);
  const dataSource = options.dataSource || createDataSource(supabase, profileLookup, transportLookup);

  app.disable('x-powered-by');
  app.use(cors({ origin: process.env.CORS_ORIGIN || true }));
  app.use(express.json({ limit: '20kb' }));
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });

  const api = express.Router();
  api.get('/health', async (_req, res) => {
    try {
      const regions = await dataSource.regions();
      res.json({ status: 'ok', dataAvailable: regions.length > 0 });
    } catch (error) {
      res.status(503).json({ status: 'degraded', error: 'Data service unavailable' });
    }
  });
  api.get('/suburbs', async (req, res, next) => {
    try {
      const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
      const limit = Math.min(50, Math.max(1, Number.parseInt(req.query.limit, 10) || 24));
      const result = await dataSource.all(page, limit);
      res.json({ data: result.data, source: result.source, pagination: { total: result.count, page, limit, totalPages: Math.ceil(result.count / limit) } });
    } catch (error) { next(error); }
  });
  api.get('/suburbs/search', async (req, res, next) => {
    try {
      const query = clean(req.query.query);
      if (query.length < 2) return res.status(400).json({ error: 'Enter at least two characters' });
      const results = await dataSource.search(query, Math.min(20, Number(req.query.limit) || 12));
      res.json({ query, results });
    } catch (error) { next(error); }
  });
  api.get('/suburbs/region/:region', async (req, res, next) => {
    try {
      const suburbs = await dataSource.byRegion(req.params.region);
      res.json({ region: clean(req.params.region), suburbs });
    } catch (error) { next(error); }
  });
  api.get('/suburbs/:id', async (req, res, next) => {
    try {
      const suburb = await dataSource.byId(req.params.id);
      if (!suburb) return res.status(404).json({ error: 'Suburb not found' });
      const nearby = (await dataSource.byRegion(suburb.region)).filter(item => String(item.id) !== String(suburb.id)).slice(0, 5);
      const census_profile = await dataSource.profileFor(suburb);
      const transport = await dataSource.transportFor(suburb);
      res.json({
        suburb,
        nearby,
        census_profile,
        transport_summary: transport.transport_summary,
        nearby_transport: transport.nearby_transport,
      });
    } catch (error) { next(error); }
  });
  api.get('/regions', async (_req, res, next) => {
    try { res.json({ regions: await dataSource.regions() }); } catch (error) { next(error); }
  });

  app.use('/api', api);
  app.use(express.static(publicPath));
  app.get(/.*/, (_req, res) => res.sendFile(path.join(publicPath, 'index.html')));
  app.use((error, _req, res, _next) => {
    console.error(error);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  });
  return app;
}

if (require.main === module) {
  const port = process.env.PORT || 3000;
  createApp().listen(port, () => console.log(`NSW Suburbs Explorer running at http://localhost:${port}`));
}

module.exports = { createApp, createDataSource, clean, rankSuburb };
