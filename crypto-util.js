'use strict';
/**
 * crypto-util.js — AES-256-GCM encrypt/decrypt for secrets stored in sqlite
 * (currently: each user's own Pterodactyl Client API key). Key is derived
 * from SESSION_SECRET via scrypt so there's no second secret to manage —
 * rotating SESSION_SECRET invalidates stored ciphertext, same as it already
 * invalidates sessions, which is an acceptable tradeoff for a value the
 * user can just re-paste.
 */
const crypto = require('crypto');

const SALT = 'fusiondash-static-salt-v1'; // fine to be non-secret/static — SESSION_SECRET is the actual secret
let cachedKey = null;
function getKey() {
  if (cachedKey) return cachedKey;
  const secret = process.env.SESSION_SECRET || 'changeme';
  cachedKey = crypto.scryptSync(secret, SALT, 32);
  return cachedKey;
}

function encrypt(plaintext) {
  if (!plaintext) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

function decrypt(ciphertextB64) {
  if (!ciphertextB64) return null;
  try {
    const raw = Buffer.from(ciphertextB64, 'base64');
    const iv = raw.subarray(0, 12), tag = raw.subarray(12, 28), enc = raw.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  } catch {
    return null; // wrong key / corrupted / tampered — treat as "not set"
  }
}

module.exports = { encrypt, decrypt };
