'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

/**
 * Validate an email address for local (password-based) signup.
 *
 * Gmail — and Google Workspace addresses riding on Gmail's infrastructure —
 * treat "name+anything@gmail.com" as an alias of "name@gmail.com". Left
 * unchecked, that lets one inbox register unlimited accounts (free servers,
 * repeat coin bonuses, etc). We reject any '+' in the local part for every
 * signup, not just @gmail.com addresses, since that's the simplest rule
 * that closes the loophole and it doesn't cost legitimate users anything.
 */
function validateEmailForSignup(rawEmail) {
  const email = normalizeEmail(rawEmail);
  if (!email) return { ok: false, message: 'Email is required.' };
  if (!EMAIL_RE.test(email)) return { ok: false, message: 'Enter a valid email address.' };
  const localPart = email.split('@')[0];
  if (localPart.includes('+')) {
    return { ok: false, message: "Email addresses containing a '+' are not allowed." };
  }
  return { ok: true, email };
}

function validatePassword(password) {
  if (!password || password.length < 8) {
    return { ok: false, message: 'Password must be at least 8 characters.' };
  }
  if (password.length > 128) {
    return { ok: false, message: 'Password is too long.' };
  }
  return { ok: true };
}

async function hashPassword(password) {
  const salt = await bcrypt.genSalt(12);
  return bcrypt.hash(password, salt);
}

function verifyPassword(password, hash) {
  if (!hash) return Promise.resolve(false);
  return bcrypt.compare(password, hash);
}

/** Raw token goes in the emailed link; only its hash is ever stored. */
function generateRawToken() {
  return crypto.randomBytes(32).toString('hex');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

/** Unambiguous charset (no 0/O/1/l/I) for admin-generated temporary passwords. */
function generateRandomPassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const body = Array.from({ length: 14 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  return body + '#9'; // guarantee it clears length/complexity checks
}

module.exports = {
  normalizeEmail,
  validateEmailForSignup,
  validatePassword,
  hashPassword,
  verifyPassword,
  generateRawToken,
  hashToken,
  generateRandomPassword,
};
