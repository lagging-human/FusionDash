'use strict';

/**
 * first-run.js
 * Checks if this is the first time FusionDash has started (no users in DB).
 * If so, asks interactively whether to create an admin user right now.
 * Called from server.js on startup — only runs when stdin is a TTY (real terminal).
 * Skipped in PM2 / non-interactive environments.
 */

const readline = require('readline');
const crypto   = require('crypto');
const path     = require('path');
const db       = require('./db');

const BOLD  = '\x1b[1m';
const CYAN  = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW= '\x1b[33m';
const NC    = '\x1b[0m';

function isInteractive() {
  return process.stdin.isTTY && process.stdout.isTTY;
}

function ask(rl, question) {
  return new Promise(resolve => rl.question(question, resolve));
}

async function firstRunSetup() {
  // Only run if the DB has zero users
  const count = db.prepare('SELECT COUNT(*) as n FROM users').get().n;
  if (count > 0) return;

  // Only prompt in an interactive terminal
  if (!isInteractive()) {
    console.log(`${YELLOW}[setup]${NC} No users found. Run ${BOLD}npm run create:user${NC} to create an admin.`);
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log('');
  console.log(`${BOLD}${CYAN}  First run detected — no users in the database.${NC}`);
  console.log('');

  const answer = await ask(rl, '  Create an admin user now? [Y/n]: ');

  if (answer.trim().toLowerCase() === 'n') {
    console.log(`  Skipped. Run ${BOLD}npm run create:user${NC} whenever you're ready.\n`);
    rl.close();
    return;
  }

  console.log('');

  const provider  = (await ask(rl, '  Login provider the admin will use [discord/google]: ')).trim().toLowerCase();
  if (!['discord', 'google'].includes(provider)) {
    console.log('  Invalid provider. Skipping — run npm run create:user manually.\n');
    rl.close();
    return;
  }

  const username = (await ask(rl, '  Username: ')).trim();
  const email    = (await ask(rl, '  Email (must match what your OAuth account returns): ')).trim();

  if (!username || !email) {
    console.log('  Username and email are required. Skipping.\n');
    rl.close();
    return;
  }

  rl.close();

  const id = `${provider}:setup-${crypto.randomBytes(6).toString('hex')}`;

  const settings = Object.fromEntries(
    db.prepare('SELECT key,value FROM settings').all().map(r => [r.key, r.value])
  );

  db.prepare(`
    INSERT INTO users
      (id, provider, username, email, avatar, is_admin, coins,
       res_memory, res_disk, res_cpu, res_ports, res_databases, res_backups)
    VALUES (?,?,?,?,NULL,1,0,?,?,?,?,?,?)
  `).run(
    id, provider, username, email,
    parseInt(settings.default_memory    || '6144', 10),
    parseInt(settings.default_disk      || '5120', 10),
    parseInt(settings.default_cpu       || '80',   10),
    parseInt(settings.default_ports     || '2',    10),
    parseInt(settings.default_databases || '1',    10),
    parseInt(settings.default_backups   || '1',    10)
  );

  console.log('');
  console.log(`${GREEN}${BOLD}  Admin user created!${NC}`);
  console.log(`  Username: ${username}`);
  console.log(`  Email:    ${email}`);
  console.log(`  Provider: ${provider}`);
  console.log('');
  console.log(`  Log in with your ${provider} account using ${BOLD}${email}${NC}.`);
  console.log(`  The account will be linked on your first login.\n`);
}

module.exports = { firstRunSetup };
