const db = require('./db-impl');

async function test() {
    console.log('Testing database type...');
    
    // Check if we can get settings
    try {
        const settings = await db.getSettings();
        console.log('Got settings:', settings);
        
        // Try to check which DB by looking at the structure
        // If it's PostgreSQL, the db module should be using pg
        // If it's SQLite, it would be using better-sqlite3
        
        // Check the module itself
        const dbImpl = require('./db-impl');
        console.log('db-impl module loaded');
        
        // Check if we can detect which backend
        const fs = require('fs');
        if (fs.existsSync('app.db')) {
            console.log('SQLite file exists: app.db');
        }
        
        // Check DATABASE_URL
        console.log('DATABASE_URL:', process.env.DATABASE_URL ? 'Set' : 'Not set');
        
    } catch (error) {
        console.error('Error:', error.message);
    }
}

test();
