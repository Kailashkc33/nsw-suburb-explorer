# Sydney Suburbs Backend

A backend service for managing Sydney suburbs data using Express.js and Supabase.

## Setup

1. Install dependencies:
```bash
npm install
```

2. Create a `.env` file in the root directory with the following variables:
```
PORT=3000
SUPABASE_URL=your_supabase_url
SUPABASE_ANON_KEY=your_supabase_anon_key
```

3. Start the development server:
```bash
node src/index.js
```

## API Endpoints

- `GET /health` - Health check endpoint

## Environment Variables

- `PORT` - The port number the server will run on (default: 3000)
- `SUPABASE_URL` - Your Supabase project URL
- `SUPABASE_ANON_KEY` - Your Supabase anonymous key 