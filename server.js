const express = require('express');
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

let XLSX = null;
try {
  XLSX = require('xlsx');
} catch (e) {
  console.warn("⚠️ Module 'xlsx' non installé. Lancez 'npm install' pour importer automatiquement depuis Excel.");
}

BigInt.prototype.toJSON = function() { return Number(this); };

const app = express();
const port = process.env.PORT || 3000;
const host = process.env.HOST || '0.0.0.0';
const JWT_SECRET = process.env.JWT_SECRET || 'sebn-secure-local-token-key-2026';

app.use(express.json({ limit: '50mb' }));
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

const dataDir = fs.existsSync('/data') ? '/data' : __dirname;
const dbPath = path.join(dataDir, 'bb_int_sebn.db');

// نسخ قاعدة البيانات الأولية إلى الديسك الدائم في أول تشغيل فقط
if (dataDir === '/data' && !fs.existsSync(dbPath) && fs.existsSync(path.join(__dirname, 'bb_int_sebn.db'))) {
  fs.copyFileSync(path.join(__dirname, 'bb_int_sebn.db'), dbPath);
}

const db = new DatabaseSync(dbPath);
console.log(`📦 Base de données active sur : ${dbPath}`);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA busy_timeout = 5000;');

try {
  const tableInfo = db.prepare("PRAGMA table_info(operation_mappings)").all();
  if (tableInfo.length > 0 && !tableInfo.some(c => c.name === 'defect_types')) {
    db.exec("DROP TABLE operation_mappings;");
  }
} catch (e) {
  console.warn("Migration notice:", e.message);
}

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

  CREATE TABLE IF NOT EXISTS cart_movements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cart_id INTEGER NOT NULL,
    item_id INTEGER NOT NULL,
    item_name TEXT NOT NULL,
    technician_name TEXT NOT NULL,
    action_type TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS daily_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    target_zone TEXT,
    shift_name TEXT,
    priority TEXT DEFAULT 'Normale',
    status TEXT DEFAULT 'pending'
  );

  CREATE TABLE IF NOT EXISTS shift_handovers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shift_name TEXT NOT NULL,
    outgoing_tech TEXT NOT NULL,
    incoming_tech TEXT NOT NULL,
    summary TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS panels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    panel_name TEXT NOT NULL,
    panel_number TEXT NOT NULL,
    current_zone TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS panel_movements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    panel_name TEXT NOT NULL,
    panel_number TEXT NOT NULL,
    from_zone TEXT NOT NULL,
    to_zone TEXT NOT NULL,
    operator_matricule TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

try { db.exec('ALTER TABLE users ADD COLUMN must_change_password INTEGER DEFAULT 0'); } catch (e) {}

const ensureAllTechnicians = () => {
  const insertUser = db.prepare(`
    INSERT INTO users (username, password, role, matricule, full_name, birth_date, hire_date, family_status, must_change_password)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
    ON CONFLICT(matricule) DO NOTHING
  `);

  const hashAdmin = bcrypt.hashSync('admin123', 10);
  insertUser.run('khalid', hashAdmin, 'supervisor', '10001', 'Khalid Hmimsa', '', '', 'Marié(e)');
  insertUser.run('mehdi', hashAdmin, 'supervisor', '10002', 'Mehdi Habti', '', '', 'Marié(e)');

  const techniciansList = [
    { matricule: '19871', name: 'Achraf Befoula' }, { matricule: '20954', name: 'Chouny ilyass' },
    { matricule: '19678', name: 'younes Bilal' }, { matricule: '19706', name: 'Ahanjir Taoufik' },
    { matricule: '20819', name: 'Azrour Azdinne' }, { matricule: '21060', name: 'Mohammed El jarti' },
    { matricule: '20991', name: 'Othmane Lamzouri' }, { matricule: '20953', name: 'Hicham Elkhalfouni' },
    { matricule: '21035', name: 'elasri abdelaali' }, { matricule: '15623', name: 'Mohammed Achraf Ziuan' },
    { matricule: '20746', name: 'Aimad Alaoui' }, { matricule: '21062', name: 'El guerouani Nouh' },
    { matricule: '19875', name: 'Abdellatif Mouhcin' }, { matricule: '15496', name: 'Atemni Mohammed' },
    { matricule: '20870', name: 'Samir Hrach_Aras' }, { matricule: '20179', name: 'souhail foulla' },
    { matricule: '20297', name: 'El habti El mehdi' }, { matricule: '20818', name: 'Driss Fahli' },
    { matricule: '21034', name: 'thitah saad' }, { matricule: '18242', name: 'Soulaiman Maimouni' },
    { matricule: '18037', name: 'Metouali oussama' }, { matricule: '20992', name: 'Yassine ghali' },
    { matricule: '17584', name: 'Lahcen Chahid' }, { matricule: '20906', name: 'Amine Boudasse' },
    { matricule: '20918', name: 'Achraf Gzal' }, { matricule: '21127', name: 'Ayoub Lahlou' },
    { matricule: '20908', name: 'Ayob Abbas' }, { matricule: '21126', name: 'Abde Nacer Eltourchi' },
    { matricule: '20917', name: 'Amine Legnafdi' }, { matricule: '14102', name: 'EL FARIHI AZEDINE' },
    { matricule: '7165',  name: 'ELHARRAK abderahim' }, { matricule: '7319',  name: 'Elhjiri ahmed' },
    { matricule: '21057', name: 'Arich Abdellah' }, { matricule: '17886', name: 'Mohamed EL FEDYLY' },
    { matricule: '20914', name: 'Yassine Lazrak' }
  ];

  db.exec('BEGIN TRANSACTION;');
  for (const tech of techniciansList) {
    const passwordHash = bcrypt.hashSync(tech.matricule, 10);
    insertUser.run(tech.matricule, passwordHash, 'technician', tech.matricule, tech.name, '', '', 'Célibataire');
  }
  db.exec('COMMIT;');
};
ensureAllTechnicians();

