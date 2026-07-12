/**
 * auto-update.js
 * Checks https://github.com/lagging-human/FusionDash for new releases/commits.
 * If a newer version is found, pulls the latest changes and restarts via PM2
 * (or plain process.exit so the process manager / nodemon restarts it).
 *
 * Runs on startup and then every AUTOUPDATE_INTERVAL_MINUTES (default 30 min).
 */
const { execSync, exec } = require('child_process');
const axios = require('axios');
const path  = require('path');
const fs    = require('fs');

const REPO_API   = 'https://api.github.com/repos/lagging-human/FusionDash';
const ROOT       = path.resolve(__dirname);
const STAMP_FILE = path.join(ROOT, '.last_update_sha');
const IGNORE_FILE = path.join(ROOT, '.fusionignore');
const BACKUP_DIR  = path.join(require('os').tmpdir(), 'fusiondash-update-backup');
const INTERVAL   = parseInt(process.env.AUTOUPDATE_INTERVAL_MINUTES || '30', 10) * 60 * 1000;
const ENABLED    = process.env.AUTO_UPDATE !== 'false';

function log(msg) { console.log(`[AutoUpdate] ${msg}`); }

// ── .fusionignore: paths that must survive `git reset --hard` untouched ─────
function readIgnoreList() {
  try {
    return fs.readFileSync(IGNORE_FILE, 'utf8')
      .split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'));
  } catch { return []; }
}

function backupIgnoredPaths() {
  const list = readIgnoreList();
  if (!list.length) return [];
  fs.rmSync(BACKUP_DIR, { recursive: true, force: true });
  const kept = [];
  for (const rel of list) {
    const src = path.join(ROOT, rel);
    if (!fs.existsSync(src)) continue;
    const dest = path.join(BACKUP_DIR, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(src, dest, { recursive: true });
    kept.push(rel);
  }
  return kept;
}

function restoreIgnoredPaths(list) {
  for (const rel of list) {
    const src = path.join(BACKUP_DIR, rel);
    const dest = path.join(ROOT, rel);
    if (!fs.existsSync(src)) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.rmSync(dest, { recursive: true, force: true });
    fs.cpSync(src, dest, { recursive: true });
  }
  fs.rmSync(BACKUP_DIR, { recursive: true, force: true });
}

function readLocalSha() {
  try { return fs.readFileSync(STAMP_FILE, 'utf8').trim(); } catch { return null; }
}

function writeLocalSha(sha) {
  fs.writeFileSync(STAMP_FILE, sha, 'utf8');
}

function getGitHeadSha() {
  try { return execSync('git rev-parse HEAD', { cwd: ROOT }).toString().trim(); } catch { return null; }
}

async function getLatestCommitSha() {
  const res = await axios.get(`${REPO_API}/commits/main`, {
    headers: { Accept: 'application/vnd.github.v3+json', 'User-Agent': 'FusionDash-Updater' }
  });
  return res.data.sha;
}

async function getLatestRelease() {
  try {
    const res = await axios.get(`${REPO_API}/releases/latest`, {
      headers: { Accept: 'application/vnd.github.v3+json', 'User-Agent': 'FusionDash-Updater' }
    });
    return res.data.tag_name || null;
  } catch { return null; }
}

function pullAndRestart() {
  log('Pulling latest changes…');
  try {
    const protectedPaths = backupIgnoredPaths();
    if (protectedPaths.length) log(`Protecting from .fusionignore: ${protectedPaths.join(', ')}`);

    execSync('git fetch --all && git reset --hard origin/main', { cwd: ROOT, stdio: 'inherit' });

    if (protectedPaths.length) {
      restoreIgnoredPaths(protectedPaths);
      log('Restored protected paths.');
    }

    execSync('npm install --production', { cwd: ROOT, stdio: 'inherit' });
    log('Update complete. Restarting…');

    // Write the new sha so we don't re-update on the next check
    const newSha = getGitHeadSha();
    if (newSha) writeLocalSha(newSha);

    // Prefer PM2 restart if available
    exec('pm2 restart fusiondash 2>/dev/null || pm2 restart all 2>/dev/null', (err) => {
      if (err) {
        log('PM2 not available, using process.exit(0) — ensure a process manager restarts the app.');
        process.exit(0);
      }
    });
  } catch (err) {
    log(`Update failed: ${err.message}`);
  }
}

async function checkForUpdate() {
  if (!ENABLED) return;
  try {
    const remoteSha  = await getLatestCommitSha();
    const localSha   = readLocalSha() || getGitHeadSha();
    const latestTag  = await getLatestRelease();

    if (latestTag) log(`Latest release: ${latestTag}`);
    log(`Remote SHA: ${remoteSha?.slice(0, 7)} | Local SHA: ${localSha?.slice(0, 7)}`);

    if (!remoteSha) return;
    if (localSha === remoteSha) { log('Already up to date.'); return; }

    log(`New version detected (${remoteSha.slice(0, 7)}). Updating…`);
    pullAndRestart();
  } catch (err) {
    log(`Update check failed: ${err.message}`);
  }
}

function startAutoUpdater() {
  if (!ENABLED) { log('Auto-update disabled (AUTO_UPDATE=false).'); return; }
  log(`Auto-updater started. Checking every ${INTERVAL / 60000} min.`);
  // Initial check after 10 seconds (let server finish booting first)
  setTimeout(checkForUpdate, 10_000);
  setInterval(checkForUpdate, INTERVAL);
}

module.exports = { startAutoUpdater, checkForUpdate };
