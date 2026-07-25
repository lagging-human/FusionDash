'use strict';

const axios = require('axios');
const db = require('./db');

const listWebhooksStmt  = db.prepare('SELECT * FROM webhooks ORDER BY id DESC');
const insertWebhookStmt = db.prepare('INSERT INTO webhooks (label,url,enabled) VALUES (?,?,1)');
const deleteWebhookStmt = db.prepare('DELETE FROM webhooks WHERE id=?');
const toggleWebhookStmt = db.prepare('UPDATE webhooks SET enabled=? WHERE id=?');
const getSetting        = db.prepare('SELECT value FROM settings WHERE key=?');

const COLORS = { info: 0x3b82f6, success: 0x22c55e, warning: 0xf59e0b, danger: 0xef4444 };

function listWebhooks() {
  return listWebhooksStmt.all();
}

function addWebhook(url, label) {
  const trimmed = String(url || '').trim();
  if (!/^https:\/\/(discord|discordapp)\.com\/api\/webhooks\//.test(trimmed)) {
    return { ok: false, error: "That doesn't look like a Discord webhook URL." };
  }
  const info = insertWebhookStmt.run((label || '').trim().slice(0, 60) || null, trimmed);
  return { ok: true, id: info.lastInsertRowid };
}

function removeWebhook(id) {
  deleteWebhookStmt.run(id);
}

function setWebhookEnabled(id, enabled) {
  toggleWebhookStmt.run(enabled ? 1 : 0, id);
}

function isEventEnabled(settingKey) {
  const row = getSetting.get(settingKey);
  return row ? row.value === '1' : true; // default to enabled if the setting is somehow missing
}

/** Fan out an embed to every enabled webhook. Never throws — best-effort. */
async function postEmbed(embed) {
  const hooks = listWebhooksStmt.all().filter(h => h.enabled);
  if (hooks.length === 0) return;
  await Promise.allSettled(hooks.map(h =>
    axios.post(h.url, { embeds: [embed] }, { timeout: 5000 }).catch(err => {
      console.error('[discord] webhook failed:', h.label || h.url, '-', err.response?.status || err.message);
    })
  ));
}

async function notifyNewUser({ username, email, provider }) {
  if (!isEventEnabled('discord_notify_new_user')) return;
  return postEmbed({
    title: '🆕 New user signed up',
    color: COLORS.success,
    fields: [
      { name: 'Username', value: String(username || 'Unknown'), inline: true },
      { name: 'Email',    value: String(email || 'N/A'),        inline: true },
      { name: 'Provider', value: String(provider || 'N/A'),     inline: true },
    ],
    timestamp: new Date().toISOString(),
  });
}

async function notifyNewPayment({ username, planName, amount, currency, gateway }) {
  if (!isEventEnabled('discord_notify_new_payment')) return;
  return postEmbed({
    title: '💳 New payment received',
    color: COLORS.success,
    fields: [
      { name: 'User',    value: String(username || 'Unknown'),  inline: true },
      { name: 'Plan',    value: String(planName || 'N/A'),      inline: true },
      { name: 'Amount',  value: `${amount} ${currency}`,        inline: true },
      { name: 'Gateway', value: String(gateway || 'N/A'),       inline: true },
    ],
    timestamp: new Date().toISOString(),
  });
}

async function notifySubscriptionEnding({ username, serverName, daysLeft }) {
  if (!isEventEnabled('discord_notify_sub_ending')) return;
  return postEmbed({
    title: '⏳ Subscription ending soon',
    color: COLORS.warning,
    fields: [
      { name: 'User',      value: String(username || 'Unknown'), inline: true },
      { name: 'Server',    value: String(serverName || 'N/A'),   inline: true },
      { name: 'Days left', value: String(daysLeft),              inline: true },
    ],
    timestamp: new Date().toISOString(),
  });
}

async function notifyAdminBroadcast({ adminUsername, subject, recipientCount }) {
  if (!isEventEnabled('discord_notify_admin_alerts')) return;
  return postEmbed({
    title: '📢 Admin sent an email broadcast',
    color: COLORS.info,
    fields: [
      { name: 'Admin',      value: String(adminUsername || 'Unknown'), inline: true },
      { name: 'Recipients', value: String(recipientCount),             inline: true },
      { name: 'Subject',    value: String(subject || 'N/A'),           inline: false },
    ],
    timestamp: new Date().toISOString(),
  });
}

async function sendTest(url) {
  try {
    await axios.post(url, {
      embeds: [{ title: '✅ Test notification', description: 'If you can see this, the webhook works.', color: COLORS.info, timestamp: new Date().toISOString() }]
    }, { timeout: 5000 });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.response?.status ? `HTTP ${err.response.status}` : err.message };
  }
}

module.exports = {
  listWebhooks, addWebhook, removeWebhook, setWebhookEnabled, isEventEnabled,
  notifyNewUser, notifyNewPayment, notifySubscriptionEnding, notifyAdminBroadcast,
  sendTest,
};