const ensureDefaults = () => {
  const newPieceTypes = [
    'Master', 'Slave A', 'Slave B', 'Slave', 'Carte communication', 'Power 12V',
    'Transformateur 12V', 'Power 24V', 'Transformateur 24V', 'Sensor, 60mm ground EH02.V160',
    'Sensor, 60mm ground', 'Micro switch', 'Label Printer', 'Câble RJ9', 'Multiprise',
    'Mounting', 'Photocellule', 'Photocellule 2', 'Switch', 'Domino single 3D',
    'Domino double 3D', 'Schrumpf photocellule', 'Extension', 'Frein', 'Point de soudage',
    'Guidage', 'Ressort', 'Pince crocodile', 'Passe-fil', 'Support', 'Charbon',
    'Support charbon', 'Simulation de panneau', 'CP', 'PC', 'Tige fixe', 'Tige mobile',
    'Tige pin', 'Tige spéciale', 'Tige four', 'Tige masse', 'Masse', 'Support contre-pièce',
    'Contre-pièce', 'Collier de visualisation', 'Ajustement de mesure', 'Alimentation PC',
    'Orientation CP', 'Imprimante', 'Câble VGA', 'Câble COM', 'Plaquette charbon',
    'Bassin', 'Communication', 'Rail', 'Sortie de panneau', 'Entrée de panneau',
    'Écrasement', 'Nettoyage de rail', 'Nettoyage d\'imprimante', 'Ajouter matricule',
    'Redémarrage PC', 'Fixation de panneau', 'Câble HDMI', 'Préventive de panneau'
  ];

  db.exec("DELETE FROM options_config WHERE category = 'piece_type';");
  const insertOpt = db.prepare('INSERT INTO options_config (category, option_value) VALUES (?, ?)');
  
  db.exec('BEGIN TRANSACTION;');
  for (const item of newPieceTypes) {
    insertOpt.run('piece_type', item.trim());
  }

  const existingOpts = db.prepare("SELECT category, option_value FROM options_config").all();
  const hasOpt = (cat, val) => existingOpts.some(e => e.category === cat && e.option_value.toLowerCase() === val.toLowerCase());

  const defaults = {
    zone: ['TFL-01', 'TFL-02', 'TFL-03', 'TFL-04', 'MTT', 'Rework', 'Backup', 'Zon Rép', 'Bridge'],
    machine: [
      'Q7-LL', 'Q7-RL', 'Q9-LL', 'Q9-RL', 'Q9-AH-LL', 'Q9-AH-RL',
      'Q7-LL-Mèr', 'Q7-RL-Mèr', 'Q9-LL-Mèr', 'Q9-RL-Mèr', 'Q9-AH-LL-Mèr', 'Q9-AH-RL-Mèr',
      'MTT-Q7-01', 'MTT-Q7-02', 'MTT-Q7-03', 'MTT-Q7-04', 'MTT-Q9-01', 'MTT-Q9-02', 'MTT-Q9-03',
      'Extension'
    ],
    operation_type: ['Changement', 'Réparation', 'Réglage', 'Sérrage', 'Montage', 'Esthétique', 'Corrective', 'Simulation', 'Ajout de panneau'],
    defect_type: ['Casse', 'Endommagé', 'Orientation', 'Resserrage', 'Manque', 'Dégradation', 'Remise en état', 'Vérif.Conformité', 'Demande PPR'],
    pdr_source: ['0', 'Magasin BB', 'Chariot', 'Magasin Central']
  };

  for (const [cat, items] of Object.entries(defaults)) {
    for (const item of items) {
      if (!hasOpt(cat, item)) insertOpt.run(cat, item);
    }
  }

  const defaultMappings = [
    ['Changement', JSON.stringify(['Casse', 'Endommagé']), JSON.stringify(['Magasin BB', 'Chariot', 'Magasin Central'])],
    ['Réparation', JSON.stringify(['Endommagé', 'Dégradation']), JSON.stringify(['Chariot', '0'])],
    ['Réglage', JSON.stringify(['Orientation']), JSON.stringify(['0'])],
    ['Sérrage', JSON.stringify(['Resserrage']), JSON.stringify(['0'])],
    ['Montage', JSON.stringify(['Manque']), JSON.stringify(['Magasin BB', 'Chariot'])],
    ['Esthétique', JSON.stringify(['Dégradation']), JSON.stringify(['0'])],
    ['Corrective', JSON.stringify(['Remise en état', 'Endommagé']), JSON.stringify(['Chariot', 'Magasin BB', '0'])],
    ['Simulation', JSON.stringify(['Vérif.Conformité']), JSON.stringify(['0'])],
    ['Ajout de panneau', JSON.stringify(['Demande PPR']), JSON.stringify(['0'])]
  ];

  const insertMapping = db.prepare(`
    INSERT INTO operation_mappings (operation_type, defect_types, pdr_sources)
    VALUES (?, ?, ?)
    ON CONFLICT(operation_type) DO NOTHING
  `);
  for (const [op, defs, srcs] of defaultMappings) {
    insertMapping.run(op, defs, srcs);
  }

  const cartsCount = db.prepare('SELECT COUNT(*) as cnt FROM carts').get().cnt;
  if (cartsCount === 0) {
    const c1 = Number(db.prepare('INSERT INTO carts (cart_name, zone_assigned) VALUES (?, ?)').run('Chariot Lignes TFL-01 & TFL-02', 'TFL-01').lastInsertRowid);
    const insertItem = db.prepare('INSERT INTO cart_items (cart_id, item_name, reference_code, quantity) VALUES (?, ?, ?, ?)');
    insertItem.run(c1, 'Frein de maintien', 'FRN-001', 25);
    insertItem.run(c1, 'Cellule Optique Détection', 'PH-CEL-99', 10);
  }

  const allPanelsList = [
    // TFL-01
    { name: 'Q7 LL 40', zone: 'TFL-01' }, { name: 'Q7 LL 44', zone: 'TFL-01' }, { name: 'Q7 LL 21', zone: 'TFL-01' },
    { name: 'Q7 RL 01', zone: 'TFL-01' }, { name: 'Q7 LL 24', zone: 'TFL-01' }, { name: 'Q7 LL 26', zone: 'TFL-01' },
    { name: 'Q7 LL 12', zone: 'TFL-01' }, { name: 'Q7 LL 38', zone: 'TFL-01' }, { name: 'Q7 LL 06', zone: 'TFL-01' },
    { name: 'Q7 RL 03', zone: 'TFL-01' }, { name: 'Q7 LL 07', zone: 'TFL-01' }, { name: 'Q7 LL 25', zone: 'TFL-01' },
    { name: 'Q7 LL 19', zone: 'TFL-01' }, { name: 'Q7 LL 35', zone: 'TFL-01' }, { name: 'Q7 LL 09', zone: 'TFL-01' },
    { name: 'Q7 RL 02', zone: 'TFL-01' }, { name: 'Q7 LL 03', zone: 'TFL-01' }, { name: 'Q7 LL 43', zone: 'TFL-01' },
    { name: 'Q7 LL 42', zone: 'TFL-01' }, { name: 'Q9 AH RL 01', zone: 'TFL-01' },
    // TFL-02
    { name: 'Q9 AH LL 05', zone: 'TFL-02' }, { name: 'Q9 AH LL 09', zone: 'TFL-02' }, { name: 'Q9 AH LL 01', zone: 'TFL-02' },
    { name: 'Q9 AH LL 10', zone: 'TFL-02' }, { name: 'Q9 AH LL 13', zone: 'TFL-02' }, { name: 'Q9 LL 03', zone: 'TFL-02' },
    { name: 'Q9 AH LL 07', zone: 'TFL-02' }, { name: 'Q9 AH LL 16', zone: 'TFL-02' }, { name: 'Q9 AH LL 06', zone: 'TFL-02' },
    { name: 'Q9 AH LL 03', zone: 'TFL-02' }, { name: 'Q9 AH LL 08', zone: 'TFL-02' }, { name: 'Q9 LL 04', zone: 'TFL-02' },
    { name: 'Q9 AH LL 11', zone: 'TFL-02' }, { name: 'Q9 AH LL 14', zone: 'TFL-02' }, { name: 'Q7 LL 29', zone: 'TFL-02' },
    { name: 'Q9 AH LL 12', zone: 'TFL-02' }, { name: 'Q9 AH LL 02', zone: 'TFL-02' }, { name: 'Q9 AH LL 04', zone: 'TFL-02' },
    { name: 'Q9 AH LL 18', zone: 'TFL-02' }, { name: 'Q9 LL 01', zone: 'TFL-02' },
    // TFL-03
    { name: 'Q7 LL 31', zone: 'TFL-03' }, { name: 'Q7 LL 28', zone: 'TFL-03' }, { name: 'Q7 LL 30', zone: 'TFL-03' },
    { name: 'Q7 LL 36', zone: 'TFL-03' }, { name: 'Q7 LL 32', zone: 'TFL-03' }, { name: 'Q7 LL 45', zone: 'TFL-03' },
    { name: 'Q7 LL 14', zone: 'TFL-03' }, { name: 'Q7 LL 05', zone: 'TFL-03' }, { name: 'Q7 LL 13', zone: 'TFL-03' },
    { name: 'Q7 LL 27', zone: 'TFL-03' }, { name: 'Q7 LL 22', zone: 'TFL-03' }, { name: 'Q7 LL 08', zone: 'TFL-03' },
    { name: 'Q7 LL 04', zone: 'TFL-03' }, { name: 'Q7 LL 47', zone: 'TFL-03' }, { name: 'Q7 LL 39', zone: 'TFL-03' },
    { name: 'Q7 LL 46', zone: 'TFL-03' }, { name: 'Q7 LL 11', zone: 'TFL-03' }, { name: 'Q7 LL 16', zone: 'TFL-03' },
    { name: 'Q7 LL 20', zone: 'TFL-03' }, { name: 'Q7 LL 33', zone: 'TFL-03' },
    // TFL-04
    { name: 'Q7 LL 48', zone: 'TFL-04' }, { name: 'Q9 LL 02', zone: 'TFL-04' }, { name: 'Q9 LL 05', zone: 'TFL-04' },
    { name: 'Q7 LL 01', zone: 'TFL-04' }, { name: 'Q7 LL 53', zone: 'TFL-04' }, { name: 'Q7 LL 23', zone: 'TFL-04' },
    { name: 'Q7 LL 10 Kaizen', zone: 'TFL-04' }, { name: 'AH LL 15', zone: 'TFL-04' }, { name: 'Q7 LL 60', zone: 'TFL-04' },
    { name: 'Q7 LL 59', zone: 'TFL-04' }, { name: 'Q7 LL 50', zone: 'TFL-04' }, { name: 'Q7 LL 52', zone: 'TFL-04' },
    { name: 'Q7 LL 57', zone: 'TFL-04' }, { name: 'Q7 LL 49', zone: 'TFL-04' }, { name: 'Q7 LL 37', zone: 'TFL-04' },
    { name: 'Q7 LL 41', zone: 'TFL-04' }, { name: 'Q7 LL 55', zone: 'TFL-04' }, { name: 'Q7 LL 54', zone: 'TFL-04' },
    { name: 'Q7 LL 51', zone: 'TFL-04' },
    // MTT
    { name: 'MTT 01 Q9', zone: 'MTT' }, { name: 'MTT 02 Q7', zone: 'MTT' }, { name: 'MTT 03 Q7 RL/LL', zone: 'MTT' },
    { name: 'MTT 04', zone: 'MTT' }, { name: 'MTT 02', zone: 'MTT' },
    // Rework
    { name: 'Q7 LL 03 rework', zone: 'Rework' }, { name: 'Q7 LL 02 rework', zone: 'Rework' },
    { name: 'Q9AH RL N01 rework', zone: 'Rework' }, { name: 'Q9 RL 01 rework', zone: 'Rework' },
    { name: 'Q7 RL 01 rework', zone: 'Rework' }, { name: 'Q9AH LL 01 rework', zone: 'Rework' },
    { name: 'Q9 LL 01 rework', zone: 'Rework' }, { name: 'Q7 LL 01 rework', zone: 'Rework' },
    // Backup
    { name: 'Q7 LL 04 P.M Rework', zone: 'Backup' }, { name: 'Q9 AH RL 03', zone: 'Backup' },
    { name: 'Q7 LL 02', zone: 'Backup' }, { name: 'Q9 RL 01', zone: 'Backup' }, { name: 'Q7 RL 04', zone: 'Backup' },
    { name: 'Q7 LL 17', zone: 'Backup' }, { name: 'Q7 LL 34', zone: 'Backup' }, { name: 'Q7 LL 56', zone: 'Backup' },
    { name: 'Q9 RL 02', zone: 'Backup' }, { name: 'Q9 AH RL 02', zone: 'Backup' }, { name: 'Q7 LL 15', zone: 'Backup' },
    { name: 'Q9 AH LL 17', zone: 'Backup' }, { name: 'Q9 - LL - P.M', zone: 'Backup' }
  ];

  const existingPanels = db.prepare('SELECT panel_name, current_zone FROM panels').all();
  if (existingPanels.length <= 5) {
    db.exec('DELETE FROM panels;');
    existingPanels.length = 0;
  }

  const checkPanel = (name, zone) => existingPanels.some(p => p.panel_name.toLowerCase() === name.toLowerCase() && p.current_zone.toLowerCase() === zone.toLowerCase());
  const insertPanel = db.prepare('INSERT INTO panels (panel_name, panel_number, current_zone) VALUES (?, ?, ?)');

  for (const p of allPanelsList) {
    if (!checkPanel(p.name, p.zone)) {
      const numMatch = p.name.match(/\b(\d{2})\b/);
      const num = numMatch ? numMatch[1] : '-';
      insertPanel.run(p.name, num, p.zone);
    }
  }

  db.exec('COMMIT;');
  console.log(`✅ [Type de pièce] 66 éléments synchronisés avec succès.`);
};
ensureDefaults();

