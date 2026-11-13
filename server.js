const express = require('express');
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

let XLSX = null;
try {
  XLSX = require('xlsx');
} catch (e) {
  console.warn("⚠️ Module 'xlsx' non installé. Lancez 'npm install' pour importer automatiquement depuis Excel.");
}

BigInt.prototype.toJSON = function() { return Number(this); };

const app = express();
const PORT = process.env.PORT || 3000;
function loadJwtSecret() {
  if (process.env.JWT_SECRET && process.env.JWT_SECRET.length >= 32) return process.env.JWT_SECRET;
  const f = path.join(__dirname, '.jwt_secret');
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  const s = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(f, s, { mode: 0o600 });
  console.warn('🔐 Clé JWT générée dans .jwt_secret (définissez JWT_SECRET en production).');
  return s;
}
const JWT_SECRET = loadJwtSecret();

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer'
  });
  if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
  next();
});
app.use(express.json({ limit: '3mb' }));
app.param('id', (req, res, next, v) => (/^\d+$/.test(v) ? next() : res.status(400).json({ error: 'ID invalide' })));
app.use(express.static(path.join(__dirname, 'public')));

let photosDir = path.join(__dirname, 'public', 'photos');
if (!fs.existsSync(photosDir)) {
  const rootPhotos = path.join(__dirname, 'photos');
  if (fs.existsSync(rootPhotos)) {
    photosDir = rootPhotos;
  } else {
    fs.mkdirSync(photosDir, { recursive: true });
  }
}
app.use('/photos', express.static(photosDir));

const db = new DatabaseSync(path.join(__dirname, 'bb_int_sebn.db'));
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA busy_timeout = 5000;');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    role TEXT CHECK(role IN ('admin', 'supervisor', 'team_leader', 'technician')) NOT NULL,
    matricule TEXT UNIQUE NOT NULL,
    full_name TEXT NOT NULL,
    birth_date TEXT,
    hire_date TEXT,
    family_status TEXT DEFAULT 'Célibataire',
    must_change_password INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS points_catalog (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    point_name TEXT UNIQUE NOT NULL,
    reference_code TEXT NOT NULL,
    family TEXT NOT NULL,
    unit_price REAL DEFAULT 0,
    image_data TEXT
  );

  CREATE TABLE IF NOT EXISTS repairs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    technician_id INTEGER,
    technician_name TEXT NOT NULL,
    matricule TEXT NOT NULL,
    operation_date TEXT NOT NULL,
    shift TEXT DEFAULT 'Shift 1',
    zone TEXT NOT NULL,
    panel_name TEXT NOT NULL,
    panel_number TEXT NOT NULL,
    point_name TEXT NOT NULL,
    reference_code TEXT NOT NULL,
    point_type TEXT NOT NULL,
    item_inspected TEXT NOT NULL,
    intervention_type TEXT NOT NULL,
    defect_type TEXT NOT NULL,
    spare_part_id INTEGER,
    spare_part_name TEXT DEFAULT '0',
    spare_parts_qty INTEGER DEFAULT 0,
    unit_price_eur REAL DEFAULT 0,
    total_cost_eur REAL DEFAULT 0,
    repair_duration INTEGER DEFAULT 0,
    downtime_duration INTEGER DEFAULT 0,
    stops_machine INTEGER DEFAULT 0,
    observations TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS operation_mappings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    operation_type TEXT UNIQUE NOT NULL,
    defect_types TEXT NOT NULL DEFAULT '[]',
    pdr_sources TEXT NOT NULL DEFAULT '[]'
  );

  CREATE TABLE IF NOT EXISTS options_config (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT NOT NULL,
    option_value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS carts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cart_name TEXT NOT NULL,
    zone_assigned TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS cart_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cart_id INTEGER NOT NULL,
    item_name TEXT NOT NULL,
    reference_code TEXT NOT NULL,
    quantity INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS panels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    panel_name TEXT NOT NULL,
    panel_number TEXT NOT NULL,
    current_zone TEXT NOT NULL
  );
