// Check which database backend is being used
require('dotenv').config();

console.log('DATABASE_URL:', process.env.DATABASE_URL ? 'Set' : 'Not set');

// Check db-impl.js logic
const usePg = !!process.env.DATABASE_URL;
console.log('usePg (from db-impl logic):', usePg);

if (usePg) {
    console.log('Should be using PostgreSQL');
    
    // Try to connect to PostgreSQL
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    
    pool.query('SELECT 1 as test')
        .then(() => {
            console.log('PostgreSQL connection successful');
            
            // Check settings
            return pool.query("SELECT * FROM settings WHERE key = 'password_policy'");
        })
        .then(res => {
            if (res.rows[0]) {
                console.log('PostgreSQL password_policy:', res.rows[0].value);
            }
            pool.end();
        })
        .catch(err => {
            console.error('PostgreSQL connection error:', err.message);
            pool.end();
        });
} else {
    console.log('Should be using SQLite');
    
    // Check SQLite
    const Database = require('better-sqlite3');
    try {
        const db = new Database('app.db');
        const row = db.prepare("SELECT value FROM settings WHERE key = 'password_policy'").get();
        console.log('SQLite password_policy:', row ? row.value : 'Not found');
        db.close();
    } catch (err) {
        console.error('SQLite error:', err.message);
    }
}