const photoMap = new Map();
function indexPhotos() {
  photoMap.clear();
  if (!fs.existsSync(photosDir)) return;
  const validExts = new Set(['.jpg', '.jpeg', '.png', '.webp']);
  try {
    const files = fs.readdirSync(photosDir);
    for (const file of files) {
      const ext = path.extname(file).toLowerCase();
      if (validExts.has(ext)) {
        const base = path.basename(file, ext);
        const cleanBase = base.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
        if (cleanBase && !photoMap.has(cleanBase)) {
          photoMap.set(cleanBase, `/photos/${file}`);
        }
      }
    }
  } catch (e) {
    console.error('Erreur indexation photos:', e.message);
  }
}
indexPhotos();

function getPhoto(pointName, refCode) {
  const cleanRef = refCode ? String(refCode).replace(/[^a-zA-Z0-9]/g, '').toLowerCase() : '';
  const cleanPt = pointName ? String(pointName).replace(/[^a-zA-Z0-9]/g, '').toLowerCase() : '';
  return photoMap.get(cleanRef) || photoMap.get(cleanPt) || '';
}

function findExcelFile(names) {
  for (const n of names) {
    const p = path.join(__dirname, n);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const currentPointsCount = db.prepare('SELECT COUNT(*) as cnt FROM points_catalog').get().cnt;
if (currentPointsCount === 0) {
  const matchFile = findExcelFile(['match cod.xlsx', 'match_cod.xlsx', 'matchcod.xlsx']);
  const prixFile = findExcelFile(['prix .xlsx', 'prix.xlsx', 'prix .xls', 'prix.xls']);
  const catalogJsonPath = path.join(__dirname, 'catalog.json');

  const insertPt = db.prepare(`
    INSERT INTO points_catalog (point_name, reference_code, family, unit_price, image_data)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(point_name) DO UPDATE SET
      reference_code = excluded.reference_code,
      family = excluded.family,
      unit_price = excluded.unit_price,
      image_data = excluded.image_data
  `);

  if (XLSX && matchFile && prixFile) {
    try {
      const wbPrix = XLSX.readFile(prixFile);
      const dataPrix = XLSX.utils.sheet_to_json(wbPrix.Sheets[wbPrix.SheetNames[0]], { defval: '' });

      const wbMatch = XLSX.readFile(matchFile);
      const dataMatch = XLSX.utils.sheet_to_json(wbMatch.Sheets[wbMatch.SheetNames[0]], { defval: '' });

      const cleanKey = s => s ? String(s).replace(/[^a-zA-Z0-9]/g, '').toUpperCase() : '';
      const prixDict = {};

      for (const r of dataPrix) {
        const rawRef = String(r['reference Code'] || r['Reference Code'] || Object.values(r)[0] || '').trim();
        if (!rawRef) continue;
        const key = cleanKey(rawRef);
        const cat = String(r['Catégorie de pièce'] || r['Categorie'] || r['Famille'] || 'Non défini').trim();
        const rawPrice = r['price'] !== undefined ? r['price'] : r['Price'];
        const price = parseFloat(String(rawPrice).replace(',', '.')) || 0;

        if (!prixDict[key] || price > prixDict[key].price) {
          prixDict[key] = { rawRef, family: cat, price };
        }
      }

      const usedKeys = new Set();
      const seenPoints = new Set();
      const catalogBackup = [];

      db.exec('BEGIN TRANSACTION;');
      for (const r of dataMatch) {
        const pName = String(r['Kurzname'] || r['Point'] || Object.values(r)[0] || '').trim();
        const rCode = String(r['Teilenummer'] || r['Reference'] || Object.values(r)[1] || '').trim();
        if (!pName || !rCode) continue;

        const upperP = pName.toUpperCase();
        if (seenPoints.has(upperP)) continue;
        seenPoints.add(upperP);

        const normR = cleanKey(rCode);
        usedKeys.add(normR);

        const pData = prixDict[normR];
        const family = pData ? pData.family : 'Non défini';
        const price = pData ? pData.price : 0;
        const photo = getPhoto(pName, rCode);

        insertPt.run(pName, rCode, family, price, photo);
        catalogBackup.push({ point_name: pName, reference_code: rCode, family, unit_price: price });
      }

      for (const [norm, pData] of Object.entries(prixDict)) {
        const upperR = pData.rawRef.toUpperCase();
        if (!usedKeys.has(norm) && !seenPoints.has(upperR)) {
          const photo = getPhoto(pData.rawRef, pData.rawRef);
          insertPt.run(pData.rawRef, pData.rawRef, pData.family, pData.price, photo);
          catalogBackup.push({ point_name: pData.rawRef, reference_code: pData.rawRef, family: pData.family, unit_price: pData.price });
          seenPoints.add(upperR);
        }
      }
      db.exec('COMMIT;');

      fs.writeFileSync(catalogJsonPath, JSON.stringify(catalogBackup, null, 2), 'utf8');
    } catch (e) {
      console.error('Erreur import Excel:', e.message);
    }
  }
}

function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Non connecté' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = db.prepare('SELECT id, username, role, matricule, full_name, must_change_password FROM users WHERE id = ?').get(payload.id);
    if (!user) return res.status(401).json({ error: 'Compte introuvable' });
    req.user = user;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Session expirée' });
  }
}

