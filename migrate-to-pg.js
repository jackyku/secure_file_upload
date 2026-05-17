(async () => {
    try {
        const sqliteDb = require('./db');
        const pgDb = require('./db-pg');
        const DATABASE_URL = process.env.DATABASE_URL;
        if (!DATABASE_URL) {
            console.error('Set DATABASE_URL env var to your Postgres connection string and re-run this script.');
            process.exit(1);
        }

        await pgDb.init();
        console.log('Postgres initialized. Starting migration...');

        // Migrate users
        const users = sqliteDb.listUsers();
        let migratedUsers = 0;
        for (const u of users) {
            const existing = await pgDb.getUser(u.username);
            if (existing) continue;
            // sqlite user object from db.listUsers returns username,status,role,quota,created_at,updated_at
            // Fetch full user record to access password
            const full = sqliteDb.getUser(u.username);
            const password = full && full.password ? full.password : '';
            await pgDb.createUser(u.username, password, u.role, u.quota, 'migration');
            migratedUsers++;
        }
        console.log('Users migrated:', migratedUsers);

        // Migrate settings
        const settings = sqliteDb.getSettings();
        for (const k of Object.keys(settings)) {
            await pgDb.setSetting(k, settings[k]);
        }
        console.log('Settings migrated.');

        // Migrate audit (up to 10000 entries)
        const audits = sqliteDb.getAudit(10000, 0);
        let migratedAudit = 0;
        for (const a of audits) {
            // a has id, actor, action, target, details, ts
            await pgDb.log(a.actor, a.action, a.target, a.details, a.ts);
            migratedAudit++;
        }
        console.log('Audit entries migrated:', migratedAudit);

        console.log('Migration complete.');
        process.exit(0);
    } catch (e) {
        console.error('Migration failed:', e);
        process.exit(2);
    }
})();