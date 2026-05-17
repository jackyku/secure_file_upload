const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const DB_PATH = path.join(__dirname, 'app.db');
const JSON_USERS = path.join(__dirname, 'users.json');

const db = new Database(DB_PATH);

function init() {
    // Create tables
    db.prepare(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'enabled',
        role TEXT NOT NULL DEFAULT 'user',
        quota INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER,
        updated_at INTEGER,
        last_login INTEGER
    )`).run();

    db.prepare(`CREATE TABLE IF NOT EXISTS audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        actor TEXT,
        action TEXT,
        target TEXT,
        details TEXT,
        ts INTEGER
    )`).run();

    db.prepare(`CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
    )`).run();

    db.prepare(`CREATE TABLE IF NOT EXISTS shares (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token TEXT UNIQUE NOT NULL,
        username TEXT NOT NULL,
        filename TEXT NOT NULL,
        password_hash TEXT,
        mode TEXT NOT NULL DEFAULT 'view',
        created_at INTEGER,
        expires_at INTEGER
    )`).run();

    // Initialize default password policy if not present
    const stmt = db.prepare('SELECT value FROM settings WHERE key = ?');
    const pwPolicy = stmt.get('password_policy');
    if (!pwPolicy) {
        const defaultPolicy = JSON.stringify({ minLength: 4, requireNumber: false, requireSpecial: false });
        db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('password_policy', defaultPolicy);
    }

    // Initialize default inactivity_days setting if not present (default 30 days)
    const inactivity = stmt.get('inactivity_days');
    if (!inactivity) {
        db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('inactivity_days', JSON.stringify(30));
    }

    // Migrate users from users.json if they exist and are not yet in DB
    try {
        if (fs.existsSync(JSON_USERS)) {
            const raw = fs.readFileSync(JSON_USERS, 'utf8');
            const users = JSON.parse(raw);
            const insert = db.prepare('INSERT OR IGNORE INTO users (username, password, status, role, quota, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
            const now = Date.now();
            const select = db.prepare('SELECT id FROM users WHERE username = ?');
            for (const u of users) {
                const exists = select.get(u.username);
                if (exists) continue;
                let password = u.password || '';
                // if password not hashed, hash it
                if (typeof password === 'string' && !password.startsWith('$2')) {
                    password = bcrypt.hashSync(password, 10);
                }
                insert.run(u.username, password, u.status || 'enabled', u.role || 'user', u.quota || 1, now, now);
                log('system', 'migrate_user', u.username, JSON.stringify({ migrated: true }));
            }
        }
    } catch (e) {
        console.error('User migration error:', e && e.message);
    }
}

function listUsers() {
    const rows = db.prepare('SELECT username, status, role, quota, created_at, updated_at, last_login FROM users ORDER BY username').all();
    return rows;
}

function getUser(username) {
    return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
}

function createUser(username, password, role = 'user', quota = 1, actor = null) {
    const hashed = bcrypt.hashSync(password, 10);
    const now = Date.now();
    const stmt = db.prepare('INSERT INTO users (username, password, status, role, quota, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    stmt.run(username, hashed, 'enabled', role, quota, now, now);
    log(actor || 'system', 'create_user', username, JSON.stringify({ role, quota }));
}

function setPassword(username, newPassword, actor = null) {
    const hashed = bcrypt.hashSync(newPassword, 10);
    const now = Date.now();
    db.prepare('UPDATE users SET password = ?, updated_at = ? WHERE username = ?').run(hashed, now, username);
    log(actor || 'system', 'set_password', username, JSON.stringify({}));
}

function setLastLogin(username, ts = null) {
    // ts: milliseconds since epoch. If null, use now.
    const when = ts || Date.now();
    try {
        db.prepare('UPDATE users SET last_login = ?, updated_at = ? WHERE username = ?').run(when, Date.now(), username);
        log('system', 'set_last_login', username, JSON.stringify({ ts: when }));
    } catch (e) {
        console.error('setLastLogin error', e && e.message);
    }
}

function changePassword(username, currentPassword, newPassword, actor = null) {
    const user = getUser(username);
    if (!user) throw new Error('User not found');
    let match = false;
    try {
        if (user.password && user.password.startsWith('$2')) match = bcrypt.compareSync(currentPassword, user.password);
        else match = (currentPassword === user.password);
    } catch (e) { match = (currentPassword === user.password); }
    if (!match) return false;
    setPassword(username, newPassword, actor);
    log(actor || username, 'change_password', username, JSON.stringify({}));
    return true;
}

function setQuota(username, quota, actor = null) {
    const now = Date.now();
    db.prepare('UPDATE users SET quota = ?, updated_at = ? WHERE username = ?').run(quota, now, username);
    log(actor || 'system', 'set_quota', username, JSON.stringify({ quota }));
}

function toggleStatus(username, actor = null) {
    const user = getUser(username);
    if (!user) throw new Error('User not found');
    const newStatus = (user.status === 'enabled') ? 'disabled' : 'enabled';
    db.prepare('UPDATE users SET status = ?, updated_at = ? WHERE username = ?').run(newStatus, Date.now(), username);
    log(actor || 'system', 'toggle_status', username, JSON.stringify({ status: newStatus }));
}

function toggleRole(username, actor = null) {
    const user = getUser(username);
    if (!user) throw new Error('User not found');
    const newRole = (user.role === 'admin') ? 'user' : 'admin';
    db.prepare('UPDATE users SET role = ?, updated_at = ? WHERE username = ?').run(newRole, Date.now(), username);
    log(actor || 'system', 'toggle_role', username, JSON.stringify({ role: newRole }));
}

function deleteUser(username, actor = null) {
    db.prepare('DELETE FROM users WHERE username = ?').run(username);
    log(actor || 'system', 'delete_user', username, JSON.stringify({}));
}

function getSettings() {
    const rows = db.prepare('SELECT key, value FROM settings').all();
    const obj = {};
    for (const r of rows) {
        try { obj[r.key] = JSON.parse(r.value); } catch (e) { obj[r.key] = r.value; }
    }
    return obj;
}

function setSetting(key, value) {
    const exists = db.prepare('SELECT key FROM settings WHERE key = ?').get(key);
    const valStr = (typeof value === 'string') ? value : JSON.stringify(value);
    if (exists) db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(valStr, key);
    else db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(key, valStr);
    log('system', 'set_setting', key, JSON.stringify({ value }));
}

function log(actor, action, target, details) {
    try {
        const ts = Date.now();
        db.prepare('INSERT INTO audit (actor, action, target, details, ts) VALUES (?, ?, ?, ?, ?)').run(actor, action, target, details, ts);
    } catch (e) {
        console.error('audit log error', e && e.message);
    }
}

function createShare(token, username, filename, passwordHash, mode, expiresAt) {
    const now = Date.now();
    db.prepare('INSERT INTO shares (token, username, filename, password_hash, mode, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(token, username, filename, passwordHash || null, mode || 'view', now, expiresAt || null);
    log('system', 'create_share', filename, JSON.stringify({ username, mode }));
}

function getShare(token) {
    return db.prepare('SELECT * FROM shares WHERE token = ?').get(token);
}

function listShares(username, isAdmin) {
    if (isAdmin) return db.prepare('SELECT * FROM shares ORDER BY created_at DESC').all();
    return db.prepare('SELECT * FROM shares WHERE username = ? ORDER BY created_at DESC').all(username);
}

function updateShareExpiry(token, expiresAt, username, isAdmin) {
    const share = db.prepare('SELECT * FROM shares WHERE token = ?').get(token);
    if (!share) throw new Error('Share not found');
    if (!isAdmin && share.username !== username) throw new Error('Not authorized');
    db.prepare('UPDATE shares SET expires_at = ? WHERE token = ?').run(expiresAt, token);
    log(username, 'update_share_expiry', share.filename, JSON.stringify({ token, expires_at: expiresAt }));
}

function deleteShare(token, username, isAdmin) {
    const share = db.prepare('SELECT * FROM shares WHERE token = ?').get(token);
    if (!share) throw new Error('Share not found');
    if (!isAdmin && share.username !== username) throw new Error('Not authorized');
    db.prepare('DELETE FROM shares WHERE token = ?').run(token);
    log(username, 'delete_share', share.filename, JSON.stringify({ token }));
}

function getAudit(limit = 100, offset = 0) {
    const rows = db.prepare('SELECT id, actor, action, target, details, ts FROM audit ORDER BY ts DESC LIMIT ? OFFSET ?').all(limit, offset);
    return rows;
}

module.exports = {
    init,
    listUsers,
    getUser,
    createUser,
    setPassword,
    changePassword,
    setQuota,
    toggleStatus,
    toggleRole,
    deleteUser,
    getSettings,
    setSetting,
    setLastLogin,
    log,
    getAudit,
    createShare,
    getShare,
    listShares,
    updateShareExpiry,
    deleteShare
};