`);

const ensureAllTechnicians = () => {
  const insertUser = db.prepare(`
    INSERT INTO users (username, password, role, matricule, full_name, must_change_password)
    VALUES (?, ?, ?, ?, ?, 1)
    ON CONFLICT(matricule) DO NOTHING
  `);

  const exists = db.prepare('SELECT 1 FROM users WHERE matricule = ?');
  for (const [uname, mat, full] of [['khalid', '10001', 'Khalid Hmimsa'], ['mehdi', '10002', 'Mehdi Habti']]) {
    if (exists.get(mat)) continue;
    const initial = crypto.randomBytes(4).toString('base64url');
    insertUser.run(uname, bcrypt.hashSync(initial, 12), 'supervisor', mat, full);
    console.log(`🔑 Compte initial créé : ${uname} / ${initial}`);
  }
};
ensureAllTechnicians();

const ensureDefaults = () => {
  const defaultZones = ['TFL-01', 'TFL-02', 'TFL-03', 'TFL-04', 'MTT', 'Rework', 'Backup'];
  const count = db.prepare('SELECT COUNT(*) as cnt FROM options_config').get().cnt;
  if (count === 0) {
    const ins = db.prepare('INSERT INTO options_config (category, option_value) VALUES (?, ?)');
    defaultZones.forEach(z => ins.run('zone', z));
  }
};
ensureDefaults();

function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Non connecté' });
  try {
    const payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    const user = db.prepare('SELECT id, username, role, matricule, full_name, must_change_password FROM users WHERE id = ?').get(payload.id);
    if (!user) return res.status(401).json({ error: 'Compte introuvable' });
    req.user = user;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Session expirée' });
  }
}

app.use('/api', (req, res, next) => (req.path === '/login' ? next() : auth(req, res, next)));

app.post('/api/login', (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  if (!username || !password) return res.status(400).json({ error: 'Identifiants obligatoires' });

  const user = db.prepare('SELECT * FROM users WHERE username = ? OR matricule = ?').get(username, username);
  const valid = bcrypt.compareSync(password, user ? user.password : '') && !!user;
  if (!valid) return res.status(401).json({ error: 'Identifiants incorrects' });

  const token = jwt.sign({ id: user.id }, JWT_SECRET, { algorithm: 'HS256', expiresIn: '8h' });
  res.json({ token, must_change_password: !!user.must_change_password });
});

app.get('/api/me', auth, (req, res) => {
  const { id, username, role, matricule, full_name, must_change_password } = req.user;
  res.json({ id, username, role, matricule, full_name, must_change_password: !!must_change_password });
});

// المسار المضاف خصيصاً لتحديث البروفيل وكلمة المرور بدون أخطاء
app.put('/api/user/profile', auth, (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '').trim();
  const me = req.user;
  if (!username) return res.status(400).json({ error: 'Identifiant obligatoire' });
  
  if (password) {
    db.prepare('UPDATE users SET username = ?, password = ?, must_change_password = 0 WHERE id = ?')
      .run(username, bcrypt.hashSync(password, 12), me.id);
  } else {
    db.prepare('UPDATE users SET username = ? WHERE id = ?').run(username, me.id);
  }
  res.json({ success: true });
});

app.get('/api/operations', (req, res) => {
  res.json(db.prepare('SELECT * FROM repairs ORDER BY id DESC').all());
});

app.get('/api/points', (req, res) => {
  res.json(db.prepare('SELECT id, point_name, reference_code, family, unit_price, image_data FROM points_catalog ORDER BY point_name ASC').all());
});

app.get('/api/carts', (req, res) => {
  const carts = db.prepare('SELECT * FROM carts').all();
  const items = db.prepare('SELECT * FROM cart_items').all();
  res.json(carts.map(c => ({ ...c, items: items.filter(i => i.cart_id === c.id) })));
});

app.get('/api/panels', (req, res) => {
  res.json(db.prepare('SELECT * FROM panels ORDER BY current_zone, panel_name').all());
});

app.get('/api/config', (req, res) => {
  res.json({
    options: db.prepare('SELECT * FROM options_config').all(),
    mappings: db.prepare('SELECT * FROM operation_mappings').all()
  });
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Route introuvable' }));

const port = process.env.PORT || 3000;
const host = process.env.HOST || '0.0.0.0';

app.listen(port, host, () => {
  console.log(`Server running on port ${port}`);
});