function supervisorOnly(req, res, next) {
  if (req.user?.role !== 'admin' && req.user?.role !== 'supervisor') {
    return res.status(403).json({ error: 'Accès réservé au Superviseur / Admin' });
  }
  next();
}

function leaderOrSupervisor(req, res, next) {
  if (req.user?.role !== 'admin' && req.user?.role !== 'supervisor' && req.user?.role !== 'team_leader') {
    return res.status(403).json({ error: 'Accès réservé au Chef d\'équipe ou Superviseur' });
  }
  next();
}

app.post('/api/login', (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  if (!username || !password) return res.status(400).json({ error: 'Identifiants obligatoires' });

  const user = db.prepare('SELECT * FROM users WHERE (username = ? OR matricule = ?)').get(username, username);
  if (!user) return res.status(400).json({ error: 'Identifiants incorrects' });

  const isMatch = bcrypt.compareSync(password, user.password);
  if (!isMatch) return res.status(400).json({ error: 'Identifiants incorrects' });

  const token = jwt.sign(
    { id: user.id, username: user.username, role: user.role, full_name: user.full_name, matricule: user.matricule },
    JWT_SECRET,
    { expiresIn: '12h' }
  );

  res.json({
    token,
    must_change_password: !!user.must_change_password,
    user: { id: user.id, username: user.username, role: user.role, full_name: user.full_name, matricule: user.matricule }
  });
});

