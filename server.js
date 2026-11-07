'use strict';
// Dompet Harian — personal finance dashboard. Node.js stdlib only (node:sqlite for storage).
process.env.TZ = process.env.TZ || 'Asia/Jakarta';

const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const DB = require('./lib/db');
const fin = require('./lib/finance');
const webpush = require('./lib/webpush');
const { hashPassword, verifyPassword, createUser } = require('./lib/users');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC = path.join(__dirname, 'public');
const SESSION_DAYS = 7;
// HTTPS (needed to install the app on a phone and for push): set TLS_CERT and TLS_KEY to PEM files.
const TLS = process.env.TLS_CERT && process.env.TLS_KEY
  ? { cert: fs.readFileSync(process.env.TLS_CERT), key: fs.readFileSync(process.env.TLS_KEY) } : null;
const COOKIE_SECURE = process.env.COOKIE_SECURE === '1' || !!TLS;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data', 'dompet.db');
const JSON_FILE = process.env.JSON_FILE || path.join(__dirname, 'data', 'db.json');

const db = DB.open(DB_FILE);

// ---------- bootstrap ----------
const imported = DB.importJson(db, JSON_FILE);
if (imported) console.log(`  Data lama dipindahkan dari db.json: ${imported.users} pengguna, ${imported.transactions} transaksi (file lama -> db.json.migrated).`);

let VAPID = DB.getMeta(db, 'vapid');
if (!VAPID) { VAPID = webpush.generateVapidKeys(); DB.setMeta(db, 'vapid', VAPID); }

if (!db.prepare("SELECT 1 FROM users WHERE role = 'admin'").get()) {
  const pw = process.env.ADMIN_PASSWORD || 'admin123';
  if (db.prepare("SELECT 1 FROM users WHERE username = 'admin'").get()) {
    db.prepare("UPDATE users SET role = 'admin', active = 1 WHERE username = 'admin'").run();
    console.log('\n  User "admin" dijadikan admin.\n');
  } else {
    DB.tx(db, () => createUser(db, { username: 'admin', name: 'Administrator', password: pw, role: 'admin' }));
    console.log('\n  Akun admin dibuat -> username: admin  password: ' + pw + '\n  Segera ganti password di menu Pengaturan.\n');
  }
}

// ---------- http helpers ----------
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = msg => new HttpError(400, msg);

function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': typeof body === 'object' && !Buffer.isBuffer(body) ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 1e6) { reject(new HttpError(413, 'Data terlalu besar')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(bad('Format JSON tidak valid')); }
    });
    req.on('error', reject);
  });
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('='); if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const nowIso = () => new Date().toISOString();

function sessionCookie(token, maxAge) {
  return `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}` + (COOKIE_SECURE ? '; Secure' : '');
}

const USER_COLS = 'u.id, u.username, u.name, u.role, u.active, u.salt, u.hash, u.created_at AS createdAt';
const getUser = id => db.prepare(`SELECT ${USER_COLS} FROM users u WHERE u.id = ?`).get(id);

function currentUser(req) {
  const token = parseCookies(req).sid;
  if (!token) return null;
  const s = db.prepare(`SELECT s.token_hash AS th, s.expires, ${USER_COLS} FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`).get(sha(token));
  if (!s || s.expires < Date.now() || !s.active) return null;
  if (s.expires - Date.now() < (SESSION_DAYS - 1) * 86400000)
    db.prepare('UPDATE sessions SET expires = ? WHERE token_hash = ?').run(Date.now() + SESSION_DAYS * 86400000, s.th);
  return s;
}

const publicUser = u => ({ id: u.id, username: u.username, name: u.name, role: u.role, active: !!u.active, createdAt: u.createdAt });

