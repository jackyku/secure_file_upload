const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const DEFAULT_SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'enabled',
  role TEXT NOT NULL DEFAULT 'user',
  quota INTEGER NOT NULL DEFAULT 1,
  created_at BIGINT,
  updated_at BIGINT,
  last_login BIGINT
);

CREATE TABLE IF NOT EXISTS audit (
  id SERIAL PRIMARY KEY,
  actor TEXT,
  action TEXT,
  target TEXT,
  details TEXT,
  ts BIGINT
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
`;

let pool;

async function init() {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL not set for Postgres');
    pool = new Pool({ connectionString });
    // Ensure tables exist
    await pool.query(DEFAULT_SCHEMA);
    // Add last_login column if it doesn't exist (for older schemas)
    try {
        await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login BIGINT');
    } catch (e) {
        // ignore
    }
}

async function listUsers() {
    const res = await pool.query('SELECT username, status, role, quota, created_at, updated_at, last_login FROM users ORDER BY username');
    return res.rows;
}

async function getUser(username) {
    const res = await pool.query('SELECT id, username, password, status, role, quota, created_at, updated_at, last_login FROM users WHERE username = $1', [username]);
    return res.rows[0];
}

async function createUser(username, password, role = 'user', quota = 1, actor = null) {
    const now = Date.now();
    await pool.query('INSERT INTO users (username, password, status, role, quota, created_at, updated_at, last_login) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [username, password, 'enabled', role, quota, now, now, null]);
    await log(actor || 'system', 'create_user', username, JSON.stringify({ role, quota }));
}

async function setPassword(username, newPassword, actor = null) {
    const now = Date.now();
    // Hash password before storing to keep behavior consistent with SQLite implementation
    const hashed = bcrypt.hashSync(newPassword, 10);
    await pool.query('UPDATE users SET password = $1, updated_at = $2 WHERE username = $3', [hashed, now, username]);
    await log(actor || 'system', 'set_password', username, JSON.stringify({}));
}

async function changePassword(username, currentPassword, newPassword, actor = null) {
    const u = await getUser(username);
    if (!u) throw new Error('User not found');
    // currentPassword check is expected to have been done before calling changePassword
    await setPassword(username, newPassword, actor);
    await log(actor || username, 'change_password', username, JSON.stringify({}));
    return true;
}

async function setQuota(username, quota, actor = null) {
    const now = Date.now();
    await pool.query('UPDATE users SET quota = $1, updated_at = $2 WHERE username = $3', [quota, now, username]);
    await log(actor || 'system', 'set_quota', username, JSON.stringify({ quota }));
}

async function toggleStatus(username, actor = null) {
    const u = await getUser(username);
    if (!u) throw new Error('User not found');
    const newStatus = (u.status === 'enabled') ? 'disabled' : 'enabled';
    await pool.query('UPDATE users SET status = $1, updated_at = $2 WHERE username = $3', [newStatus, Date.now(), username]);
    await log(actor || 'system', 'toggle_status', username, JSON.stringify({ status: newStatus }));
}

async function toggleRole(username, actor = null) {
    const u = await getUser(username);
    if (!u) throw new Error('User not found');
    const newRole = (u.role === 'admin') ? 'user' : 'admin';
    await pool.query('UPDATE users SET role = $1, updated_at = $2 WHERE username = $3', [newRole, Date.now(), username]);
    await log(actor || 'system', 'toggle_role', username, JSON.stringify({ role: newRole }));
}

async function deleteUser(username, actor = null) {
    await pool.query('DELETE FROM users WHERE username = $1', [username]);
    await log(actor || 'system', 'delete_user', username, JSON.stringify({}));
}

async function getSettings() {
    const res = await pool.query('SELECT key, value FROM settings');
    const obj = {};
    for (const r of res.rows) {
        try { obj[r.key] = JSON.parse(r.value); } catch (e) { obj[r.key] = r.value; }
    }
    return obj;
}

async function setSetting(key, value) {
    const valStr = (typeof value === 'string') ? value : JSON.stringify(value);
    const exists = await pool.query('SELECT key FROM settings WHERE key = $1', [key]);
    if (exists.rowCount > 0) {
        await pool.query('UPDATE settings SET value = $1 WHERE key = $2', [valStr, key]);
    } else {
        await pool.query('INSERT INTO settings (key, value) VALUES ($1, $2)', [key, valStr]);
    }
    await log('system', 'set_setting', key, JSON.stringify({ value }));
}

async function log(actor, action, target, details, ts = null) {
    const _ts = ts || Date.now();
    await pool.query('INSERT INTO audit (actor, action, target, details, ts) VALUES ($1,$2,$3,$4,$5)', [actor, action, target, details, _ts]);
}

async function getAudit(limit = 100, offset = 0) {
    const res = await pool.query('SELECT id, actor, action, target, details, ts FROM audit ORDER BY ts DESC LIMIT $1 OFFSET $2', [limit, offset]);
    return res.rows;
}

async function setLastLogin(username, ts = null) {
    const t = ts || Date.now();
    await pool.query('UPDATE users SET last_login = $1, updated_at = $2 WHERE username = $3', [t, Date.now(), username]);
    await log('system', 'set_last_login', username, JSON.stringify({ last_login: t }), t);
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
    log,
    getAudit,
    setLastLogin
};
