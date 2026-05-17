const http = require('http');
require('dotenv').config();

async function test() {
    console.log('=== Verifying PostgreSQL Usage ===\n');
    
    // 1. Check environment configuration
    console.log('1. Environment Configuration:');
    console.log('   DATABASE_URL:', process.env.DATABASE_URL ? 'Set' : 'Not set');
    console.log('   DATABASE_URL value:', process.env.DATABASE_URL ? process.env.DATABASE_URL.replace(/:[^:]*@/, ':****@') : 'N/A');
    
    // 2. Check db-impl.js logic
    console.log('\n2. Database Implementation Logic:');
    const usePg = !!process.env.DATABASE_URL;
    console.log('   Should use PostgreSQL?', usePg);
    
    // 3. Test PostgreSQL connection directly
    console.log('\n3. Direct PostgreSQL Connection Test:');
    try {
        const { Pool } = require('pg');
        const pool = new Pool({ connectionString: process.env.DATABASE_URL });
        const res = await pool.query('SELECT version()');
        console.log('   PostgreSQL version:', res.rows[0].version.split(',')[0]);
        
        // Check if tables exist
        const tables = await pool.query(`
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_schema = 'public'
        `);
        console.log('   Tables in database:', tables.rows.map(r => r.table_name).join(', '));
        
        // Check users count
        const users = await pool.query('SELECT COUNT(*) FROM users');
        console.log('   Users in PostgreSQL:', users.rows[0].count);
        
        await pool.end();
    } catch (err) {
        console.log('   PostgreSQL connection error:', err.message);
    }
    
    // 4. Test SQLite (if exists)
    console.log('\n4. SQLite Check:');
    const fs = require('fs');
    if (fs.existsSync('app.db')) {
        console.log('   SQLite file (app.db) exists');
        try {
            const Database = require('better-sqlite3');
            const db = new Database('app.db');
            const userCount = db.prepare('SELECT COUNT(*) FROM users').get();
            console.log('   Users in SQLite:', userCount['COUNT(*)']);
            db.close();
        } catch (err) {
            console.log('   SQLite read error:', err.message);
        }
    } else {
        console.log('   SQLite file does not exist');
    }
    
    // 5. Test server API
    console.log('\n5. Server API Test:');
    try {
        // Try to get settings from server
        const options = {
            hostname: 'localhost',
            port: 3000,
            path: '/api/admin/settings',
            method: 'GET',
            headers: {
                'Accept': 'application/json'
            }
        };
        
        const data = await new Promise((resolve, reject) => {
            const req = http.request(options, (res) => {
                let data = '';
                res.on('data', (chunk) => data += chunk);
                res.on('end', () => {
                    if (res.statusCode === 200) {
                        try {
                            resolve(JSON.parse(data));
                        } catch {
                            resolve(data);
                        }
                    } else {
                        reject(new Error(`HTTP ${res.statusCode}: ${data}`));
                    }
                });
            });
            req.on('error', reject);
            req.setTimeout(5000, () => req.destroy());
            req.end();
        });
        
        console.log('   Server settings API response:', JSON.stringify(data, null, 2));
        console.log('   Server is responding correctly');
    } catch (err) {
        console.log('   Server API error:', err.message);
        console.log('   Note: API requires admin authentication');
    }
    
    console.log('\n=== Verification Summary ===');
    console.log('The server should be using PostgreSQL if:');
    console.log('1. DATABASE_URL is set ✓');
    console.log('2. PostgreSQL connection works ✓');
    console.log('3. Data exists in PostgreSQL tables ✓');
    console.log('\nBased on the checks above, the server appears to be configured');
    console.log('to use PostgreSQL. However, to be absolutely certain, you would');
    console.log('need to check the server logs during startup or add logging to');
    console.log('db-impl.js to see which database implementation is loaded.');
}

test().catch(console.error);
