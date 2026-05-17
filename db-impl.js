// Bridge to choose between SQLite (db.js) or Postgres (db-pg.js).
// Expose a consistent Promise-based API.
const usePg = !!process.env.DATABASE_URL;
console.log('db-impl: DATABASE_URL is', process.env.DATABASE_URL ? 'set' : 'NOT set');
console.log('db-impl: usePg =', usePg);
let impl;
if (usePg) {
    console.log('db-impl: Using PostgreSQL (db-pg.js)');
    impl = require('./db-pg');
} else {
    console.log('db-impl: Using SQLite (db.js)');
    impl = require('./db');
}

// Wrap sqlite sync functions as promises so callers can always await.
function wrapSync(fn) {
    return (...args) => {
        try {
            const r = fn(...args);
            return Promise.resolve(r);
        } catch (e) {
            return Promise.reject(e);
        }
    };
}

// If using PG, just export its functions (already promises). If using sqlite, wrap sync ones.
if (usePg) {
    module.exports = impl;
} else {
    module.exports = {
        init: wrapSync(impl.init),
        listUsers: wrapSync(impl.listUsers),
        getUser: wrapSync(impl.getUser),
        createUser: wrapSync(impl.createUser),
        setPassword: wrapSync(impl.setPassword),
        changePassword: wrapSync(impl.changePassword),
        setQuota: wrapSync(impl.setQuota),
        toggleStatus: wrapSync(impl.toggleStatus),
        toggleRole: wrapSync(impl.toggleRole),
        deleteUser: wrapSync(impl.deleteUser),
        getSettings: wrapSync(impl.getSettings),
        setSetting: wrapSync(impl.setSetting),
        log: wrapSync(impl.log),
        getAudit: wrapSync(impl.getAudit),
        setLastLogin: impl.setLastLogin ? wrapSync(impl.setLastLogin) : undefined,
        createShare: wrapSync(impl.createShare),
        getShare: wrapSync(impl.getShare),
        listShares: wrapSync(impl.listShares),
        updateShareExpiry: wrapSync(impl.updateShareExpiry),
        deleteShare: wrapSync(impl.deleteShare)
    };
}