app.get('/api/me', auth, (req, res) => {
  const { id, username, role, matricule, full_name, must_change_password } = req.user;
  res.json({ id, username, role, matricule, full_name, must_change_password: !!must_change_password });
});

app.put('/api/user/profile', auth, (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '').trim();
  const userId = req.user.id;

  if (!username) return res.status(400).json({ error: 'Identifiant obligatoire' });

  const existing = db.prepare('SELECT id FROM users WHERE (username = ? OR matricule = ?) AND id != ?').get(username, username, userId);
  if (existing) return res.status(400).json({ error: 'Cet identifiant est déjà utilisé' });

  if (password !== '') {
    const hashedPassword = bcrypt.hashSync(password, 10);
    db.prepare('UPDATE users SET username = ?, password = ?, must_change_password = 0 WHERE id = ?').run(username, hashedPassword, userId);
  } else {
    db.prepare('UPDATE users SET username = ? WHERE id = ?').run(username, userId);
  }

  res.json({ success: true });
});

app.post('/api/users/:id/reset', auth, leaderOrSupervisor, (req, res) => {
  const targetUser = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!targetUser) return res.status(404).json({ error: 'Utilisateur introuvable' });

  const defaultHash = bcrypt.hashSync(targetUser.matricule, 10);
  db.prepare('UPDATE users SET username = ?, password = ?, must_change_password = 0 WHERE id = ?').run(targetUser.matricule, defaultHash, targetUser.id);

  res.json({ success: true, matricule: targetUser.matricule, temp_password: targetUser.matricule });
});

app.get('/api/users', auth, leaderOrSupervisor, (req, res) => {
  res.json(db.prepare('SELECT id, username, role, matricule, full_name FROM users ORDER BY full_name ASC').all());
});

