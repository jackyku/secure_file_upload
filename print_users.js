require('dotenv').config();
const db = require('./db-impl');

(async () => {
  try {
    await db.init();
    const users = await db.listUsers();
    console.log('users from db.listUsers():');
    console.log(users);
    console.log('--- full user records ---');
    for (const u of users) {
      const full = await db.getUser(u.username);
      console.log(u.username, JSON.stringify({ last_login: full.last_login, created_at: full.created_at, updated_at: full.updated_at }));
    }
  } catch (e) {
    console.error('error reading users', e);
    process.exit(1);
  }
})();
