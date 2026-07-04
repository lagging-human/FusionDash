const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'data.sqlite'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id                    TEXT PRIMARY KEY,
  provider              TEXT NOT NULL,
  username              TEXT,
  email                 TEXT,
  avatar                TEXT,
  pterodactyl_user_id   INTEGER,
  is_admin              INTEGER DEFAULT 0,
  coins                 INTEGER DEFAULT 0,
  res_memory            INTEGER DEFAULT 0,
  res_disk              INTEGER DEFAULT 0,
  res_cpu               INTEGER DEFAULT 0,
  res_ports             INTEGER DEFAULT 0,
  res_databases         INTEGER DEFAULT 0,
  res_backups           INTEGER DEFAULT 0,
  used_memory           INTEGER DEFAULT 0,
  used_disk             INTEGER DEFAULT 0,
  used_cpu              INTEGER DEFAULT 0,
  used_ports            INTEGER DEFAULT 0,
  used_databases        INTEGER DEFAULT 0,
  used_backups          INTEGER DEFAULT 0,
  last_daily_claim      TEXT,
  last_workink_claim    TEXT,
  created_at            TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS servers (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id                 TEXT NOT NULL,
  pterodactyl_server_id   INTEGER,
  pterodactyl_identifier  TEXT,
  name                    TEXT,
  description             TEXT,
  plan                    TEXT DEFAULT 'free',
  egg_id                  INTEGER,
  nest_id                 INTEGER,
  node_id                 INTEGER,
  memory                  INTEGER,
  disk                    INTEGER,
  cpu                     INTEGER,
  ports                   INTEGER DEFAULT 1,
  databases               INTEGER DEFAULT 0,
  backups                 INTEGER DEFAULT 0,
  subscription_active     INTEGER DEFAULT 0,
  subscription_gateway    TEXT,
  billing_cycle_start     TEXT,
  billing_cycle_end       TEXT,
  created_at              TEXT DEFAULT (datetime('now')),
  FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS plans (
  key           TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  price_inr     INTEGER DEFAULT 0,
  price_usd     REAL DEFAULT 0,
  memory        INTEGER,
  disk          INTEGER,
  cpu           INTEGER,
  databases     INTEGER DEFAULT 1,
  backups       INTEGER DEFAULT 1,
  active        INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS transactions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id           TEXT NOT NULL,
  server_id         INTEGER,
  plan_key          TEXT,
  gateway           TEXT,
  gateway_order_id  TEXT,
  gateway_ref       TEXT,
  amount            REAL,
  currency          TEXT,
  status            TEXT DEFAULT 'pending',
  type              TEXT DEFAULT 'new',
  deploy_config     TEXT,
  created_at        TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS store_items (
  key         TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  resource    TEXT NOT NULL,
  amount      INTEGER NOT NULL,
  cost        INTEGER NOT NULL,
  active      INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id    TEXT NOT NULL,
  admin_name  TEXT,
  action      TEXT NOT NULL,
  target_type TEXT,
  target_id   TEXT,
  target_name TEXT,
  detail      TEXT,
  ip          TEXT,
  created_at  TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS server_queue (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL,
  payload     TEXT NOT NULL,
  status      TEXT DEFAULT 'pending',
  error       TEXT,
  server_id   INTEGER,
  created_at  TEXT DEFAULT (datetime('now')),
  started_at  TEXT,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS coin_transactions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL,
  delta       INTEGER NOT NULL,
  reason      TEXT,
  ref         TEXT,
  created_at  TEXT DEFAULT (datetime('now'))
);
`);

const migrations = [
  `ALTER TABLE servers ADD COLUMN subscription_active INTEGER DEFAULT 0`,
  `ALTER TABLE servers ADD COLUMN subscription_gateway TEXT`,
  `ALTER TABLE servers ADD COLUMN billing_cycle_start TEXT`,
  `ALTER TABLE servers ADD COLUMN billing_cycle_end TEXT`,
  `ALTER TABLE servers ADD COLUMN description TEXT`,
  `ALTER TABLE servers ADD COLUMN ports INTEGER DEFAULT 1`,
  `ALTER TABLE servers ADD COLUMN renewal_due TEXT`,
  `ALTER TABLE servers ADD COLUMN renewal_suspended INTEGER DEFAULT 0`,
  `ALTER TABLE transactions ADD COLUMN type TEXT DEFAULT 'new'`,
  `ALTER TABLE users ADD COLUMN coins INTEGER DEFAULT 0`,
  `ALTER TABLE users ADD COLUMN res_memory INTEGER DEFAULT 0`,
  `ALTER TABLE users ADD COLUMN res_disk INTEGER DEFAULT 0`,
  `ALTER TABLE users ADD COLUMN res_cpu INTEGER DEFAULT 0`,
  `ALTER TABLE users ADD COLUMN res_ports INTEGER DEFAULT 0`,
  `ALTER TABLE users ADD COLUMN res_databases INTEGER DEFAULT 0`,
  `ALTER TABLE users ADD COLUMN res_backups INTEGER DEFAULT 0`,
  `ALTER TABLE users ADD COLUMN used_memory INTEGER DEFAULT 0`,
  `ALTER TABLE users ADD COLUMN used_disk INTEGER DEFAULT 0`,
  `ALTER TABLE users ADD COLUMN used_cpu INTEGER DEFAULT 0`,
  `ALTER TABLE users ADD COLUMN used_ports INTEGER DEFAULT 0`,
  `ALTER TABLE users ADD COLUMN used_databases INTEGER DEFAULT 0`,
  `ALTER TABLE users ADD COLUMN used_backups INTEGER DEFAULT 0`,
  `ALTER TABLE users ADD COLUMN last_daily_claim TEXT`,
  `ALTER TABLE users ADD COLUMN last_workink_claim TEXT`,
];
for (const m of migrations) { try { db.exec(m); } catch {} }

const defaultSettings = {
  default_memory:     '6144',
  default_disk:       '5120',
  default_cpu:        '80',
  default_ports:      '2',
  default_databases:  '1',
  default_backups:    '1',
  pterodactyl_node_id:     '',
  pterodactyl_egg_id:      '',
  pterodactyl_nest_id:     '',
  pterodactyl_location_id: '',
  daily_coins:             '50',
  workink_coins:           '20',
  workink_api_key:         '',
  workink_offer_id:        '',
  paymentwall_app_key:     '',
  paymentwall_secret_key:  '',
  paymentwall_widget:      'mw6',
  paymentwall_coins:       '30',
  notik_api_key:           '',
  notik_secret_key:        '',
  notik_coins:             '25',
  notik_offer_url:         '',
  app_name:            'FusionDash',
  app_favicon_url:     '',
  renewal_enabled:     '0',
  renewal_price:       '5',
  renewal_days:        '30',
  renewal_grace_days:  '1',
  queue_enabled:       '1',
  queue_delay_seconds: '120',
  queue_max_parallel:  '1',
  dashboard_url:           'http://localhost:3000',
};
const ins = db.prepare('INSERT OR IGNORE INTO settings (key,value) VALUES (?,?)');
for (const [k, v] of Object.entries(defaultSettings)) ins.run(k, v);

const insItem = db.prepare(`
  INSERT OR IGNORE INTO store_items (key,name,description,resource,amount,cost,active)
  VALUES (@key,@name,@description,@resource,@amount,@cost,@active)
`);
insItem.run({ key: 'ram_1gb',   name: '1 GB RAM',   description: 'Add 1 GB of RAM to your pool',     resource: 'memory',    amount: 1024,  cost: 10, active: 1 });
insItem.run({ key: 'ram_2gb',   name: '2 GB RAM',   description: 'Add 2 GB of RAM to your pool',     resource: 'memory',    amount: 2048,  cost: 18, active: 1 });
insItem.run({ key: 'disk_5gb',  name: '5 GB Disk',  description: 'Add 5 GB of disk to your pool',    resource: 'disk',      amount: 5120,  cost: 8,  active: 1 });
insItem.run({ key: 'disk_10gb', name: '10 GB Disk', description: 'Add 10 GB of disk to your pool',   resource: 'disk',      amount: 10240, cost: 14, active: 1 });
insItem.run({ key: 'cpu_50',    name: '50% CPU',    description: 'Add 50% CPU to your pool',         resource: 'cpu',       amount: 50,    cost: 12, active: 1 });
insItem.run({ key: 'port_1',    name: '1 Port',     description: 'Add 1 extra port allocation',      resource: 'ports',     amount: 1,     cost: 5,  active: 1 });
insItem.run({ key: 'db_1',      name: '1 Database', description: 'Add 1 database slot to your pool', resource: 'databases', amount: 1,     cost: 6,  active: 1 });
insItem.run({ key: 'backup_1',  name: '1 Backup',   description: 'Add 1 backup slot to your pool',   resource: 'backups',   amount: 1,     cost: 4,  active: 1 });
insItem.run({ key: 'coins_100', name: '100 Coins',  description: 'Buy 100 coins (costs ₹49)',         resource: 'coins',     amount: 100,   cost: 0,  active: 0 });

const insPlan = db.prepare(`
  INSERT OR IGNORE INTO plans (key,name,price_inr,price_usd,memory,disk,cpu,databases,backups,active)
  VALUES (@key,@name,@price_inr,@price_usd,@memory,@disk,@cpu,@databases,@backups,@active)
`);
insPlan.run({ key: 'basic', name: 'Basic', price_inr: 9900,  price_usd: 1.5, memory: 2048, disk: 5120,  cpu: 150, databases: 2, backups: 2, active: 1 });
insPlan.run({ key: 'pro',   name: 'Pro',   price_inr: 24900, price_usd: 3.5, memory: 4096, disk: 10240, cpu: 200, databases: 3, backups: 3, active: 1 });
insPlan.run({ key: 'ultra', name: 'Ultra', price_inr: 49900, price_usd: 7,   memory: 8192, disk: 20480, cpu: 300, databases: 5, backups: 5, active: 1 });

module.exports = db;