app.post('/api/users', auth, supervisorOnly, (req, res) => {
  const b = req.body;
  if (!b.username || !b.password || !b.matricule || !b.role || !b.full_name) {
    return res.status(400).json({ error: 'Champs obligatoires manquants' });
  }

  const existing = db.prepare('SELECT id FROM users WHERE username = ? OR matricule = ?').get(b.username.trim(), b.matricule.trim());
  if (existing) return res.status(400).json({ error: 'Identifiant ou Matricule déjà utilisé' });

  const hashedPassword = bcrypt.hashSync(b.password.trim(), 10);
  db.prepare(`
    INSERT INTO users (username, password, role, matricule, full_name, must_change_password)
    VALUES (?, ?, ?, ?, ?, 0)
  `).run(b.username.trim(), hashedPassword, b.role, b.matricule.trim(), b.full_name.trim());

  res.json({ success: true });
});

app.put('/api/users/:id', auth, supervisorOnly, (req, res) => {
  const b = req.body;
  const id = req.params.id;

  if (!b.username || !b.matricule || !b.role || !b.full_name) {
    return res.status(400).json({ error: 'Champs obligatoires manquants' });
  }

  const existing = db.prepare('SELECT id FROM users WHERE (username = ? OR matricule = ?) AND id != ?').get(b.username.trim(), b.matricule.trim(), id);
  if (existing) return res.status(400).json({ error: 'Identifiant ou Matricule déjà utilisé' });

  if (b.password && b.password.trim() !== '') {
    const hashedPassword = bcrypt.hashSync(b.password.trim(), 10);
    db.prepare('UPDATE users SET username = ?, password = ?, role = ?, matricule = ?, full_name = ?, must_change_password = 0 WHERE id = ?')
      .run(b.username.trim(), hashedPassword, b.role, b.matricule.trim(), b.full_name.trim(), id);
  } else {
    db.prepare('UPDATE users SET username = ?, role = ?, matricule = ?, full_name = ? WHERE id = ?')
      .run(b.username.trim(), b.role, b.matricule.trim(), b.full_name.trim(), id);
  }

  res.json({ success: true });
});

