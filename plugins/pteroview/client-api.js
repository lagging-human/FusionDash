'use strict';
/**
 * client-api.js — Pterodactyl *Client* API, authenticated as the individual
 * user (their own key), not the app's admin Application API key.
 *
 * This is a deliberately different credential from pterodactyl.js at the
 * app root: the Application API (admin-wide key) can create/delete servers
 * and users, but has no access to console, files, databases, subusers,
 * startup variables, etc. — those are exclusively Client API, and Pterodactyl
 * only issues Client API keys to the account they belong to. There's no
 * admin endpoint to mint one on a user's behalf. So: each user pastes their
 * own key (generated in their Pterodactyl account under Account Settings ->
 * API Credentials), FusionDash stores it encrypted (crypto-util.js), and
 * this module uses it for calls made on that user's behalf.
 */
const axios = require('axios');
const { decrypt } = require('../../crypto-util');

const PANEL_URL = (process.env.PTERODACTYL_PANEL_URL || '').replace(/\/+$/, '');

function clientFor(user) {
  const key = decrypt(user.pterodactyl_client_key_enc);
  if (!key) return null;
  return axios.create({
    baseURL: `${PANEL_URL}/api/client`,
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Accept: 'Application/vnd.pterodactyl.v1+json',
    },
    timeout: 15000,
  });
}

/** Validates a raw (not-yet-encrypted) key by pinging /account. Returns the panel email on success, or null. */
async function validateKey(rawKey) {
  try {
    const res = await axios.get(`${PANEL_URL}/api/client/account`, {
      headers: { Authorization: `Bearer ${rawKey}`, Accept: 'Application/vnd.pterodactyl.v1+json' },
      timeout: 10000,
    });
    return res.data?.attributes?.email || true;
  } catch {
    return null;
  }
}

function unwrapList(res) { return (res.data?.data || []).map(d => d.attributes); }

const pteroClient = {
  resources:      (user, id) => clientFor(user).get(`/servers/${id}/resources`).then(r => r.data.attributes),
  websocketToken: (user, id) => clientFor(user).get(`/servers/${id}/websocket`).then(r => r.data.data),
  listFiles:      (user, id, dir = '/') => clientFor(user).get(`/servers/${id}/files/list`, { params: { directory: dir } }).then(unwrapList),
  deleteFiles:    (user, id, root, files) => clientFor(user).post(`/servers/${id}/files/delete`, { root, files }),
  readFile:       (user, id, filePath) => clientFor(user).get(`/servers/${id}/files/contents`, { params: { file: filePath }, responseType: 'text', transformResponse: (d) => d }).then(r => r.data),
  writeFile:      (user, id, filePath, content) => clientFor(user).post(`/servers/${id}/files/write`, content, { params: { file: filePath }, headers: { 'Content-Type': 'text/plain' } }),
  listDatabases:  (user, id) => clientFor(user).get(`/servers/${id}/databases`, { params: { include: 'password' } }).then(unwrapList),
  deleteDatabase: (user, id, dbId) => clientFor(user).delete(`/servers/${id}/databases/${dbId}`),
  listSubusers:   (user, id) => clientFor(user).get(`/servers/${id}/users`).then(unwrapList),
  inviteSubuser:  (user, id, email, permissions) => clientFor(user).post(`/servers/${id}/users`, { email, permissions }),
  removeSubuser:  (user, id, subuserId) => clientFor(user).delete(`/servers/${id}/users/${subuserId}`),
  serverDetails:  (user, id) => clientFor(user).get(`/servers/${id}`).then(r => r.data.attributes),
  renameServer:   (user, id, name, description) => clientFor(user).post(`/servers/${id}/settings/rename`, { name, description }),
  listStartup:    (user, id) => clientFor(user).get(`/servers/${id}/startup`).then(r => ({
                    variables: unwrapList(r), meta: r.data.meta,
                  })),
  updateStartupVariable: (user, id, key, value) => clientFor(user).put(`/servers/${id}/startup/variable`, { key, value }),
  hasKey:         (user) => !!user.pterodactyl_client_key_enc,
  validateKey,
};

module.exports = pteroClient;
