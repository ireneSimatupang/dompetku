'use strict';
// Seed data from the "Catatan_Keuangan-Iren" spreadsheet (sheet: Transaksi) into SQLite.
//
// Usage (safe to run while the server is running):
//   node seed-iren.js                          -> rows below, into user "iren" (password iren123)
//   node seed-iren.js --user admin             -> same rows, into an existing user
//   node seed-iren.js --csv Transaksi.csv      -> import a CSV export of the Transaksi sheet instead
//   node seed-iren.js --password rahasia       -> password for a newly created user
//
// Running it again replaces the rows it imported before (source = 'seed-iren'), so there are no duplicates.
// Accounts and categories are reused by name. Everything happens in one transaction: all or nothing.
process.env.TZ = process.env.TZ || 'Asia/Jakarta';
const fs = require('fs');
const path = require('path');
const DB = require('./lib/db');
const { createUser } = require('./lib/users');

const SOURCE = 'seed-iren';

// Tanggal (M/D/YYYY as in the sheet), Jenis, Kategori, Keterangan, Jumlah, Rekening, Ke Rekening
const ROWS = [
  ['10/10/2026', 'Pemasukan',   'Bonus',             'suplesi oktober', 1000000, 'BNI',     ''],
  ['10/10/2026', 'Pengeluaran', 'Makan & Minum',     'le mineral',      6000,    'JAGO',    ''],
  ['10/11/2026', 'Pengeluaran', 'Makan & Minum',     'cimol',           5000,    'JAGO',    ''],
  ['10/11/2026', 'Pengeluaran', 'Laundry',           '3,5kg',           31500,   'JAGO',    ''],
  ['10/12/2026', 'Pengeluaran', 'Pulsa & Internet',  'punya iren',      50000,   'JAGO',    ''],
  ['10/12/2026', 'Pengeluaran', 'Makan & Minum',     'gorenggan',       10000,   'JAGO',    ''],
  ['10/12/2026', 'Pengeluaran', 'Makan & Minum',     'nasgor',          16000,   'JAGO',    ''],
  ['10/12/2026', 'Pengeluaran', 'Makan & Minum',     'siomay',          5000,    'JAGO',    ''],
  ['10/13/2026', 'Transfer',    'Makan & Minum',     'transfer',        10000,   'JAGO',    'Seabank'],
  ['10/13/2026', 'Pengeluaran', 'Makan & Minum',     'geprek',          18000,   'JAGO',    ''],
  ['10/13/2026', 'Transfer',    'Tabungan Pribadi',  'jago',            900000,  'BNI',     'JAGO'],
  ['10/12/2026', 'Pengeluaran', 'Belanja Pribadi',   'skinker',         52430,   'Seabank', ''],
  ['10/13/2026', 'Pengeluaran', 'Makan & Minum',     'batagor',         5000,    'Seabank', ''],
  ['10/11/2026', 'Pengeluaran', 'Transportasi',      'greja-kos',       35900,   'BNI',     ''],
  ['10/13/2026', 'Pengeluaran', 'Biaya Admin Bank',  'bni tf',          2500,    'BNI',     '']
];

// ---------- args ----------
const args = process.argv.slice(2);
const arg = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 && args[i + 1] ? args[i + 1] : def; };
const username = arg('user', 'iren').toLowerCase();
const password = arg('password', 'iren123');
const csvFile = arg('csv', null);

// ---------- CSV (export of the Transaksi sheet) ----------
function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
    else if (c === '"') q = true;
    else if (c === ',' || c === ';') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