app.delete('/api/users/:id', auth, supervisorOnly, (req, res) => {
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

app.get('/api/operation-mappings', (req, res) => {
  res.json(db.prepare('SELECT * FROM operation_mappings ORDER BY operation_type ASC').all());
});

app.post('/api/operation-mappings', auth, supervisorOnly, (req, res) => {
  const { operation_type, defect_types, pdr_sources } = req.body;
  if (!operation_type) return res.status(400).json({ error: 'Type d\'opération requis' });

  const defs = Array.isArray(defect_types) ? JSON.stringify(defect_types) : JSON.stringify([defect_types || 'Casse']);
  const srcs = Array.isArray(pdr_sources) ? JSON.stringify(pdr_sources) : JSON.stringify([pdr_sources || '0']);

  db.prepare(`
    INSERT INTO operation_mappings (operation_type, defect_types, pdr_sources)
    VALUES (?, ?, ?)
    ON CONFLICT(operation_type) DO UPDATE SET 
      defect_types = excluded.defect_types,
      pdr_sources = excluded.pdr_sources
  `).run(operation_type.trim(), defs, srcs);

  res.json({ success: true });
});

app.delete('/api/operation-mappings/:id', auth, supervisorOnly, (req, res) => {
  db.prepare('DELETE FROM operation_mappings WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

app.get('/api/points', (req, res) => {
  res.json(db.prepare('SELECT id, point_name, reference_code, family, unit_price, image_data FROM points_catalog ORDER BY point_name ASC').all());
});

app.post('/api/points', auth, supervisorOnly, (req, res) => {
  const { point_name, reference_code, family, unit_price, image_data } = req.body;
  if (!point_name || !reference_code || !family) return res.status(400).json({ error: 'Tous les champs sont requis' });

  const pName = point_name.trim();
  const rCode = reference_code.trim();
  const price = parseFloat(unit_price) || 0;
  let finalImg = image_data || getPhoto(pName, rCode);

  db.prepare(`
    INSERT INTO points_catalog (point_name, reference_code, family, unit_price, image_data)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(point_name) DO UPDATE SET
      reference_code = excluded.reference_code,
      family = excluded.family,
      unit_price = excluded.unit_price,
      image_data = CASE WHEN excluded.image_data != '' THEN excluded.image_data ELSE points_catalog.image_data END
  `).run(pName, rCode, family.trim(), price, finalImg);

  res.json({ success: true });
});

app.put('/api/points/:id', auth, supervisorOnly, (req, res) => {
  const { point_name, reference_code, family, unit_price, image_data } = req.body;
  const id = req.params.id;

  const existing = db.prepare('SELECT * FROM points_catalog WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Point introuvable' });

  const pName = point_name.trim();
  const rCode = reference_code.trim();
  const price = parseFloat(unit_price) || 0;
  let finalImg = (image_data !== undefined && image_data !== '') ? image_data : (existing.image_data || getPhoto(pName, rCode));

  db.prepare(`
    UPDATE points_catalog 
    SET point_name = ?, reference_code = ?, family = ?, unit_price = ?, image_data = ?
    WHERE id = ?
  `).run(pName, rCode, family.trim(), price, finalImg, id);

  res.json({ success: true });
});

app.delete('/api/points/:id', auth, supervisorOnly, (req, res) => {
  db.prepare('DELETE FROM points_catalog WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

app.post('/api/points/rescan-photos', auth, supervisorOnly, (req, res) => {
  indexPhotos();
  const allPoints = db.prepare('SELECT id, point_name, reference_code FROM points_catalog').all();
  const updateStmt = db.prepare('UPDATE points_catalog SET image_data = ? WHERE id = ?');

  let updated = 0;
  db.exec('BEGIN TRANSACTION;');
  allPoints.forEach(pt => {
    const found = getPhoto(pt.point_name, pt.reference_code);
    if (found) {
      updateStmt.run(found, pt.id);
      updated++;
    }
  });
  db.exec('COMMIT;');
  res.json({ success: true, updated, totalPhotos: photoMap.size });
});

app.get('/api/operations', (req, res) => {
  res.json(db.prepare('SELECT * FROM repairs ORDER BY id DESC').all());
});

app.post('/api/operations', auth, (req, res) => {
  const b = req.body;
  const pdrSource = (b.spare_part_name || '0').trim();
  
  let unitPrice = 0;
  const pt = db.prepare('SELECT unit_price FROM points_catalog WHERE point_name = ? OR reference_code = ?').get(b.point_name, b.reference_code);
  if (pt) unitPrice = pt.unit_price || 0;

  const isConsumed = pdrSource !== '0' && pdrSource !== '';
  const qty = isConsumed ? (parseInt(b.spare_parts_qty, 10) || 1) : 0;
  const totalCost = unitPrice * qty;
  const machineName = b.machine || b.panel_name || '';

  db.prepare(`
    INSERT INTO repairs (technician_id, technician_name, matricule, operation_date, shift, zone, panel_name, panel_number, point_name, reference_code, point_type, item_inspected, intervention_type, defect_type, spare_part_id, spare_part_name, spare_parts_qty, unit_price_eur, total_cost_eur, repair_duration, downtime_duration, stops_machine, observations)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    req.user.id, req.user.full_name, req.user.matricule, b.operation_date, b.shift || 'Shift 1', b.zone, machineName,
    b.panel_number || '-', b.point_name, b.reference_code, b.point_type, b.item_inspected, b.intervention_type, b.defect_type,
    null, pdrSource, qty, unitPrice, totalCost, parseInt(b.repair_duration, 10) || 0,
    parseInt(b.downtime_duration, 10) || 0, b.stops_machine ? 1 : 0, b.observations || ''
  );
  res.json({ success: true });
});

app.delete('/api/operations/:id', auth, (req, res) => {
  if (req.user.role === 'admin' || req.user.role === 'supervisor') {
    db.prepare('DELETE FROM repairs WHERE id = ?').run(req.params.id);
  } else {
    db.prepare('DELETE FROM repairs WHERE id = ? AND technician_id = ?').run(req.params.id, req.user.id);
  }
  res.json({ success: true });
});

app.get('/api/carts', (req, res) => {
  const carts = db.prepare('SELECT * FROM carts').all();
  const items = db.prepare('SELECT * FROM cart_items').all();
  res.json(carts.map(c => ({ ...c, items: items.filter(i => i.cart_id === c.id) })));
});

app.post('/api/cart-movements', auth, (req, res) => {
  const { cart_id, item_id, action_type, quantity } = req.body;
  const item = db.prepare('SELECT * FROM cart_items WHERE id = ?').get(item_id);
  if (!item) return res.status(404).json({ error: 'Article introuvable' });
  const qty = parseInt(quantity, 10) || 1;
  let newQty = item.quantity;
  if (action_type === 'take') {
    if (item.quantity < qty) return res.status(400).json({ error: 'Stock insuffisant' });
    newQty -= qty;
  } else {
    newQty += qty;
  }
  db.prepare('UPDATE cart_items SET quantity = ? WHERE id = ?').run(newQty, item_id);
  db.prepare('INSERT INTO cart_movements (cart_id, item_id, item_name, technician_name, action_type, quantity) VALUES (?, ?, ?, ?, ?, ?)')
    .run(item.cart_id, item_id, item.item_name, req.user.full_name, action_type, qty);
  res.json({ success: true, remaining: newQty });
});

app.get('/api/cart-movements', (req, res) => {
  res.json(db.prepare('SELECT * FROM cart_movements ORDER BY id DESC LIMIT 50').all());
});

app.get('/api/tasks', (req, res) => {
  res.json(db.prepare('SELECT * FROM daily_tasks ORDER BY id DESC').all());
});

app.post('/api/tasks', auth, (req, res) => {
  if (req.user.role === 'technician') return res.status(403).json({ error: 'Réservé aux chefs et superviseurs' });
  db.prepare('INSERT INTO daily_tasks (title, description, target_zone, shift_name, priority) VALUES (?, ?, ?, ?, ?)')
    .run(req.body.title, req.body.description, req.body.target_zone, req.body.shift_name, req.body.priority || 'Normale');
  res.json({ success: true });
});

app.patch('/api/tasks/:id/status', auth, leaderOrSupervisor, (req, res) => {
  const status = req.body?.status === 'completed' ? 'completed' : 'pending';
  db.prepare('UPDATE daily_tasks SET status = ? WHERE id = ?').run(status, req.params.id);
  res.json({ success: true });
});

app.get('/api/handovers', (req, res) => {
  res.json(db.prepare('SELECT * FROM shift_handovers ORDER BY id DESC LIMIT 30').all());
});

app.post('/api/handovers', auth, (req, res) => {
  db.prepare('INSERT INTO shift_handovers (shift_name, outgoing_tech, incoming_tech, summary) VALUES (?, ?, ?, ?)')
    .run(req.body.shift_name, req.body.outgoing_tech, req.user.full_name, req.body.summary);
  res.json({ success: true });
});

app.get('/api/panels', (req, res) => {
  res.json(db.prepare('SELECT * FROM panels ORDER BY current_zone, panel_name').all());
});

app.post('/api/panels', auth, supervisorOnly, (req, res) => {
  const { panel_name, panel_number, current_zone } = req.body;
  if (!panel_name || !current_zone) return res.status(400).json({ error: 'Nom et Zone obligatoires' });
  db.prepare('INSERT INTO panels (panel_name, panel_number, current_zone) VALUES (?, ?, ?)')
    .run(panel_name.trim(), (panel_number || '-').trim(), current_zone.trim());
  res.json({ success: true });
});

app.put('/api/panels/:id', auth, supervisorOnly, (req, res) => {
  const { panel_name, panel_number, current_zone } = req.body;
  if (!panel_name || !current_zone) return res.status(400).json({ error: 'Nom et Zone obligatoires' });
  db.prepare('UPDATE panels SET panel_name = ?, panel_number = ?, current_zone = ? WHERE id = ?')
    .run(panel_name.trim(), (panel_number || '-').trim(), current_zone.trim(), req.params.id);
  res.json({ success: true });
});

app.delete('/api/panels/:id', auth, supervisorOnly, (req, res) => {
  db.prepare('DELETE FROM panels WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

app.get('/api/panel-movements', (req, res) => {
  res.json(db.prepare('SELECT * FROM panel_movements ORDER BY id DESC').all());
});

app.post('/api/panel-movements', auth, (req, res) => {
  const { panel_id, to_zone, reason } = req.body;
  const panel = db.prepare('SELECT * FROM panels WHERE id = ?').get(panel_id);
  if (!panel) return res.status(404).json({ error: 'Panneau introuvable' });
  if (panel.current_zone === to_zone) return res.status(400).json({ error: 'Déjà dans cette zone' });

  db.prepare('UPDATE panels SET current_zone = ? WHERE id = ?').run(to_zone, panel_id);
  db.prepare('INSERT INTO panel_movements (panel_name, panel_number, from_zone, to_zone, operator_matricule, reason) VALUES (?, ?, ?, ?, ?, ?)')
    .run(panel.panel_name, panel.panel_number, panel.current_zone, to_zone, req.user.matricule, reason);
  res.json({ success: true });
});

app.get('/api/config', (req, res) => {
  res.json({
    options: db.prepare('SELECT * FROM options_config').all(),
    mappings: db.prepare('SELECT * FROM operation_mappings').all()
  });
});

app.post('/api/config/options', auth, supervisorOnly, (req, res) => {
  const { category, option_value } = req.body;
  if (!category || !option_value) return res.status(400).json({ error: 'Champs requis' });
  db.prepare('INSERT INTO options_config (category, option_value) VALUES (?, ?)').run(category, option_value.trim());
  res.json({ success: true });
});

app.delete('/api/config/options/:id', auth, supervisorOnly, (req, res) => {
  db.prepare('DELETE FROM options_config WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

app.get('/api/analytics', auth, leaderOrSupervisor, (req, res) => {
  const isDate = v => /^\d{4}-\d{2}-\d{2}$/.test(v || '');
  const from = isDate(req.query.from) ? req.query.from : '0000-01-01';
  const to = isDate(req.query.to) ? req.query.to : '9999-12-31';
  const ops = db.prepare('SELECT * FROM repairs WHERE substr(operation_date, 1, 10) BETWEEN ? AND ?').all(from, to);
  let totalRepairTime = 0, totalDowntime = 0, totalSparePartsQty = 0, totalSparePartsCost = 0;
  let casseQty = 0, casseCost = 0, damagedQty = 0, damagedCost = 0, machineStops = 0;

  const zoneMap = {}, interMap = {}, defectMap = {}, partsMap = {};

  ops.forEach(o => {
    totalRepairTime += o.repair_duration;
    totalDowntime += o.downtime_duration;
    totalSparePartsQty += o.spare_parts_qty;
    totalSparePartsCost += o.total_cost_eur;

    if (o.defect_type === 'Casse') {
      casseQty += o.spare_parts_qty;
      casseCost += o.total_cost_eur;
    }
    if (o.defect_type === 'Endommagé') {
      damagedQty += o.spare_parts_qty;
      damagedCost += o.total_cost_eur;
    }
    if (o.stops_machine === 1 || o.downtime_duration > 0) {
      machineStops++;
    }

    zoneMap[o.zone] = zoneMap[o.zone] || { time: 0, parts: 0 };
    zoneMap[o.zone].time += o.repair_duration;
    zoneMap[o.zone].parts += o.spare_parts_qty;

    interMap[o.intervention_type] = (interMap[o.intervention_type] || 0) + 1;
    defectMap[o.defect_type] = (defectMap[o.defect_type] || 0) + 1;
    if (o.spare_parts_qty > 0 && o.spare_part_name && o.spare_part_name !== '0') {
      partsMap[o.spare_part_name] = (partsMap[o.spare_part_name] || 0) + o.spare_parts_qty;
    }
  });

  const operatingHours = parseFloat(req.query.operating_hours) || 8.0;
  const days = new Set(ops.map(o => String(o.operation_date).slice(0, 10))).size || 1;
  const operatingMinutes = operatingHours * 60 * days;
  const mttr = machineStops > 0 ? (totalDowntime / machineStops).toFixed(2) : '0';
  const mtbf = machineStops > 0 ? (((operatingMinutes - totalDowntime) / 60) / machineStops).toFixed(2) : 'N/A';
  const availability = operatingMinutes > 0 ? (((operatingMinutes - totalDowntime) / operatingMinutes) * 100).toFixed(1) : '100';

  res.json({
    kpis: {
      totalInterventions: ops.length,
      totalSparePartsQty,
      totalSparePartsCost: totalSparePartsCost.toFixed(2),
      casseQty,
      casseCost: casseCost.toFixed(2),
      damagedQty,
      damagedCost: damagedCost.toFixed(2),
      totalRepairTime,
      totalDowntime,
      machineStops,
      mttr,
      mtbf,
      availability: String(Math.min(100, Math.max(0, parseFloat(availability))))
    },
    zones: zoneMap,
    interventions: interMap,
    defects: defectMap,
    topParts: partsMap
  });
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Route introuvable' }));

app.listen(port, host, () => {
  console.log(`🚀 Serveur actif sur http://${host}:${port}`);
});
