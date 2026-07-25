'use strict';

const nodemailer = require('nodemailer');

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

module.exports = { isConfigured, sendMail, sendPasswordResetEmail, sendNewAccountEmail };
