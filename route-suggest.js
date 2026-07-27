'use strict';
/**
 * route-suggest.js — "did you mean /dashboard?" matching for the 404 page.
 *
 * Only matches against human-navigable pages (not webhooks/callbacks/API
 * routes/param routes), and only suggests something if it's actually close
 * enough to be a plausible typo — otherwise the 404 page just shows no
 * suggestion rather than a misleading unrelated link.
 */

// Curated, not auto-derived from the route table on purpose: /auth/*/callback,
// /earn/*/callback, /api/*, /checkout/*, /verify-email/:token etc. are webhook/
// programmatic endpoints a person would never navigate to by hand, and
// suggesting them after a typo would be actively confusing.
const NAVIGABLE_ROUTES = [
  { path: '/dashboard',  label: 'Dashboard' },
  { path: '/servers',    label: 'My Servers' },
  { path: '/servers/create', label: 'New Server' },
  { path: '/store',      label: 'Store' },
  { path: '/earn',       label: 'Earn Coins' },
  { path: '/billing',    label: 'Plans & Billing' },
  { path: '/plans',      label: 'Plans' },
  { path: '/account',    label: 'Account Settings' },
  { path: '/account/reset-password', label: 'Panel Password' },
  { path: '/login',      label: 'Sign In' },
  { path: '/register',   label: 'Create Account' },
  { path: '/forgot-password', label: 'Forgot Password' },
  { path: '/admin',      label: 'Admin Panel' },
  { path: '/admin/audit', label: 'Audit Log' },
  { path: '/admin/themes', label: 'Theme Editor' },
  { path: '/admin/email', label: 'Email Broadcast' },
  { path: '/admin/users', label: 'Admin — Users' },
  { path: '/admin/servers', label: 'Admin — Servers' },
  { path: '/admin/plans', label: 'Admin — Plans' },
  { path: '/admin/store', label: 'Admin — Store Items' },
  { path: '/admin/nodes', label: 'Admin — Nodes' },
  { path: '/admin/eggs', label: 'Admin — Eggs' },
  { path: '/admin/apis', label: 'Admin — Earn APIs' },
  { path: '/admin/transactions', label: 'Admin — Transactions' },
];

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

/**
 * Returns the closest navigable route to `requestPath`, or null if nothing
 * is close enough to be a confident suggestion.
 */
function suggestRoute(requestPath, isAdmin) {
  const clean = String(requestPath || '').toLowerCase().replace(/\/+$/, '') || '/';
  const candidates = NAVIGABLE_ROUTES.filter(r => isAdmin || !r.path.startsWith('/admin'));

  let best = null, bestDist = Infinity;
  for (const r of candidates) {
    const dist = levenshtein(clean, r.path);
    if (dist < bestDist) { bestDist = dist; best = r; }
  }
  if (!best) return null;

  // Require the match to be reasonably close relative to path length — a
  // 2-character path being "closest" to a 20-character path by raw edit
  // distance is not actually a useful suggestion.
  const threshold = Math.max(3, Math.ceil(Math.max(clean.length, best.path.length) * 0.5));
  return bestDist <= threshold ? { ...best, distance: bestDist } : null;
}

module.exports = { suggestRoute, NAVIGABLE_ROUTES };