// ---------- validation ----------
const isDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s));
const isTime = s => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
const str = (v, max = 120) => String(v == null ? '' : v).trim().slice(0, max);
// Whole rupiah; the UI only accepts digits anyway.
function money(v, { allowZero = false, allowNeg = false } = {}) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || Math.abs(n) > 1e13) throw bad('Nominal tidak valid');
  if (!allowNeg && n < 0) throw bad('Nominal tidak boleh negatif');
  if (!allowZero && n <= 0) throw bad('Nominal harus lebih dari 0');
  return n;
}
function range(q) {
  const t = fin.today();
  const from = isDate(q.get('from')) ? q.get('from') : t.slice(0, 8) + '01';
  const to = isDate(q.get('to')) ? q.get('to') : t;
  if (from > to) throw bad('Tanggal awal harus sebelum tanggal akhir');
  return { from, to };
}

// Admin may read other users' data with ?uid=; writes always go to the signed-in user.
function scope(ctx, write = false) {
  const q = ctx.query.get('uid');
  if (!q || Number(q) === ctx.user.id) return ctx.user.id;
  if (ctx.user.role !== 'admin') throw new HttpError(403, 'Akses ditolak');
  if (write) throw new HttpError(403, 'Mode lihat: data pengguna lain hanya bisa dilihat');
  const u = getUser(Number(q));
  if (!u) throw new HttpError(404, 'Pengguna tidak ditemukan');
  return u.id;
}

// ---------- push ----------
async function pushToUser(uid, notif) {
  const subs = db.prepare('SELECT id, endpoint, p256dh, auth FROM push_subs WHERE user_id = ?').all(uid);
  const payload = { title: notif.title, body: notif.body, tag: notif.key || 'dompet', url: '/#/dashboard', level: notif.level };
  let ok = 0;
  await Promise.all(subs.map(async s => {
    const r = await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, VAPID, VAPID_SUBJECT);
    if (r.statusCode === 404 || r.statusCode === 410) db.prepare('DELETE FROM push_subs WHERE id = ?').run(s.id);
    else if (r.statusCode >= 200 && r.statusCode < 300) ok++;
    else if (r.error || r.statusCode) console.warn('[push]', r.statusCode, r.error || '');
  }));
  return { sent: ok, total: subs.length };
}

function runAlerts(uid) {
  const created = fin.checkAlerts(db, uid);
  for (const n of created) pushToUser(uid, n).catch(() => {});
  return created;
}

// ---------- routes ----------
class Reply { constructor(status, body, headers) { Object.assign(this, { status, body, headers }); } }
const reply = (status, body, headers = {}) => new Reply(status, body, headers);
const routes = [];
const route = (method, pattern, handler, opts = {}) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler, ...opts });
};

// auth
const loginFails = new Map();
route('POST', '/api/login', async ctx => {
  const ip = ctx.req.socket.remoteAddress;
  const f = loginFails.get(ip);
  if (f && f.count >= 10 && Date.now() - f.first < 15 * 60000) throw new HttpError(429, 'Terlalu banyak percobaan. Coba lagi 15 menit lagi.');
  const { username, password } = ctx.body;
  const u = db.prepare(`SELECT ${USER_COLS} FROM users u WHERE u.username = ?`).get(str(username, 60).toLowerCase());
  if (!u || !verifyPassword(password || '', u)) {
    const cur = f && Date.now() - f.first < 15 * 60000 ? f : { count: 0, first: Date.now() };
    cur.count++; loginFails.set(ip, cur);
    throw new HttpError(401, 'Username atau password salah');
  }
  if (!u.active) throw new HttpError(403, 'Akun dinonaktifkan. Hubungi admin.');
  loginFails.delete(ip);
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires) VALUES (?, ?, ?)').run(sha(token), u.id, Date.now() + SESSION_DAYS * 86400000);
  return reply(200, { user: publicUser(u) }, { 'Set-Cookie': sessionCookie(token, SESSION_DAYS * 86400) });
}, { auth: false });

route('POST', '/api/logout', async ctx => {
  const token = parseCookies(ctx.req).sid;
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(token));
  return reply(200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
}, { auth: false });

route('GET', '/api/me', async ctx => ({
  user: publicUser(ctx.user), settings: fin.getSettings(db, ctx.user.id), vapidPublicKey: VAPID.publicKey, today: fin.today()
}));

