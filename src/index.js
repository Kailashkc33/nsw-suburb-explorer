const express = require('express');
const cors = require('cors');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

// Check for required environment variables
const requiredEnvVars = ['SUPABASE_URL', 'SUPABASE_ANON_KEY'];
const missingEnvVars = requiredEnvVars.filter(envVar => !process.env[envVar]);

if (missingEnvVars.length > 0) {
    console.error('Missing required environment variables:', missingEnvVars.join(', '));
    console.error('Please create a .env file with the required variables.');
    process.exit(1);
}

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Request logging middleware
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
});

// Supabase client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
console.log('Initializing Supabase client with URL:', supabaseUrl);
const supabase = createClient(supabaseUrl, supabaseKey);

// API Routes
const apiRouter = express.Router();

// Health check route
apiRouter.get('/health', (req, res) => {
    console.log('Health check requested');
    res.json({ status: 'ok' });
});

// Get all suburbs (with pagination)
apiRouter.get('/suburbs', async (req, res) => {
    console.log('Fetching all suburbs');
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const start = (page - 1) * limit;
        
        console.log('Querying Supabase with params:', { page, limit, start });
        const { data, error, count } = await supabase
            .from('suburbs')
            .select('id, region, suburb, postcode, created_at', { count: 'exact' })
            .range(start, start + limit - 1)
            .order('suburb');
        
        if (error) {
            console.error('Supabase error:', error);
            throw error;
        }
        
        console.log(`Found ${data.length} suburbs`);
        res.json({
            data,
            pagination: {
                total: count,
                page,
                limit,
                totalPages: Math.ceil(count / limit)
            }
        });
    } catch (error) {
        console.error('Error fetching suburbs:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get suburbs by region
apiRouter.get('/suburbs/region/:region', async (req, res) => {
    console.log('Fetching suburbs by region:', req.params.region);
    try {
        const { data, error } = await supabase
            .from('suburbs')
            .select('id, region, suburb, postcode, created_at')
            .ilike('region', `%${req.params.region}%`)
            .order('suburb');
        
        if (error) {
            console.error('Supabase error:', error);
            throw error;
        }
        
        if (data.length === 0) {
            console.log('No suburbs found for region:', req.params.region);
            return res.status(404).json({ 
                error: 'No suburbs found in this region',
                region: req.params.region
            });
        }
        
        console.log(`Found ${data.length} suburbs for region ${req.params.region}`);
        res.json({
            region: req.params.region,
            suburbs: data
        });
    } catch (error) {
        console.error('Error fetching suburbs by region:', error);
        res.status(500).json({ error: error.message });
    }
});

// Search suburb by name
apiRouter.get('/suburbs/search', async (req, res) => {
    console.log('Searching suburbs with query:', req.query.query);
    try {
        const { query } = req.query;
        
        if (!query) {
            console.log('No query provided');
            return res.status(400).json({ error: 'Search query is required' });
        }
        
        const { data, error } = await supabase
            .from('suburbs')
            .select('id, region, suburb, postcode, created_at')
            .or(`suburb.ilike.%${query}%,postcode.ilike.%${query}%`)
            .order('suburb');
        
        if (error) {
            console.error('Supabase error:', error);
            throw error;
        }
        
        if (data.length === 0) {
            console.log('No suburbs found for query:', query);
            return res.status(404).json({ 
                error: 'No suburbs found matching your search',
                query
            });
        }
        
        console.log(`Found ${data.length} suburbs for query ${query}`);
        res.json({
            query,
            results: data
        });
    } catch (error) {
        console.error('Error searching suburbs:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get all unique regions
apiRouter.get('/regions', async (req, res) => {
    console.log('Fetching all regions');
    try {
        const { data, error } = await supabase
            .from('suburbs')
            .select('region')
            .order('region');
        
        if (error) {
            console.error('Supabase error:', error);
            throw error;
        }
        
        // Get unique regions and sort them
        const uniqueRegions = [...new Set(data.map(item => item.region))].sort();
        console.log(`Found ${uniqueRegions.length} unique regions:`, uniqueRegions);
        
        res.json({
            regions: uniqueRegions
        });
    } catch (error) {
        console.error('Error fetching regions:', error);
        res.status(500).json({ error: error.message });
    }
});

// Mount API routes
app.use('/api', apiRouter);

// Serve static files
const publicPath = path.join(__dirname, '../public');
console.log('Serving static files from:', publicPath);
app.use(express.static(publicPath));

// Root route to serve index.html
app.get('/', (req, res) => {
    console.log('Root route accessed');
    res.sendFile(path.join(publicPath, 'index.html'));
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Error:', err);
    res.status(500).json({ error: err.message });
});

// Start server
app.listen(port, () => {
    console.log('=================================');
    console.log(`Server is running on port ${port}`);
    console.log(`Supabase URL: ${supabaseUrl}`);
    console.log(`Public path: ${publicPath}`);
    console.log('=================================');
}); 