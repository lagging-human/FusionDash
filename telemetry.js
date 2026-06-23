'use strict';
const crypto = require('crypto');
const db = require('./db');

const INSTALL_ID_KEY = 'install_id';

function getOrCreateInstallId() {
  let row = db.prepare('SELECT value FROM settings WHERE key=?').get(INSTALL_ID_KEY);
  if (row) return row.value;
  const id = crypto.randomBytes(16).toString('hex');
  db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)').run(INSTALL_ID_KEY, id);
  return id;
}

function getLiveStats() {
  const users      = db.prepare('SELECT COUNT(*) as n FROM users').get().n;
  const servers    = db.prepare('SELECT COUNT(*) as n FROM servers').get().n;
  const paid       = db.prepare("SELECT COUNT(*) as n FROM transactions WHERE status='paid'").get().n;
  const freeS      = db.prepare("SELECT COUNT(*) as n FROM servers WHERE plan='free'").get().n;
  const paidS      = db.prepare("SELECT COUNT(*) as n FROM servers WHERE plan!='free'").get().n;
  const admins     = db.prepare('SELECT COUNT(*) as n FROM users WHERE is_admin=1').get().n;
  const revenue_inr = db.prepare("SELECT COALESCE(SUM(amount),0) as n FROM transactions WHERE status='paid' AND currency='INR'").get().n;
  const revenue_usd = db.prepare("SELECT COALESCE(SUM(amount),0) as n FROM transactions WHERE status='paid' AND currency='USD'").get().n;
  return {
    install_id: getOrCreateInstallId(),
    users, servers, paid_transactions: paid,
    free_servers: freeS, paid_servers: paidS, admins,
    revenue_inr: Number(revenue_inr).toFixed(2),
    revenue_usd: Number(revenue_usd).toFixed(2),
  };
}

module.exports = { getLiveStats, getOrCreateInstallId };
