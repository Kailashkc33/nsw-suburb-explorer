const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

// Initialize Supabase client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
console.log('Initializing Supabase client with URL:', supabaseUrl);
const supabase = createClient(supabaseUrl, supabaseKey);

// Check table structure and data
async function checkTable() {
    console.log('Checking suburbs table...');
    try {
        // First, get the table structure
        const { data: structure, error: structureError } = await supabase
            .from('suburbs')
            .select('*')
            .limit(1);
        
        if (structureError) {
            console.error('Error checking table structure:', structureError);
            throw structureError;
        }

        // Get total count of rows
        const { count, error: countError } = await supabase
            .from('suburbs')
            .select('*', { count: 'exact', head: true });
        
        if (countError) {
            console.error('Error getting row count:', countError);
            throw countError;
        }

        // Get first 5 rows to show sample data
        const { data: sampleData, error: sampleError } = await supabase
            .from('suburbs')
            .select('*')
            .limit(5);
        
        if (sampleError) {
            console.error('Error getting sample data:', sampleError);
            throw sampleError;
        }

        // Print results
        console.log('\nTable Structure:');
        if (structure && structure.length > 0) {
            console.log('Columns:', Object.keys(structure[0]));
        } else {
            console.log('No data found to determine structure');
        }

        console.log('\nTotal Rows:', count);

        console.log('\nSample Data:');
        if (sampleData && sampleData.length > 0) {
            sampleData.forEach((row, index) => {
                console.log(`\nRow ${index + 1}:`);
                Object.entries(row).forEach(([key, value]) => {
                    console.log(`${key}: ${value}`);
                });
            });
        } else {
            console.log('No data found in the table');
        }

    } catch (error) {
        console.error('Error checking table:', error);
    }
}

// Run the check
checkTable(); 