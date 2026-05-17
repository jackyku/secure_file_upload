const Database = require('better-sqlite3');

try {
    const db = new Database('app.db');
    const users = db.prepare('SELECT username FROM users ORDER BY username').all();
    console.log('SQLite users (' + users.length + '):');
    users.forEach(user => console.log('  - ' + user.username));
    db.close();
} catch (err) {
    console.error('Error:', err.message);
}
