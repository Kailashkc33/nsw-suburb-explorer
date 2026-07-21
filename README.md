# NSW Suburbs Explorer

Search NSW suburbs by name, postcode or region. Suburb details include ABS Census 2021 indicators and nearby Transport for NSW stops when available.

Stack: Node.js, Express, Supabase, plain HTML/CSS/JS.

## Setup

1. `npm install`
2. Add `SUPABASE_URL` and `SUPABASE_ANON_KEY` to `.env`
3. `npm start` → http://localhost:3000

For local data imports only, also set `SUPABASE_SERVICE_ROLE_KEY`. Never commit it or expose it to the browser.
