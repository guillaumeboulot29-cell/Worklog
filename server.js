// ─────────────────────────────────────────────────────────────────────────────
//  WorkLog — server.js
//  Node.js + Express + sql.js  (SQLite pur JS, fichier worklog.db persisté)
//  Lance : node server.js
// ─────────────────────────────────────────────────────────────────────────────

const express  = require('express');
const path     = require('path');
const fs       = require('fs');
const initSqlJs = require('sql.js');

const PORT    = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'worklog.db');

// ── Init DB ───────────────────────────────────────────────────────────────────
let db;

async function initDb() {
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_FILE)) {
    db = new SQL.Database(fs.readFileSync(DB_FILE));
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS entries (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at    TEXT,
      canal         TEXT,
      type_demande  TEXT,
      prenom        TEXT,
      service       TEXT,
      objet         TEXT,
      categorie     TEXT,
      priorite      TEXT DEFAULT 'normal',
      statut        TEXT DEFAULT 'todo',
      commentaire   TEXT
    );
    CREATE TABLE IF NOT EXISTS kanban_columns (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      slug     TEXT NOT NULL UNIQUE,
      label    TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      is_fixed INTEGER NOT NULL DEFAULT 0
    );
  `);

  // Colonnes par défaut
  const n = db.exec('SELECT COUNT(*) as n FROM kanban_columns')[0]?.values[0][0];
  if (!n) {
    db.run("INSERT INTO kanban_columns (slug,label,position,is_fixed) VALUES ('todo','À faire',0,1)");
    db.run("INSERT INTO kanban_columns (slug,label,position,is_fixed) VALUES ('inprogress','En cours',1,1)");
    db.run("INSERT INTO kanban_columns (slug,label,position,is_fixed) VALUES ('waiting','En attente',2,0)");
    db.run("INSERT INTO kanban_columns (slug,label,position,is_fixed) VALUES ('done','Terminé',3,1)");
    save();
  }
}

// Persistance : écrire sur disque après chaque mutation
function save() {
  const data = db.export();
  fs.writeFileSync(DB_FILE, Buffer.from(data));
}

// ── Helpers sql.js ────────────────────────────────────────────────────────────
function all(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function get(sql, params = []) {
  return all(sql, params)[0] || null;
}

function run(sql, params = []) {
  db.run(sql, params);
  save();
  // Retourner le dernier rowid inséré
  const r = db.exec('SELECT last_insert_rowid() as id');
  return { lastInsertRowid: r[0]?.values[0][0] };
}

function slugify(str) {
  return str.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .substring(0, 40) || 'col_' + Date.now();
}

// ── App ───────────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static(__dirname));

// ═══════════════════════════════════════════════════════════════════════════════
//  ENTRIES
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/api/entries', (req, res) => {
  let sql = 'SELECT * FROM entries WHERE 1=1';
  const p = [];
  if (req.query.search) {
    sql += ' AND (objet LIKE ? OR prenom LIKE ? OR service LIKE ? OR commentaire LIKE ?)';
    const like = `%${req.query.search}%`;
    p.push(like, like, like, like);
  }
  if (req.query.canal)        { sql += ' AND canal = ?';        p.push(req.query.canal); }
  if (req.query.type_demande) { sql += ' AND type_demande = ?'; p.push(req.query.type_demande); }
  if (req.query.priorite)     { sql += ' AND priorite = ?';     p.push(req.query.priorite); }
  if (req.query.statut)       { sql += ' AND statut = ?';       p.push(req.query.statut); }
  if (req.query.prenom)       { sql += ' AND prenom LIKE ?';    p.push(`%${req.query.prenom}%`); }
  if (req.query.service)      { sql += ' AND service LIKE ?';   p.push(`%${req.query.service}%`); }
  if (req.query.date_from)    { sql += ' AND DATE(created_at) >= ?'; p.push(req.query.date_from); }
  if (req.query.date_to)      { sql += ' AND DATE(created_at) <= ?'; p.push(req.query.date_to); }
  sql += ' ORDER BY created_at DESC';
  res.json(all(sql, p));
});

app.get('/api/entries/:id', (req, res) => {
  const row = get('SELECT * FROM entries WHERE id = ?', [req.params.id]);
  row ? res.json(row) : res.status(404).json({ error: 'Not found' });
});

app.post('/api/entries', (req, res) => {
  const { created_at, canal, type_demande, prenom, service, objet, categorie, priorite, statut, commentaire } = req.body;
  const r = run(
    'INSERT INTO entries (created_at,canal,type_demande,prenom,service,objet,categorie,priorite,statut,commentaire) VALUES (?,?,?,?,?,?,?,?,?,?)',
    [created_at || new Date().toISOString().slice(0,19).replace('T',' '),
     canal, type_demande, prenom, service, objet, categorie,
     priorite||'normal', statut||'todo', commentaire]
  );
  res.json({ id: r.lastInsertRowid });
});

app.put('/api/entries/:id', (req, res) => {
  const { created_at, canal, type_demande, prenom, service, objet, categorie, priorite, statut, commentaire } = req.body;
  run('UPDATE entries SET created_at=?,canal=?,type_demande=?,prenom=?,service=?,objet=?,categorie=?,priorite=?,statut=?,commentaire=? WHERE id=?',
      [created_at, canal, type_demande, prenom, service, objet, categorie, priorite, statut, commentaire, req.params.id]);
  res.json({ ok: true });
});

app.patch('/api/entries/:id/statut', (req, res) => {
  const { statut } = req.body;
  if (!statut) return res.status(400).json({ error: 'statut requis' });
  run('UPDATE entries SET statut=? WHERE id=?', [statut, req.params.id]);
  res.json({ ok: true });
});

app.delete('/api/entries/:id', (req, res) => {
  run('DELETE FROM entries WHERE id=?', [req.params.id]);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  STATS
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/api/stats', (req, res) => {
  const rows = all('SELECT statut, priorite, COUNT(*) as n FROM entries GROUP BY statut, priorite');
  const s = { total: 0, urgent: 0, todo: 0, inprogress: 0, done: 0 };
  rows.forEach(r => {
    s.total += r.n;
    if (r.priorite === 'urgent')    s.urgent     += r.n;
    if (r.statut === 'todo')        s.todo       += r.n;
    if (r.statut === 'inprogress')  s.inprogress += r.n;
    if (r.statut === 'done')        s.done       += r.n;
  });
  res.json(s);
});

// ═══════════════════════════════════════════════════════════════════════════════
//  AUTOCOMPLETE
// ═══════════════════════════════════════════════════════════════════════════════

const AC_FIELDS = ['canal','type_demande','prenom','service','objet','categorie'];

app.get('/api/ac/:field', (req, res) => {
  const f = req.params.field;
  if (!AC_FIELDS.includes(f)) return res.status(400).json([]);
  const rows = all(`SELECT DISTINCT ${f} as v FROM entries WHERE ${f} IS NOT NULL AND ${f} != '' ORDER BY ${f}`);
  res.json(rows.map(r => r.v));
});

// ═══════════════════════════════════════════════════════════════════════════════
//  KANBAN COLUMNS
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/api/kanban/columns', (req, res) => {
  res.json(all('SELECT * FROM kanban_columns ORDER BY position ASC'));
});

app.post('/api/kanban/columns', (req, res) => {
  const { label } = req.body;
  if (!label?.trim()) return res.status(400).json({ error: 'label requis' });
  const slug = slugify(label.trim()) + '_' + Date.now();
  const maxPos = (get('SELECT MAX(position) as m FROM kanban_columns')?.m || 0);
  const r = run('INSERT INTO kanban_columns (slug,label,position,is_fixed) VALUES (?,?,?,0)',
                [slug, label.trim(), maxPos + 1]);
  res.json({ id: r.lastInsertRowid, slug, label: label.trim(), position: maxPos + 1, is_fixed: 0 });
});

app.put('/api/kanban/columns/:id', (req, res) => {
  const { label } = req.body;
  if (!label?.trim()) return res.status(400).json({ error: 'label requis' });
  const col = get('SELECT * FROM kanban_columns WHERE id=?', [req.params.id]);
  if (!col) return res.status(404).json({ error: 'Not found' });
  const newSlug = col.is_fixed ? col.slug : slugify(label.trim()) + '_' + col.id;
  run('UPDATE kanban_columns SET label=?,slug=? WHERE id=?', [label.trim(), newSlug, req.params.id]);
  if (!col.is_fixed) run('UPDATE entries SET statut=? WHERE statut=?', [newSlug, col.slug]);
  res.json({ ok: true, slug: newSlug });
});

app.delete('/api/kanban/columns/:id', (req, res) => {
  const col = get('SELECT * FROM kanban_columns WHERE id=?', [req.params.id]);
  if (!col) return res.status(404).json({ error: 'Not found' });
  if (col.is_fixed) return res.status(403).json({ error: 'Colonne système' });
  run("UPDATE entries SET statut='todo' WHERE statut=?", [col.slug]);
  run('DELETE FROM kanban_columns WHERE id=?', [req.params.id]);
  res.json({ ok: true });
});

app.patch('/api/kanban/columns/reorder', (req, res) => {
  const items = req.body;
  if (!Array.isArray(items)) return res.status(400).json({ error: 'Array attendu' });
  items.forEach(({ id, position }) => db.run('UPDATE kanban_columns SET position=? WHERE id=?', [position, id]));
  save();
  res.json({ ok: true });
});

// ── Start ─────────────────────────────────────────────────────────────────────
initDb().then(() => {
  app.listen(PORT, () => console.log(`\n  ✦ WorkLog → http://localhost:${PORT}\n`));
});
