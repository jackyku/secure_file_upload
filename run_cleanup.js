require('dotenv').config();
/*
One-off script to run the inactivity cleanup immediately.
This mirrors the server's runInactivityCleanup(false) behavior:
- reads inactivity_days from settings (default 30)
- finds non-admin users whose last_login/updated_at/created_at is older than cutoff
- deletes user rows and removes uploads/<username> directories
Run with: node run_cleanup.js
*/
const db = require('./db-impl');
const fs = require('fs');
const path = require('path');

async function run() {
    try {
        await db.init();
    } catch (e) {
        console.error('Failed to init DB:', e);
        process.exit(2);
    }

    try {
        const settings = await db.getSettings();
        const days = (typeof settings.inactivity_days === 'number') ? settings.inactivity_days : 30;
        const cutoff = Date.now() - days * 24 * 3600 * 1000;
        const users = await db.listUsers();
        const deleted = [];
        const skipped = [];

        for (const u of users) {
            try {
                const full = await db.getUser(u.username);
                if (!full) continue;
                if (full.role === 'admin') {
                    skipped.push({ username: full.username, reason: 'admin' });
                    continue;
                }
                const lastActivity = full.last_login || full.updated_at || full.created_at || 0;
                if (lastActivity === 0 || lastActivity < cutoff) {
                    try {
                        await db.deleteUser(full.username, 'script');
                        const userDir = path.join(__dirname, 'uploads', full.username);
                        if (fs.existsSync(userDir)) {
                            try { fs.rmSync(userDir, { recursive: true, force: true }); } catch (e) { console.error('failed to remove user dir', full.username, e); }
                        }
                        deleted.push({ username: full.username, deleted: true, last_login: full.last_login || null });
                    } catch (e) {
                        console.error('failed to delete user', full.username, e);
                    }
                } else {
                    skipped.push({ username: full.username, reason: 'active', last_login: full.last_login || null });
                }
            } catch (e) {
                console.error('error processing user', u.username, e);
            }
        }

        console.log({ days, cutoff, deleted, skipped, dryRun: false });
        process.exit(0);
    } catch (e) {
        console.error('Cleanup failed:', e);
        process.exit(1);
    }
}

run();
