'use strict';

const nodemailer = require('nodemailer');
const db = require('./db');

// Built lazily (not at require-time) so a missing/incomplete .env never
// crashes the app on boot — routes just get a "not configured" result back.
let transporter;
let built = false;

function isConfigured() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_PORT && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function getTransporter() {
  if (built) return transporter;
  built = true;
  if (!isConfigured()) return null;
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT, 10) || 587,
    secure: process.env.SMTP_SECURE === 'true', // true for port 465 (implicit TLS), false for 587/25 (STARTTLS)
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  return transporter;
}

function fromHeader() {
  const name = process.env.SMTP_FROM_NAME || 'FusionDash';
  const addr = process.env.SMTP_FROM || process.env.SMTP_USER;
  return addr ? `"${name}" <${addr}>` : undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Daily send quota — most SMTP relays (a personal Gmail account, a free
// SendGrid/Mailgun tier, etc) cap you at a fixed number of emails per day.
// Every send goes through here first so no code path — forgot-password,
// signup, an admin broadcast — can silently blow through that cap.
// ─────────────────────────────────────────────────────────────────────────────
const getSetting = db.prepare('SELECT value FROM settings WHERE key=?');
const setSetting = db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');

function todayStr() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

function getDailyLimit() {
  const row = getSetting.get('smtp_daily_limit');
  const n = parseInt(row?.value || '300', 10);
  return Number.isFinite(n) && n > 0 ? n : 300;
}

function getUsageToday() {
  const dateRow  = getSetting.get('smtp_sent_date');
  const countRow = getSetting.get('smtp_sent_count');
  const sent = (dateRow?.value === todayStr()) ? parseInt(countRow?.value || '0', 10) : 0;
  const limit = getDailyLimit();
  return { sent, limit, remaining: Math.max(0, limit - sent) };
}

/** Atomically checks quota and reserves one slot. Returns true if allowed. */
function reserveQuotaSlot() {
  const today = todayStr();
  const dateRow = getSetting.get('smtp_sent_date');
  let count = (dateRow?.value === today) ? parseInt(getSetting.get('smtp_sent_count')?.value || '0', 10) : 0;
  if (count >= getDailyLimit()) return false;
  count += 1;
  setSetting.run('smtp_sent_date', today);
  setSetting.run('smtp_sent_count', String(count));
  return true;
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}

function wrapTemplate(appName, bodyHtml) {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#0c0d0f;font-family:Arial,Helvetica,sans-serif;">
    <div style="max-width:480px;margin:0 auto;padding:32px 24px;">
      <p style="color:#71717a;font-size:12px;letter-spacing:.05em;text-transform:uppercase;margin:0 0 16px;">${escapeHtml(appName)}</p>
      ${bodyHtml}
      <p style="color:#52525b;font-size:11px;margin-top:32px;">If you didn't request this, you can safely ignore this email.</p>
    </div>
  </body></html>`;
}

/**
 * Send an email. Never throws — email delivery is best-effort so callers
 * (e.g. "forgot password") keep working even if SMTP is down or unset.
 * Returns { ok: true } or { ok: false, error }.
 */
async function sendMail({ to, subject, html, text }) {
  const t = getTransporter();
  if (!t) return { ok: false, error: 'SMTP is not configured.' };
  if (!reserveQuotaSlot()) {
    console.warn('[mailer] daily send limit reached — skipped:', subject, '->', to);
    return { ok: false, error: 'Daily email limit reached.' };
  }
  try {
    await t.sendMail({ from: fromHeader(), to, subject, html, text });
    return { ok: true };
  } catch (err) {
    console.error('[mailer] send failed:', err.message);
    return { ok: false, error: err.message };
  }
}

async function sendPasswordResetEmail({ to, username, resetUrl, appName }) {
  const name = appName || 'FusionDash';
  const html = wrapTemplate(name, `
    <h2 style="color:#fff;font-size:18px;margin:0 0 12px;">Reset your password</h2>
    <p style="color:#a1a1aa;font-size:14px;line-height:1.6;margin:0 0 20px;">
      Hi ${escapeHtml(username || 'there')}, we received a request to reset the password for your
      ${escapeHtml(name)} account (${escapeHtml(to)}). This link expires in 1 hour.
    </p>
    <a href="${resetUrl}" style="display:inline-block;background:#3b82f6;color:#fff;text-decoration:none;padding:10px 22px;border-radius:999px;font-size:14px;font-weight:600;">Reset Password</a>
    <p style="color:#52525b;font-size:12px;margin-top:20px;word-break:break-all;">${resetUrl}</p>
  `);
  const text = `Reset your ${name} password: ${resetUrl} (expires in 1 hour)`;
  return sendMail({ to, subject: `Reset your ${name} password`, html, text });
}

async function sendNewAccountEmail({ to, username, password, loginUrl, appName }) {
  const name = appName || 'FusionDash';
  const html = wrapTemplate(name, `
    <h2 style="color:#fff;font-size:18px;margin:0 0 12px;">Your account is ready</h2>
    <p style="color:#a1a1aa;font-size:14px;line-height:1.6;margin:0 0 16px;">An administrator created a ${escapeHtml(name)} account for you.</p>
    <table style="width:100%;border-collapse:collapse;margin-bottom:20px;">
      <tr><td style="color:#71717a;font-size:12px;padding:4px 0;">Email</td><td style="color:#fff;font-size:13px;padding:4px 0;">${escapeHtml(to)}</td></tr>
      <tr><td style="color:#71717a;font-size:12px;padding:4px 0;">Password</td><td style="color:#fff;font-size:13px;font-family:monospace;padding:4px 0;">${escapeHtml(password)}</td></tr>
    </table>
    <a href="${loginUrl}" style="display:inline-block;background:#3b82f6;color:#fff;text-decoration:none;padding:10px 22px;border-radius:999px;font-size:14px;font-weight:600;">Sign In</a>
    <p style="color:#52525b;font-size:12px;margin-top:20px;">We recommend changing your password after signing in.</p>
  `);
  const text = `Your ${name} account is ready.\nEmail: ${to}\nPassword: ${password}\nSign in: ${loginUrl}`;
  return sendMail({ to, subject: `Your ${name} account is ready`, html, text });
}

async function sendWelcomeEmail({ to, username, appName, dashboardUrl }) {
  const name = appName || 'FusionDash';
  const html = wrapTemplate(name, `
    <h2 style="color:#fff;font-size:18px;margin:0 0 12px;">Welcome to ${escapeHtml(name)}, ${escapeHtml(username || 'there')}</h2>
    <p style="color:#a1a1aa;font-size:14px;line-height:1.6;margin:0 0 20px;">Your account (${escapeHtml(to)}) is ready. You can create your first server right away.</p>
    ${dashboardUrl ? `<a href="${dashboardUrl}" style="display:inline-block;background:#3b82f6;color:#fff;text-decoration:none;padding:10px 22px;border-radius:999px;font-size:14px;font-weight:600;">Go to Dashboard</a>` : ''}
  `);
  const text = `Welcome to ${name}, ${username || 'there'}! Your account (${to}) is ready.`;
  return sendMail({ to, subject: `Welcome to ${name}`, html, text });
}

async function sendVerificationEmail({ to, username, verifyUrl, appName }) {
  const name = appName || 'FusionDash';
  const html = wrapTemplate(name, `
    <h2 style="color:#fff;font-size:18px;margin:0 0 12px;">Verify your email</h2>
    <p style="color:#a1a1aa;font-size:14px;line-height:1.6;margin:0 0 20px;">
      Hi ${escapeHtml(username || 'there')}, please confirm ${escapeHtml(to)} is really you. This link expires in 24 hours.
    </p>
    <a href="${verifyUrl}" style="display:inline-block;background:#3b82f6;color:#fff;text-decoration:none;padding:10px 22px;border-radius:999px;font-size:14px;font-weight:600;">Verify Email</a>
    <p style="color:#52525b;font-size:12px;margin-top:20px;word-break:break-all;">${verifyUrl}</p>
  `);
  const text = `Verify your ${name} email: ${verifyUrl} (expires in 24 hours)`;
  return sendMail({ to, subject: `Verify your email for ${name}`, html, text });
}

async function sendPaymentReceivedEmail({ to, username, planName, amount, currency, serverName, appName, dashboardUrl }) {
  const name = appName || 'FusionDash';
  const html = wrapTemplate(name, `
    <h2 style="color:#fff;font-size:18px;margin:0 0 12px;">Payment received</h2>
    <p style="color:#a1a1aa;font-size:14px;line-height:1.6;margin:0 0 16px;">Hi ${escapeHtml(username || 'there')}, thanks for your purchase — your server is being set up.</p>
    <table style="width:100%;border-collapse:collapse;margin-bottom:20px;">
      <tr><td style="color:#71717a;font-size:12px;padding:4px 0;">Plan</td><td style="color:#fff;font-size:13px;padding:4px 0;">${escapeHtml(planName)}</td></tr>
      <tr><td style="color:#71717a;font-size:12px;padding:4px 0;">Server</td><td style="color:#fff;font-size:13px;padding:4px 0;">${escapeHtml(serverName)}</td></tr>
      <tr><td style="color:#71717a;font-size:12px;padding:4px 0;">Amount</td><td style="color:#fff;font-size:13px;padding:4px 0;">${escapeHtml(String(amount))} ${escapeHtml(currency)}</td></tr>
    </table>
    ${dashboardUrl ? `<a href="${dashboardUrl}" style="display:inline-block;background:#3b82f6;color:#fff;text-decoration:none;padding:10px 22px;border-radius:999px;font-size:14px;font-weight:600;">View Server</a>` : ''}
  `);
  const text = `Payment received for ${planName} (${serverName}) — ${amount} ${currency}.`;
  return sendMail({ to, subject: `Payment received — ${name}`, html, text });
}

async function sendSubscriptionEndingEmail({ to, username, serverName, daysLeft, renewUrl, appName }) {
  const name = appName || 'FusionDash';
  const html = wrapTemplate(name, `
    <h2 style="color:#fff;font-size:18px;margin:0 0 12px;">Your subscription is ending soon</h2>
    <p style="color:#a1a1aa;font-size:14px;line-height:1.6;margin:0 0 20px;">
      Hi ${escapeHtml(username || 'there')}, <strong style="color:#fff;">${escapeHtml(serverName)}</strong> is due to renew in
      ${escapeHtml(String(daysLeft))} day${daysLeft === 1 ? '' : 's'}. Renew to avoid interruption.
    </p>
    ${renewUrl ? `<a href="${renewUrl}" style="display:inline-block;background:#3b82f6;color:#fff;text-decoration:none;padding:10px 22px;border-radius:999px;font-size:14px;font-weight:600;">Manage Subscription</a>` : ''}
  `);
  const text = `${serverName} is due to renew in ${daysLeft} day(s).`;
  return sendMail({ to, subject: `${serverName} renews in ${daysLeft} day${daysLeft === 1 ? '' : 's'} — ${name}`, html, text });
}

async function sendBroadcastEmail({ to, username, subject, bodyHtml, bodyText, appName }) {
  const name = appName || 'FusionDash';
  const html = wrapTemplate(name, `
    <p style="color:#a1a1aa;font-size:14px;line-height:1.6;margin:0 0 4px;">Hi ${escapeHtml(username || 'there')},</p>
    <div style="color:#e4e4e7;font-size:14px;line-height:1.7;margin-top:12px;white-space:pre-wrap;">${bodyHtml}</div>
  `);
  const text = `Hi ${username || 'there'},\n\n${bodyText}`;
  return sendMail({ to, subject, html, text });
}

module.exports = {
  isConfigured, sendMail, getUsageToday, getDailyLimit,
  sendPasswordResetEmail, sendNewAccountEmail, sendWelcomeEmail,
  sendVerificationEmail, sendPaymentReceivedEmail, sendSubscriptionEndingEmail,
  sendBroadcastEmail,
};
