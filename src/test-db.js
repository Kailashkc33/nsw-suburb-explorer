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

// Initialize Supabase client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
console.log('Initializing Supabase client with URL:', supabaseUrl);
const supabase = createClient(supabaseUrl, supabaseKey);

// Test database connection and show all data
async function testConnection() {
    console.log('Testing database connection...');
    try {
        // Get all suburbs
        const { data, error } = await supabase
            .from('suburbs')
            .select('*')
            .order('suburb');
        
        if (error) {
            console.error('Database connection error:', error);
            throw error;
        }
        
        console.log('Database connection successful');
        console.log(`Found ${data.length} suburbs in the database`);
        console.log('\nSuburbs data:');
        data.forEach(suburb => {
            console.log(`- ${suburb.suburb} (${suburb.region}, ${suburb.postcode})`);
        });
    } catch (error) {
        console.error('Error testing database:', error);
    }
}

// Run the test
testConnection(); 