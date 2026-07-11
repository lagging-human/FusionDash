const axios = require('axios');

const panelUrl = (process.env.PTERODACTYL_PANEL_URL || '').replace(/\/+$/, '');
const apiKey = process.env.PTERODACTYL_API_KEY;

const api = axios.create({
  baseURL: `${panelUrl}/api/application`,
  headers: {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    Accept: 'Application/vnd.pterodactyl.v1+json'
  }
});

/**
 * Find a Pterodactyl panel user by email, or create one.
 */
async function findOrCreatePanelUser({ email, username }) {
  const search = await api.get('/users', { params: { 'filter[email]': email } });
  const existing = search.data.data?.[0];
  if (existing) return existing;

  const randomPassword = Math.random().toString(36).slice(-12) + 'Aa1!';
  const safeUsername = (username || email.split('@')[0])
    .replace(/[^a-zA-Z0-9_]/g, '')
    .slice(0, 32) || `user${Date.now()}`;

  const res = await api.post('/users', {
    email,
    username: safeUsername,
    first_name: safeUsername,
    last_name: 'User',
    password: randomPassword
  });
  return res.data;
}

async function getPanelUser(panelUserId) {
  const res = await api.get(`/users/${panelUserId}`);
  return res.data;
}

/**
 * List all nests with their eggs (for the create-server picker).
 * Returns: [{ id, name, eggs: [{ id, name }] }]
 */
async function listNestsWithEggs() {
  const nestsRes = await api.get('/nests', { params: { per_page: 100 } });
  const nests = nestsRes.data.data;

  const result = [];
  for (const nest of nests) {
    const eggsRes = await api.get(`/nests/${nest.attributes.id}/eggs`, { params: { per_page: 100 } });
    result.push({
      id: nest.attributes.id,
      name: nest.attributes.name,
      eggs: eggsRes.data.data.map(e => ({
        id: e.attributes.id,
        name: e.attributes.name
      }))
    });
  }
  return result;
}

/**
 * List all nodes with location names (for the create-server picker).
 * Returns: [{ id, name, location_id, fqdn }]
 */
async function listNodes() {
  const res = await api.get('/nodes', { params: { per_page: 100, include: 'location' } });
  return res.data.data.map(n => ({
    id: n.attributes.id,
    name: n.attributes.name,
    location_id: n.attributes.location_id,
    fqdn: n.attributes.fqdn,
    maintenance_mode: n.attributes.maintenance_mode
  }));
}

/**
 * Get egg details (docker image, startup, default env vars).
 */
async function getEgg(nestId, eggId) {
  const res = await api.get(`/nests/${nestId}/eggs/${eggId}`, { params: { include: 'variables' } });
  const egg = res.data.attributes;
  const environment = {};
  for (const v of egg.relationships?.variables?.data || []) {
    environment[v.attributes.env_variable] = v.attributes.default_value;
  }
  return { egg, environment };
}

/**
 * Find up to `count` free (unassigned) allocations on the given node.
 * Returns an array of allocation ids (may be shorter than `count` if the
 * node doesn't have enough free allocations).
 */
async function findFreeAllocations(nodeId, count) {
  const found = [];
  let page = 1;
  while (found.length < count) {
    const res = await api.get(`/nodes/${nodeId}/allocations`, { params: { per_page: 100, page } });
    for (const a of res.data.data) {
      if (!a.attributes.assigned) found.push(a.attributes.id);
      if (found.length >= count) break;
    }
    const meta = res.data.meta?.pagination;
    if (!meta || page >= meta.total_pages) break;
    page++;
  }
  return found;
}

/**
 * Find a free (unassigned) allocation on the given node.
 * Returns the allocation id, or null if none available.
 */
async function findFreeAllocation(nodeId) {
  const [id] = await findFreeAllocations(nodeId, 1);
  return id || null;
}

/**
 * Create a server for a panel user on a specific node, nest, and egg.
 * specs: { memory, disk, cpu, databases, backups, ports }
 */
async function createServer({ panelUserId, name, nestId, eggId, nodeId, specs, description }) {
  const { egg, environment } = await getEgg(nestId, eggId);

  const portCount = Math.max(1, parseInt(specs.ports, 10) || 1);
  const allocationIds = await findFreeAllocations(nodeId, portCount);
  if (!allocationIds.length) {
    throw new Error(`No free allocations available on node ${nodeId}`);
  }
  if (allocationIds.length < portCount) {
    throw new Error(`Only ${allocationIds.length} of ${portCount} requested port allocations are free on node ${nodeId}`);
  }

  const payload = {
    name,
    description: description || '',
    user: panelUserId,
    egg: eggId,
    docker_image: egg.docker_image,
    startup: egg.startup,
    environment,
    limits: {
      memory: specs.memory,
      swap: 0,
      disk: specs.disk,
      io: 500,
      cpu: specs.cpu
    },
    feature_limits: {
      databases: specs.databases ?? 1,
      backups: specs.backups ?? 1,
      allocations: portCount
    },
    allocation: {
      default: allocationIds[0],
      additional: allocationIds.slice(1)
    }
  };

  const res = await api.post('/servers', payload);
  return res.data;
}

/**
 * Update a server's build/resource limits.
 */
async function updateServerBuild(serverId, specs) {
  const res = await api.patch(`/servers/${serverId}/build`, {
    limits: {
      memory: specs.memory,
      swap: 0,
      disk: specs.disk,
      io: 500,
      cpu: specs.cpu
    },
    feature_limits: {
      databases: specs.databases ?? 1,
      backups: specs.backups ?? 1,
      allocations: Math.max(1, parseInt(specs.ports, 10) || 1)
    }
  });
  return res.data;
}

/**
 * Delete a server (force = true also deletes if suspended).
 */
async function deleteServer(serverId, force = false) {
  const url = force ? `/servers/${serverId}/force` : `/servers/${serverId}`;
  await api.delete(url);
}

module.exports = {
  api,
  findOrCreatePanelUser,
  getPanelUser,
  listNestsWithEggs,
  listNodes,
  getEgg,
  findFreeAllocation,
  createServer,
  updateServerBuild,
  deleteServer
};