route('PUT', '/api/me/password', async ctx => {
  const { oldPassword, newPassword } = ctx.body;
  if (!verifyPassword(oldPassword || '', ctx.user)) throw bad('Password lama salah');
  if (!newPassword || String(newPassword).length < 6) throw bad('Password baru minimal 6 karakter');
  const { salt, hash } = hashPassword(newPassword);
  db.prepare('UPDATE users SET salt = ?, hash = ? WHERE id = ?').run(salt, hash, ctx.user.id);
  return { ok: true };
});

route('GET', '/api/settings', async ctx => fin.getSettings(db, scope(ctx)));
route('PUT', '/api/settings', async ctx => {
  const b = ctx.body;
  const values = {
    dailyLimit: money(b.dailyLimit || 0, { allowZero: true }),
    weeklyLimit: money(b.weeklyLimit || 0, { allowZero: true }),
    monthlyLimit: money(b.monthlyLimit || 0, { allowZero: true }),
    warnPercent: Math.min(100, Math.max(10, Number(b.warnPercent) || 80)),
    notify: b.notify !== false
  };
  fin.saveSettings(db, ctx.user.id, values);
  runAlerts(ctx.user.id);
  return values;
});

// ---------- master data: rekening, kategori, tabungan ----------
// fields: API name -> column name. clean() returns values keyed by API name.
function master({ table, label, base, fields, cols, clean, usedSql }) {
  const one = (id, uid) => db.prepare(`SELECT ${cols} FROM ${table} WHERE id = ? AND user_id = ?`).get(Number(id) || 0, uid);
  const out = r => r && ({ ...r, active: !!r.active });
  const own = (id, uid) => { const r = one(id, uid); if (!r) throw new HttpError(404, `${label} tidak ditemukan`); return r; };

  route('GET', base, async ctx => db.prepare(`SELECT ${cols} FROM ${table} WHERE user_id = ? ORDER BY id`).all(scope(ctx)).map(out));
  route('POST', base, async ctx => {
    const uid = scope(ctx, true);
    const v = clean(ctx.body, uid, null);
    const keys = Object.keys(v);
    const { id } = db.prepare(`INSERT INTO ${table} (user_id, active, ${keys.map(k => fields[k]).join(', ')}) VALUES (?, 1, ${keys.map(() => '?').join(', ')}) RETURNING id`)
      .get(uid, ...keys.map(k => v[k]));
    return out(one(id, uid));
  });
  route('PUT', base + '/:id', async ctx => {
    const uid = scope(ctx, true);
    const rec = own(ctx.params.id, uid);
    const v = clean(ctx.body, uid, rec);
    const sets = Object.keys(v).map(k => `${fields[k]} = ?`);
    const vals = Object.keys(v).map(k => v[k]);
    if (typeof ctx.body.active === 'boolean') { sets.push('active = ?'); vals.push(ctx.body.active ? 1 : 0); }
    db.prepare(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`).run(...vals, rec.id, uid);
    return out(one(rec.id, uid));
  });
  route('DELETE', base + '/:id', async ctx => {
    const uid = scope(ctx, true);
    const rec = own(ctx.params.id, uid);
    if (db.prepare(usedSql).get({ id: rec.id })) throw new HttpError(409, `${label} masih dipakai transaksi. Nonaktifkan saja agar riwayat tetap utuh.`);
    db.prepare(`DELETE FROM ${table} WHERE id = ? AND user_id = ?`).run(rec.id, uid);
    return { ok: true };
  });
  return own;
}

const ACC_TYPES = ['bank', 'cash', 'ewallet', 'lainnya'];
const ownAccount = master({
  table: 'accounts', label: 'Rekening', base: '/api/accounts',
  cols: 'id, user_id AS userId, name, type, initial_balance AS initialBalance, active',
  fields: { name: 'name', type: 'type', initialBalance: 'initial_balance' },
  usedSql: 'SELECT 1 FROM transactions WHERE account_id = :id OR to_account_id = :id LIMIT 1',
  clean(b, uid, rec) {
    const name = str(b.name, 60); if (!name) throw bad('Nama rekening wajib diisi');
    if (db.prepare('SELECT 1 FROM accounts WHERE user_id = ? AND name = ? COLLATE NOCASE AND id != ?').get(uid, name, rec ? rec.id : 0)) throw bad('Nama rekening sudah ada');
    return { name, type: ACC_TYPES.includes(b.type) ? b.type : 'bank', initialBalance: money(b.initialBalance || 0, { allowZero: true, allowNeg: true }) };
  }
});

const CAT_TYPES = ['pemasukan', 'pengeluaran', 'transfer'];
const ownCategory = master({
  table: 'categories', label: 'Kategori', base: '/api/categories',
  cols: 'id, user_id AS userId, type, name, limit_amount AS "limit", active',
  fields: { name: 'name', type: 'type', limit: 'limit_amount' },
  usedSql: 'SELECT 1 FROM transactions WHERE category_id = :id LIMIT 1',
  clean(b, uid, rec) {
    const name = str(b.name, 60); if (!name) throw bad('Nama kategori wajib diisi');
    const type = rec ? rec.type : b.type;
    if (!CAT_TYPES.includes(type)) throw bad('Jenis kategori tidak valid');
    if (db.prepare('SELECT 1 FROM categories WHERE user_id = ? AND type = ? AND name = ? COLLATE NOCASE AND id != ?').get(uid, type, name, rec ? rec.id : 0)) throw bad('Kategori sudah ada');
    return { name, type, limit: type === 'pengeluaran' ? money(b.limit || 0, { allowZero: true }) : 0 };
  }
});

const ownSaving = master({
  table: 'savings', label: 'Tabungan', base: '/api/savings',
  cols: 'id, user_id AS userId, name, place, initial_balance AS initialBalance, target, target_date AS targetDate, active',
  fields: { name: 'name', place: 'place', initialBalance: 'initial_balance', target: 'target', targetDate: 'target_date' },
  usedSql: 'SELECT 1 FROM transactions WHERE saving_id = :id LIMIT 1',
  clean(b) {
    const name = str(b.name, 60); if (!name) throw bad('Jenis tabungan wajib diisi');
    if (b.targetDate && !isDate(b.targetDate)) throw bad('Tanggal target tidak valid');
    return { name, place: str(b.place, 60), initialBalance: money(b.initialBalance || 0, { allowZero: true }),
      target: money(b.target || 0, { allowZero: true }), targetDate: b.targetDate || '' };
  }
});

// ---------- transactions ----------
const TX_TYPES = ['pemasukan', 'pengeluaran', 'transfer', 'tabungan'];
function cleanTx(b, uid) {
  if (!TX_TYPES.includes(b.type)) throw bad('Jenis transaksi tidak valid');
  if (!isDate(b.date)) throw bad('Tanggal tidak valid');
  const tx = { type: b.type, date: b.date, time: isTime(b.time) ? b.time : '00:00', amount: money(b.amount), detail: str(b.detail, 200),
    accountId: ownAccount(b.accountId, uid).id, toAccountId: null, categoryId: null, savingId: null, direction: null };
  if (b.type === 'pemasukan' || b.type === 'pengeluaran' || (b.type === 'transfer' && b.categoryId)) {
    const c = ownCategory(b.categoryId, uid);
    if (c.type !== b.type) throw bad('Kategori tidak sesuai jenis transaksi');
    tx.categoryId = c.id;
  }
  if (b.type === 'transfer') {
    tx.toAccountId = ownAccount(b.toAccountId, uid).id;
    if (tx.toAccountId === tx.accountId) throw bad('Rekening asal dan tujuan tidak boleh sama');
  }
  if (b.type === 'tabungan') {
    tx.savingId = ownSaving(b.savingId, uid).id;
    tx.direction = b.direction === 'tarik' ? 'tarik' : 'setor';
  }
  return tx;
}

const TX_SELECT = `SELECT t.id, t.user_id AS userId, t.type, t.date, t.time, t.amount, t.detail,
    t.account_id AS accountId, t.to_account_id AS toAccountId, t.category_id AS categoryId, t.saving_id AS savingId,
    t.direction, t.created_at AS createdAt,
    a.name AS accountName, ta.name AS toAccountName, c.name AS categoryName, s.name AS savingName
  FROM transactions t
  JOIN accounts a ON a.id = t.account_id
  LEFT JOIN accounts ta ON ta.id = t.to_account_id
  LEFT JOIN categories c ON c.id = t.category_id
  LEFT JOIN savings s ON s.id = t.saving_id`;
const getTx = id => db.prepare(`${TX_SELECT} WHERE t.id = ?`).get(id);

route('GET', '/api/transactions', async ctx => {
  const uid = scope(ctx); const { from, to } = range(ctx.query);
  const where = ['t.user_id = :uid', 't.date BETWEEN :from AND :to'];
  const p = { uid, from, to };
  const type = ctx.query.get('type');
  if (TX_TYPES.includes(type)) { where.push('t.type = :type'); p.type = type; }
  const acc = Number(ctx.query.get('accountId'));
  if (acc) { where.push('(t.account_id = :acc OR t.to_account_id = :acc)'); p.acc = acc; }
  const q = str(ctx.query.get('q'), 60);
  if (q) {
    where.push(`(t.detail LIKE :q ESCAPE '\\' OR c.name LIKE :q ESCAPE '\\' OR a.name LIKE :q ESCAPE '\\' OR ta.name LIKE :q ESCAPE '\\' OR s.name LIKE :q ESCAPE '\\')`);
    p.q = '%' + q.replace(/[\\%_]/g, m => '\\' + m) + '%';
  }
  return db.prepare(`${TX_SELECT} WHERE ${where.join(' AND ')} ORDER BY t.date DESC, t.time DESC, t.id DESC`).all(p);
});

const TX_COLS = ['type', 'date', 'time', 'amount', 'detail', 'account_id', 'to_account_id', 'category_id', 'saving_id', 'direction'];
const txValues = t => [t.type, t.date, t.time, t.amount, t.detail, t.accountId, t.toAccountId, t.categoryId, t.savingId, t.direction];

route('POST', '/api/transactions', async ctx => {
  const uid = scope(ctx, true);
  const t = cleanTx(ctx.body, uid);
  const { id } = db.prepare(`INSERT INTO transactions (user_id, ${TX_COLS.join(', ')}, created_at)
    VALUES (?, ${TX_COLS.map(() => '?').join(', ')}, ?) RETURNING id`).get(uid, ...txValues(t), nowIso());
  return { transaction: getTx(id), alerts: t.type === 'pengeluaran' ? runAlerts(uid) : [] };
});
route('PUT', '/api/transactions/:id', async ctx => {
  const uid = scope(ctx, true);
  const id = Number(ctx.params.id);
  if (!db.prepare('SELECT 1 FROM transactions WHERE id = ? AND user_id = ?').get(id, uid)) throw new HttpError(404, 'Transaksi tidak ditemukan');
  const t = cleanTx(ctx.body, uid);
  db.prepare(`UPDATE transactions SET ${TX_COLS.map(c => c + ' = ?').join(', ')} WHERE id = ? AND user_id = ?`).run(...txValues(t), id, uid);
  return { transaction: getTx(id), alerts: t.type === 'pengeluaran' ? runAlerts(uid) : [] };
});
route('DELETE', '/api/transactions/:id', async ctx => {
  const uid = scope(ctx, true);
  const r = db.prepare('DELETE FROM transactions WHERE id = ? AND user_id = ?').run(Number(ctx.params.id) || 0, uid);
  if (!r.changes) throw new HttpError(404, 'Transaksi tidak ditemukan');
  return { ok: true };
});

// ---------- reports & insight ----------
route('GET', '/api/reports/accounts', async ctx => { const { from, to } = range(ctx.query); return fin.accountReport(db, scope(ctx), from, to); });
route('GET', '/api/reports/savings', async ctx => { const { from, to } = range(ctx.query); return fin.savingsReport(db, scope(ctx), from, to); });
route('GET', '/api/insight', async ctx => {
  const { from, to } = range(ctx.query);
  const f = ['transaksi', 'rekening', 'tabungan'].includes(ctx.query.get('feature')) ? ctx.query.get('feature') : 'transaksi';
  return fin.insight(db, scope(ctx), f, from, to);
});

// ---------- notifications & push ----------
route('GET', '/api/notifications', async ctx => {
  const items = db.prepare(`SELECT id, key, level, title, body, read, created_at AS createdAt FROM notifications
    WHERE user_id = ? ORDER BY id DESC LIMIT 50`).all(ctx.user.id).map(n => ({ ...n, read: !!n.read }));
  const { unread } = db.prepare('SELECT COUNT(*) AS unread FROM notifications WHERE user_id = ? AND read = 0').get(ctx.user.id);
  return { items, unread };
});
route('POST', '/api/notifications/read-all', async ctx => {
  db.prepare('UPDATE notifications SET read = 1 WHERE user_id = ? AND read = 0').run(ctx.user.id);
  return { ok: true };
});
route('POST', '/api/push/subscribe', async ctx => {
  const s = ctx.body.subscription;
  if (!s || typeof s.endpoint !== 'string' || !/^https:\/\//.test(s.endpoint) || !s.keys || !s.keys.p256dh || !s.keys.auth) throw bad('Langganan notifikasi tidak valid');
  db.prepare(`INSERT INTO push_subs (user_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`)
    .run(ctx.user.id, s.endpoint, s.keys.p256dh, s.keys.auth, nowIso());
  return { ok: true };
});
route('POST', '/api/push/unsubscribe', async ctx => {
  db.prepare('DELETE FROM push_subs WHERE user_id = ? AND endpoint = ?').run(ctx.user.id, str(ctx.body.endpoint, 2000));
  return { ok: true };
});
route('POST', '/api/push/test', async ctx => pushToUser(ctx.user.id, {
  title: 'Notifikasi aktif', body: 'Peringatan batas pengeluaran akan muncul seperti ini.', key: 'test', level: 'info'
}));

// ---------- admin ----------
function adminOnly(ctx) { if (ctx.user.role !== 'admin') throw new HttpError(403, 'Khusus admin'); }

route('GET', '/api/admin/users', async ctx => {
  adminOnly(ctx);
  const t = fin.today();
  return db.prepare(`SELECT u.id, u.username, u.name, u.role, u.active, u.created_at AS createdAt,
      COUNT(x.id) AS txCount,
      COALESCE(SUM(CASE WHEN x.type = 'pemasukan' AND x.date BETWEEN :mFrom AND :t THEN x.amount END), 0) AS monthIncome,
      COALESCE(SUM(CASE WHEN x.type = 'pengeluaran' AND x.date BETWEEN :mFrom AND :t THEN x.amount END), 0) AS monthExpense,
      COALESCE(MAX(x.created_at), '') AS lastActivity
    FROM users u LEFT JOIN transactions x ON x.user_id = u.id
    GROUP BY u.id ORDER BY u.id`).all({ mFrom: t.slice(0, 8) + '01', t }).map(u => ({ ...u, active: !!u.active }));
});
route('POST', '/api/admin/users', async ctx => {
  adminOnly(ctx);
  const b = ctx.body;
  const username = str(b.username, 40).toLowerCase();
  if (!/^[a-z0-9._-]{3,40}$/.test(username)) throw bad('Username 3–40 karakter: huruf kecil, angka, titik, strip');
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw bad('Username sudah dipakai');
  if (!b.password || String(b.password).length < 6) throw bad('Password minimal 6 karakter');
  const id = DB.tx(db, () => createUser(db, { username, name: str(b.name, 80) || username, password: b.password, role: b.role }));
  return publicUser(getUser(id));
});
route('PUT', '/api/admin/users/:id', async ctx => {
  adminOnly(ctx);
  const u = getUser(Number(ctx.params.id)); if (!u) throw new HttpError(404, 'Pengguna tidak ditemukan');
  const b = ctx.body;
  if (u.id === ctx.user.id && (b.active === false || b.role === 'user')) throw bad('Tidak bisa menonaktifkan atau menurunkan peran akun sendiri');
  if (b.password && String(b.password).length < 6) throw bad('Password minimal 6 karakter');
  DB.tx(db, () => {
    if (b.name !== undefined) db.prepare('UPDATE users SET name = ? WHERE id = ?').run(str(b.name, 80) || u.username, u.id);
    if (b.role === 'admin' || b.role === 'user') db.prepare('UPDATE users SET role = ? WHERE id = ?').run(b.role, u.id);
    if (typeof b.active === 'boolean') {
      db.prepare('UPDATE users SET active = ? WHERE id = ?').run(b.active ? 1 : 0, u.id);
      if (!b.active) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
    }
    if (b.password) {
      const { salt, hash } = hashPassword(b.password);
      db.prepare('UPDATE users SET salt = ?, hash = ? WHERE id = ?').run(salt, hash, u.id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
    }
  });
  return publicUser(getUser(u.id));
});
route('DELETE', '/api/admin/users/:id', async ctx => {
  adminOnly(ctx);
  const id = Number(ctx.params.id);
  if (id === ctx.user.id) throw bad('Tidak bisa menghapus akun sendiri');
  // ON DELETE CASCADE removes the user's sessions, accounts, categories, savings, transactions, notifications, push and settings.
  if (!db.prepare('DELETE FROM users WHERE id = ?').run(id || 0).changes) throw new HttpError(404, 'Pengguna tidak ditemukan');
  return { ok: true };
});

// Consistent snapshot of the whole database (safe while the app is running).
route('GET', '/api/admin/backup', async ctx => {
  adminOnly(ctx);
  const tmp = path.join(os.tmpdir(), `dompet-backup-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.db`);
  db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
  const data = fs.readFileSync(tmp); fs.unlinkSync(tmp);
  return reply(200, data, { 'Content-Type': 'application/vnd.sqlite3', 'Content-Disposition': `attachment; filename="dompet-${fin.today()}.db"` });
});

// ---------- static files ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon' };

function serveStatic(req, res, pathname) {
  const p = pathname === '/' ? '/index.html' : decodeURIComponent(pathname);
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, 'Forbidden');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not found');
    const headers = { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' };
    if (p === '/sw.js') headers['Service-Worker-Allowed'] = '/';
    res.writeHead(200, headers); res.end(data);
  });
}

// ---------- server ----------
const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'"
};

const handler = async (req, res) => {
  for (const [k, v] of Object.entries(SEC_HEADERS)) res.setHeader(k, v);
  const url = new URL(req.url, 'http://x');
  if (!url.pathname.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    return serveStatic(req, res, url.pathname);
  }
  try {
    let match = null;
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = url.pathname.match(r.re);
      if (m) { match = { r, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) }; break; }
    }
    if (!match) throw new HttpError(404, 'Endpoint tidak ditemukan');
    const hasBody = Number(req.headers['content-length'] || 0) > 0 || !!req.headers['transfer-encoding'];
    if (['POST', 'PUT'].includes(req.method) && hasBody && !/application\/json/.test(req.headers['content-type'] || ''))
      throw new HttpError(415, 'Gunakan Content-Type application/json');
    const ctx = { req, res, query: url.searchParams, params: match.params, body: ['POST', 'PUT'].includes(req.method) ? await readBody(req) : {} };
    if (match.r.auth !== false) {
      ctx.user = currentUser(req);
      if (!ctx.user) throw new HttpError(401, 'Silakan masuk terlebih dahulu');
    }
    const out = await match.r.handler(ctx);
    if (out instanceof Reply) send(res, out.status, out.body, out.headers); else send(res, 200, out);
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e);
    send(res, e.status || 500, { error: e instanceof HttpError ? e.message : 'Terjadi kesalahan di server' });
  }
};
const server = TLS ? https.createServer(TLS, handler) : http.createServer(handler);

server.listen(PORT, HOST, () => {
  console.log(`Dompet Harian berjalan di ${TLS ? 'https' : 'http'}://localhost:${PORT}  (database: ${DB_FILE})`);
  if (!TLS) console.log('  Catatan: untuk dipasang sebagai aplikasi di HP, buka lewat HTTPS (lihat README).');
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { try { db.close(); } catch {} process.exit(0); });