function rowsFromCsv(file) {
  const all = parseCsv(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  const head = all.findIndex(r => (r[0] || '').trim().toLowerCase() === 'tanggal'); // skip title rows 1–3
  if (head < 0) throw new Error('Kolom "Tanggal" tidak ditemukan di CSV');
  return all.slice(head + 1)
    .filter(r => (r[0] || '').trim() && (r[1] || '').trim())
    .map(r => [r[0], r[1], r[2], r[3], r[4], r[5], r[6] || ''].map(v => (typeof v === 'string' ? v.trim() : v)));
}

// ---------- normalisers ----------
function toDate(s) {
  s = String(s).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);                 // 2026-10-10
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);                    // 10/13/2026 = month/day/year (sheet locale)
  if (!m) throw new Error('Tanggal tidak dikenali: ' + s);
  let month = +m[1], day = +m[2];
  if (month > 12) [month, day] = [day, month];                        // tolerate D/M/YYYY
  return `${m[3]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
const toAmount = v => (typeof v === 'number' ? Math.round(v) : Number(String(v).replace(/[^\d]/g, '')) || 0); // "Rp 1,000,000"
const toType = s => {
  const t = String(s).trim().toLowerCase();
  if (t.startsWith('pemasukan')) return 'pemasukan';
  if (t.startsWith('pengeluaran')) return 'pengeluaran';
  if (t.startsWith('transfer')) return 'transfer';
  throw new Error('Jenis tidak dikenali: ' + s);
};

// ---------- import ----------
const db = DB.open(process.env.DB_FILE || path.join(__dirname, 'data', 'dompet.db'));
const source = csvFile ? rowsFromCsv(csvFile) : ROWS;
const warnings = [];

let result;
try {
result = DB.tx(db, () => {
  let user = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (!user && username === 'admin') throw new Error('User "admin" belum ada. Jalankan server sekali dulu agar akun admin dibuat, lalu ulangi.');
  let created = false;
  if (!user) { user = { id: createUser(db, { username, name: username === 'iren' ? 'Iren' : username, password }) }; created = true; }
  const uid = user.id;

  const findAcc = db.prepare('SELECT id FROM accounts WHERE user_id = ? AND name = ? COLLATE NOCASE');
  const addAcc = db.prepare('INSERT INTO accounts (user_id, name, type, initial_balance, active) VALUES (?, ?, ?, 0, 1) RETURNING id');
  const findCat = db.prepare('SELECT id, type FROM categories WHERE user_id = ? AND name = ? COLLATE NOCASE');
  const findCatType = db.prepare('SELECT id FROM categories WHERE user_id = ? AND type = ? AND name = ? COLLATE NOCASE');
  const addCat = db.prepare('INSERT INTO categories (user_id, type, name, limit_amount, active) VALUES (?, ?, ?, 0, 1) RETURNING id');
  const addTx = db.prepare(`INSERT INTO transactions (user_id, type, date, time, amount, detail, account_id, to_account_id, category_id, source, created_at)
    VALUES (?, ?, ?, '12:00', ?, ?, ?, ?, ?, ?, ?)`);

  const account = name => {
    const n = String(name || '').trim(); if (!n) return null;
    return (findAcc.get(uid, n) || addAcc.get(uid, n, /cash|tunai/i.test(n) ? 'cash' : 'bank')).id;
  };
  const category = (type, name) => {
    const n = String(name || '').trim(); if (!n) return null;
    return (findCatType.get(uid, type, n) || addCat.get(uid, type, n)).id;
  };

  const removed = db.prepare('DELETE FROM transactions WHERE user_id = ? AND source = ?').run(uid, SOURCE).changes;
  let n = 0;
  source.forEach((r, i) => {
    const [tanggal, jenis, kategori, ket, jumlah, rek, keRek] = r;
    const line = `baris ${i + 5}`;                                    // sheet data starts on row 5
    const type = toType(jenis);
    const amount = toAmount(jumlah);
    if (!amount) return warnings.push(`${line}: jumlah kosong, dilewati`);
    const accId = account(rek);
    if (!accId) return warnings.push(`${line}: rekening kosong, dilewati`);
    let toId = null, catId = null;
    if (type === 'transfer') {
      toId = account(keRek);
      if (!toId) return warnings.push(`${line}: transfer tanpa "Ke Rekening", dilewati`);
      if (toId === accId) return warnings.push(`${line}: rekening asal = tujuan, dilewati`);
      // The sheet sometimes puts an expense category on a transfer (e.g. "Makan & Minum"): leave those uncategorised.
      const existing = kategori && findCat.get(uid, String(kategori).trim());
      if (existing && existing.type !== 'transfer') warnings.push(`${line}: kategori "${kategori}" pada Transfer diabaikan`);
      else catId = category('transfer', kategori);
    } else {
      catId = category(type, kategori || 'Lainnya');
    }
    addTx.run(uid, type, toDate(tanggal), amount, String(ket || '').slice(0, 200), accId, toId, catId, SOURCE, new Date().toISOString());
    n++;
  });
  return { n, removed, created };
});
} catch (e) { console.error('Gagal: ' + e.message); db.close(); process.exit(1); }

if (result.created) console.log(`Pengguna baru: ${username} / ${password}`);
console.log(`Selesai: ${result.n} transaksi diimpor ke "${username}"` + (result.removed ? ` (${result.removed} impor lama diganti)` : '') + '.');
for (const w of warnings) console.log('  ! ' + w);
db.close();
