const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

// Initialize Supabase client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
console.log('Initializing Supabase client with URL:', supabaseUrl);
const supabase = createClient(supabaseUrl, supabaseKey);

// Test regions data
async function testRegions() {
    console.log('Testing regions data...');
    try {
        // Get all suburbs to extract regions
        const { data, error } = await supabase
            .from('suburbs')
            .select('region');
        
        if (error) {
            console.error('Database error:', error);
            throw error;
        }
        
        // Get unique regions and sort them
        const uniqueRegions = [...new Set(data.map(item => item.region))].sort();
        
        console.log('\nFound regions:');
        uniqueRegions.forEach(region => {
            console.log(`- ${region}`);
        });
        
        console.log(`\nTotal unique regions: ${uniqueRegions.length}`);
    } catch (error) {
        console.error('Error testing regions:', error);
    }
}

// Run the test
testRegions();