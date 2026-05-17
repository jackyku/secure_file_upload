#!/usr/bin/env node
/**
 * setup-admin.js — Create the first admin user in the local SQLite database.
 * Run once after installation:  node setup-admin.js
 */

// Force SQLite regardless of environment
process.env.DATABASE_URL = '';

const readline = require('readline');
const db = require('./db');

db.init();

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function ask(question, hidden = false) {
    return new Promise(resolve => {
        if (hidden && process.stdin.isTTY) {
            process.stdout.write(question);
            process.stdin.setRawMode(true);
            process.stdin.resume();
            let input = '';
            process.stdin.on('data', function handler(ch) {
                ch = ch.toString();
                if (ch === '\n' || ch === '\r' || ch === '') {
                    process.stdin.setRawMode(false);
                    process.stdin.removeListener('data', handler);
                    process.stdout.write('\n');
                    resolve(input);
                } else if (ch === '') {
                    input = input.slice(0, -1);
                } else {
                    input += ch;
                    process.stdout.write('*');
                }
            });
        } else {
            rl.question(question, resolve);
        }
    });
}

async function main() {
    console.log('\n╔══════════════════════════════════════╗');
    console.log('║       Web Upload — Admin Setup       ║');
    console.log('╚══════════════════════════════════════╝\n');

    const username = (await ask('Admin username: ')).trim();
    if (!username) { console.error('Username cannot be empty.'); process.exit(1); }

    const existing = db.getUser(username);
    if (existing) {
        console.log(`\n⚠  User "${username}" already exists (role: ${existing.role}).`);
        console.log('   Use the admin panel to change the password.\n');
        rl.close(); return;
    }

    const password = await ask('Admin password: ', true);
    if (!password || password.length < 4) {
        console.error('\nPassword must be at least 4 characters.'); process.exit(1);
    }
    const confirm = await ask('Confirm password: ', true);
    if (password !== confirm) { console.error('\nPasswords do not match.'); process.exit(1); }

    db.createUser(username, password, 'admin', 999, 'setup');

    console.log(`\n✓  Admin user "${username}" created successfully!`);
    console.log(`   Login at: http://localhost:${process.env.PORT || 3000}/login.html\n`);
    rl.close();
}

main().catch(e => {
    console.error('\nError:', e.message);
    rl.close();
    process.exit(1);
});
