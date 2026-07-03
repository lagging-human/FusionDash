#!/usr/bin/env node
'use strict';

const readline = require('readline');
const path = require('path');

// Load .env
require('dotenv').config({ path: path.join(__dirname, '.env') });

const db = require('./db');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise(res => rl.question(q, res));

const BOLD  = '\x1b[1m';
const CYAN  = '\x1b[36m';
const GREEN = '\x1b[32m';
const RED   = '\x1b[31m';
const RESET = '\x1b[0m';

async function main() {
  console.log(`\n${BOLD}${CYAN}FusionDash — User Creator${RESET}\n`);

  const role = (await ask('  Role [admin/user]: ')).trim().toLowerCase();
  if (role !== 'admin' && role !== 'user') {
    console.error(`${RED}Invalid role. Use "admin" or "user".${RESET}`);
    process.exit(1);
  }

  const provider = (await ask('  Provider [discord/google/manual]: ')).trim().toLowerCase();
  if (!['discord', 'google', 'manual'].includes(provider)) {
    console.error(`${RED}Invalid provider.${RESET}`);
    process.exit(1);
  }

  const username = (await ask('  Username: ')).trim();
  if (!username) { console.error(`${RED}Username required.${RESET}`); process.exit(1); }

  const email = (await ask('  Email: ')).trim();
  if (!email) { console.error(`${RED}Email required.${RESET}`); process.exit(1); }

  const id = `${provider}:${Date.now()}`;
  const isAdmin = role === 'admin' ? 1 : 0;

  const existing = db.prepare('SELECT id FROM users WHERE email=?').get(email);
  if (existing) {
    console.log(`\n  User with email ${email} already exists (id: ${existing.id}).`);
    const update = (await ask('  Update their role instead? [y/N]: ')).trim().toLowerCase();
    if (update === 'y') {
      db.prepare('UPDATE users SET is_admin=? WHERE email=?').run(isAdmin, email);
      console.log(`\n${GREEN}  Updated ${email} — is_admin=${isAdmin}${RESET}\n`);
    }
    rl.close();
    return;
  }

  // Get default resources
  const settings = Object.fromEntries(
    db.prepare('SELECT key,value FROM settings').all().map(r => [r.key, r.value])
  );

  db.prepare(`
    INSERT INTO users
      (id, provider, username, email, avatar, is_admin, coins,
       res_memory, res_disk, res_cpu, res_ports, res_databases, res_backups)
    VALUES (?,?,?,?,NULL,?,0,?,?,?,?,?,?)
  `).run(
    id, provider, username, email, isAdmin,
    parseInt(settings.default_memory    || '6144', 10),
    parseInt(settings.default_disk      || '5120', 10),
    parseInt(settings.default_cpu       || '80',   10),
    parseInt(settings.default_ports     || '2',    10),
    parseInt(settings.default_databases || '1',    10),
    parseInt(settings.default_backups   || '1',    10)
  );

  console.log(`
${GREEN}${BOLD}  User created${RESET}

  ID:       ${id}
  Username: ${username}
  Email:    ${email}
  Role:     ${role}
  Provider: ${provider}

  They can log in via ${provider === 'manual' ? 'either OAuth provider using this email' : provider}.
`);

  rl.close();
}

main().catch(err => {
  console.error(`${RED}Error: ${err.message}${RESET}`);
  process.exit(1);
});
