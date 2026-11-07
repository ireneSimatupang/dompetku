'use strict';
// Money math as SQL aggregations: balances, period reports, insights and threshold alerts.
// Everything filters on (user_id, date), which is indexed, so cost grows with the period asked, not with total history.

const pad = n => String(n).padStart(2, '0');
const dateStr = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseDate = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = parseDate(s); d.setDate(d.getDate() + n); return dateStr(d); };
const daysBetween = (a, b) => Math.round((parseDate(b) - parseDate(a)) / 86400000);
const today = () => dateStr(new Date());
const weekStart = s => { const d = parseDate(s); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return dateStr(d); };
const monthEnd = s => { const d = parseDate(s); return dateStr(new Date(d.getFullYear(), d.getMonth() + 1, 0)); };
const rp = n => 'Rp ' + Math.round(n).toLocaleString('id-ID');
const BULAN = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
const pct = (cur, prev) => (prev > 0 ? ((cur - prev) / prev) * 100 : null);

// Every money movement on an account, one row per side:
// source account gets -amount (or +amount for income / withdrawal from savings), transfer target gets +amount.
const FLOWS = `
  WITH f AS (
    SELECT account_id AS acc, date, time,
      CASE WHEN type = 'pemasukan' OR (type = 'tabungan' AND direction = 'tarik') THEN amount ELSE -amount END AS d
    FROM transactions WHERE user_id = :uid
    UNION ALL
    SELECT to_account_id, date, time, amount FROM transactions WHERE user_id = :uid AND type = 'transfer'
  )`;

// ---------- reports ----------
function accountReport(db, uid, from, to) {
  return db.prepare(`${FLOWS}
    SELECT a.id, a.name, a.type, a.active, a.initial_balance AS initialBalance,
      COALESCE(SUM(CASE WHEN f.date < :from THEN f.d END), 0) AS before,
      COALESCE(SUM(CASE WHEN f.date BETWEEN :from AND :to AND f.d > 0 THEN f.d END), 0) AS masuk,
      COALESCE(SUM(CASE WHEN f.date BETWEEN :from AND :to AND f.d < 0 THEN -f.d END), 0) AS keluar
    FROM accounts a LEFT JOIN f ON f.acc = a.id
    WHERE a.user_id = :uid GROUP BY a.id ORDER BY a.id`).all({ uid, from, to })
    .map(r => {
      const awal = r.initialBalance + r.before;
      return { id: r.id, name: r.name, type: r.type, active: !!r.active, awal, masuk: r.masuk, keluar: r.keluar, akhir: awal + r.masuk - r.keluar };
    });
}

function monthsLeft(fromDate, targetDate) {
  const a = parseDate(fromDate), b = parseDate(targetDate);
  return (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth()) - (b.getDate() >= a.getDate() ? 0 : 1);
}

function savingsReport(db, uid, from, to) {
  const now = today();
  return db.prepare(`
    SELECT s.id, s.name, s.place, s.active, s.target, s.target_date AS targetDate, s.initial_balance AS initialBalance,
      COALESCE(SUM(CASE WHEN t.date <= :now THEN CASE WHEN t.direction = 'tarik' THEN -t.amount ELSE t.amount END END), 0) AS delta,
      COALESCE(SUM(CASE WHEN t.date BETWEEN :from AND :to AND t.direction = 'setor' THEN t.amount END), 0) AS masuk,
      COALESCE(SUM(CASE WHEN t.date BETWEEN :from AND :to AND t.direction = 'tarik' THEN t.amount END), 0) AS keluar
    FROM savings s LEFT JOIN transactions t ON t.saving_id = s.id AND t.type = 'tabungan'
    WHERE s.user_id = :uid GROUP BY s.id ORDER BY s.id`).all({ uid, from, to, now })
    .map(s => {
      const saldo = s.initialBalance + s.delta;
      const sisa = Math.max(0, s.target - saldo);
      let rekomendasi = 0, bulanSisa = null;
      if (s.target > 0 && s.targetDate && sisa > 0) {
        bulanSisa = monthsLeft(now, s.targetDate);
        rekomendasi = Math.ceil(bulanSisa > 0 ? sisa / bulanSisa : sisa);
      }
      return { id: s.id, name: s.name, place: s.place, active: !!s.active, target: s.target, targetDate: s.targetDate,
        saldo, masuk: s.masuk, keluar: s.keluar, sisa, rekomendasi, bulanSisa,
        persen: s.target > 0 ? Math.min(999, (saldo / s.target) * 100) : null };
    });
}

// ---------- chart buckets: hourly for one day, daily up to ~3 months, monthly beyond ----------
function buckets(from, to, col = 't') {
  const n = daysBetween(from, to) + 1;
  if (n <= 1) {
    return { mode: 'jam', labels: Array.from({ length: 24 }, (_, h) => pad(h) + ':00'),
      sql: `CAST(substr(${col}.time, 1, 2) AS INTEGER)`, index: k => k };
  }
  const labels = [], idx = {};
  if (n <= 92) {
    for (let i = 0; i < n; i++) { const d = addDays(from, i), p = parseDate(d); idx[d] = i; labels.push(`${p.getDate()} ${BULAN[p.getMonth()]}`); }
    return { mode: 'hari', labels, sql: `${col}.date`, index: k => idx[k] };
  }
  const e = parseDate(to);
  for (let d = new Date(parseDate(from).getFullYear(), parseDate(from).getMonth(), 1); d <= e; d.setMonth(d.getMonth() + 1)) {
    idx[`${d.getFullYear()}-${pad(d.getMonth() + 1)}`] = labels.length;
    labels.push(`${BULAN[d.getMonth()]} ${String(d.getFullYear()).slice(2)}`);
  }
  return { mode: 'bulan', labels, sql: `substr(${col}.date, 1, 7)`, index: k => idx[k] };
}

function totals(db, uid, from, to) {
  const r = db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN type = 'pemasukan' THEN amount END), 0) AS income,
      COALESCE(SUM(CASE WHEN type = 'pengeluaran' THEN amount END), 0) AS expense,
      COUNT(*) AS count
    FROM transactions WHERE user_id = ? AND date BETWEEN ? AND ?`).get(uid, from, to);
  return { income: r.income, expense: r.expense, net: r.income - r.expense, count: r.count };
}

function spendingIn(db, uid, from, to) {
  return db.prepare(`SELECT COALESCE(SUM(amount), 0) AS s FROM transactions
    WHERE user_id = ? AND type = 'pengeluaran' AND date BETWEEN ? AND ?`).get(uid, from, to).s;
}

// ---------- settings & budget ----------
const DEFAULT_SETTINGS = { dailyLimit: 0, weeklyLimit: 0, monthlyLimit: 0, warnPercent: 80, notify: true };

function getSettings(db, uid) {
  const r = db.prepare('SELECT value FROM settings WHERE user_id = ?').get(uid);
  return { ...DEFAULT_SETTINGS, ...(r ? JSON.parse(r.value) : {}) };
}
function saveSettings(db, uid, values) {
  db.prepare('INSERT INTO settings (user_id, value) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET value = excluded.value')
    .run(uid, JSON.stringify(values));
}

function periods() {
  const t = today(), ws = weekStart(t);
  return { t, ws, we: addDays(ws, 6), mFrom: t.slice(0, 8) + '01', mTo: monthEnd(t) };
}

function budgetStatus(db, uid) {
  const st = getSettings(db, uid);
  const p = periods();
  return [
    { key: 'harian', label: 'Hari ini', limit: st.dailyLimit, spent: spendingIn(db, uid, p.t, p.t) },
    { key: 'mingguan', label: 'Minggu ini', limit: st.weeklyLimit, spent: spendingIn(db, uid, p.ws, p.we) },
    { key: 'bulanan', label: 'Bulan ini', limit: st.monthlyLimit, spent: spendingIn(db, uid, p.mFrom, p.mTo) }
  ].map(r => ({ ...r, persen: r.limit > 0 ? (r.spent / r.limit) * 100 : null }));
}

// Creates (once per period and level) and returns new alert notifications.
function checkAlerts(db, uid) {
  const st = getSettings(db, uid);
  if (!st.notify) return [];
  const p = periods();
  const checks = [
    { kind: 'harian', label: 'harian', period: p.t, limit: st.dailyLimit, spent: spendingIn(db, uid, p.t, p.t), when: 'hari ini' },
    { kind: 'mingguan', label: 'mingguan', period: p.ws, limit: st.weeklyLimit, spent: spendingIn(db, uid, p.ws, p.we), when: 'minggu ini' },
    { kind: 'bulanan', label: 'bulanan', period: p.t.slice(0, 7), limit: st.monthlyLimit, spent: spendingIn(db, uid, p.mFrom, p.mTo), when: 'bulan ini' }
  ];
  const cats = db.prepare(`SELECT c.id, c.name, c.limit_amount AS lim, COALESCE(SUM(t.amount), 0) AS spent
    FROM categories c LEFT JOIN transactions t ON t.category_id = c.id AND t.type = 'pengeluaran' AND t.date BETWEEN ? AND ?
    WHERE c.user_id = ? AND c.type = 'pengeluaran' AND c.active = 1 AND c.limit_amount > 0 GROUP BY c.id`).all(p.mFrom, p.mTo, uid);
  for (const c of cats) checks.push({ kind: 'kategori-' + c.id, label: `kategori "${c.name}"`, period: p.t.slice(0, 7), limit: c.lim, spent: c.spent, when: 'bulan ini' });

  const ins = db.prepare(`INSERT INTO notifications (user_id, key, level, title, body, read, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)
    ON CONFLICT (user_id, key) DO NOTHING RETURNING id, key, level, title, body, read, created_at AS createdAt`);
  const created = [];
  for (const c of checks) {
    if (!(c.limit > 0)) continue;
    const ratio = (c.spent / c.limit) * 100;
    const level = ratio >= 100 ? 'bahaya' : ratio >= st.warnPercent ? 'peringatan' : null;
    if (!level) continue;
    const title = level === 'bahaya' ? `Batas pengeluaran ${c.label} terlewati` : `Pengeluaran ${c.label} sudah ${Math.floor(ratio)}% dari batas`;
    const body = `${rp(c.spent)} dari batas ${rp(c.limit)} ${c.when}.` + (level === 'bahaya' ? ` Lebih ${rp(c.spent - c.limit)}.` : ` Sisa ${rp(c.limit - c.spent)}.`);
    const row = ins.get(uid, `${c.kind}:${c.period}:${level}`, level, title, body, new Date().toISOString());
    if (row) created.push({ ...row, read: false });
  }
  return created;
}

// ---------- insight ----------
function insight(db, uid, feature, from, to) {
  const b = buckets(from, to);
  const n = daysBetween(from, to) + 1;
  const prevTo = addDays(from, -1), prevFrom = addDays(from, -n);
  const out = { feature, from, to, prevFrom, prevTo, bucketMode: b.mode, labels: b.labels, notes: [], budget: budgetStatus(db, uid) };
  const zeros = () => new Array(b.labels.length).fill(0);

  if (feature === 'rekening') {
    const rep = accountReport(db, uid, from, to);
    const delta = zeros();
    const fb = buckets(from, to, 'f');
    for (const r of db.prepare(`${FLOWS} SELECT ${fb.sql} AS k, SUM(f.d) AS d FROM f WHERE f.date BETWEEN :from AND :to GROUP BY k`).all({ uid, from, to })) {
      const i = fb.index(r.k); if (i != null) delta[i] += r.d;
    }
    let running = rep.reduce((s, r) => s + r.awal, 0);
    out.series = { saldo: delta.map(d => (running += d)) };
    out.accounts = rep;
    const sum = k => rep.reduce((s, r) => s + r[k], 0);
    out.totals = { awal: sum('awal'), akhir: sum('akhir'), masuk: sum('masuk'), keluar: sum('keluar') };
    const positive = rep.reduce((s, r) => s + Math.max(0, r.akhir), 0);
    const top = [...rep].sort((a, c) => c.akhir - a.akhir)[0];
    if (top && top.akhir > 0) out.notes.push(`Saldo terbesar ada di ${top.name}: ${rp(top.akhir)} (${Math.round((top.akhir / positive) * 100)}% dari saldo positif).`);
    const ch = pct(out.totals.akhir, out.totals.awal);
    if (ch !== null) out.notes.push(`Total saldo ${ch >= 0 ? 'naik' : 'turun'} ${Math.abs(ch).toFixed(1)}% sepanjang periode ini.`);
    const busiest = [...rep].sort((a, c) => (c.masuk + c.keluar) - (a.masuk + a.keluar))[0];
    if (busiest && busiest.masuk + busiest.keluar > 0) out.notes.push(`Rekening paling aktif: ${busiest.name} (${rp(busiest.masuk)} masuk, ${rp(busiest.keluar)} keluar).`);
    const neg = rep.filter(r => r.akhir < 0);
    if (neg.length) out.notes.push(`Perhatian: saldo ${neg.map(r => r.name).join(', ')} minus. Cek kembali saldo awal atau transaksinya.`);
    return out;
  }

  if (feature === 'tabungan') {
    const rep = savingsReport(db, uid, from, to);
    const setor = zeros(), tarik = zeros();
    for (const r of db.prepare(`SELECT ${b.sql} AS k,
        SUM(CASE WHEN t.direction = 'tarik' THEN 0 ELSE t.amount END) AS setor,
        SUM(CASE WHEN t.direction = 'tarik' THEN t.amount ELSE 0 END) AS tarik
      FROM transactions t WHERE t.user_id = ? AND t.type = 'tabungan' AND t.date BETWEEN ? AND ? GROUP BY k`).all(uid, from, to)) {
      const i = b.index(r.k); if (i != null) { setor[i] += r.setor; tarik[i] += r.tarik; }
    }
    out.series = { setor, tarik };
    out.savings = rep;
    out.totals = { saldo: rep.reduce((s, r) => s + r.saldo, 0), setor: setor.reduce((a, c) => a + c, 0), tarik: tarik.reduce((a, c) => a + c, 0) };
    for (const r of rep.filter(r => r.active && r.target > 0)) {
      if (r.persen >= 100) out.notes.push(`Target "${r.name}" sudah tercapai (${r.persen.toFixed(0)}%).`);
      else if (r.bulanSisa !== null && r.bulanSisa <= 0) out.notes.push(`Tanggal target "${r.name}" sudah lewat, masih kurang ${rp(r.sisa)}.`);
      else if (r.rekomendasi > 0) out.notes.push(`"${r.name}": sisihkan ${rp(r.rekomendasi)}/bulan agar target ${rp(r.target)} tercapai tepat waktu.`);
    }
    const inc = totals(db, uid, from, to).income;
    if (inc > 0 && out.totals.setor > 0) out.notes.push(`Rasio menabung periode ini ${((out.totals.setor / inc) * 100).toFixed(1)}% dari pemasukan.`);
    return out;
  }

  // transaksi
  const income = zeros(), expense = zeros();
  for (const r of db.prepare(`SELECT ${b.sql} AS k,
      SUM(CASE WHEN t.type = 'pemasukan' THEN t.amount ELSE 0 END) AS inc,
      SUM(CASE WHEN t.type = 'pengeluaran' THEN t.amount ELSE 0 END) AS exp
    FROM transactions t WHERE t.user_id = ? AND t.date BETWEEN ? AND ? AND t.type IN ('pemasukan', 'pengeluaran') GROUP BY k`).all(uid, from, to)) {
    const i = b.index(r.k); if (i != null) { income[i] += r.inc; expense[i] += r.exp; }
  }
  const cur = totals(db, uid, from, to), prev = totals(db, uid, prevFrom, prevTo);
  out.series = { income, expense };
  out.totals = cur;
  out.previous = prev;
  out.change = { income: pct(cur.income, prev.income), expense: pct(cur.expense, prev.expense) };
  const byCat = db.prepare(`SELECT t.type, COALESCE(c.name, 'Tanpa kategori') AS name, SUM(t.amount) AS amount
    FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
    WHERE t.user_id = ? AND t.date BETWEEN ? AND ? AND t.type IN ('pemasukan', 'pengeluaran')
    GROUP BY t.type, t.category_id ORDER BY amount DESC`).all(uid, from, to);
  out.expenseByCategory = byCat.filter(r => r.type === 'pengeluaran').map(r => ({ name: r.name, amount: r.amount }));
  out.incomeByCategory = byCat.filter(r => r.type === 'pemasukan').map(r => ({ name: r.name, amount: r.amount }));
  out.topExpenses = db.prepare(`SELECT t.date, t.detail, t.amount, COALESCE(c.name, '-') AS category
    FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
    WHERE t.user_id = ? AND t.type = 'pengeluaran' AND t.date BETWEEN ? AND ? ORDER BY t.amount DESC LIMIT 5`).all(uid, from, to);

  if (out.change.expense !== null) out.notes.push(`Pengeluaran ${out.change.expense >= 0 ? 'naik' : 'turun'} ${Math.abs(out.change.expense).toFixed(1)}% dibanding periode sebelumnya (${rp(prev.expense)}).`);
  else if (cur.expense > 0) out.notes.push('Belum ada pengeluaran di periode sebelumnya untuk dibandingkan.');
  if (out.expenseByCategory[0] && cur.expense > 0) {
    const c = out.expenseByCategory[0];
    out.notes.push(`Kategori pengeluaran terbesar: ${c.name}, ${rp(c.amount)} (${Math.round((c.amount / cur.expense) * 100)}%).`);
  }
  if (n > 1 && cur.expense > 0) out.notes.push(`Rata-rata pengeluaran ${rp(cur.expense / n)} per hari.`);
  if (cur.income > 0) {
    const rate = (cur.net / cur.income) * 100;
    out.notes.push(rate >= 0 ? `Anda menyisakan ${rate.toFixed(1)}% dari pemasukan.` : `Pengeluaran melebihi pemasukan sebesar ${rp(-cur.net)}.`);
  }
  if (b.mode !== 'jam') {
    const peak = expense.indexOf(Math.max(...expense));
    if (expense[peak] > 0) out.notes.push(`Pengeluaran tertinggi pada ${b.labels[peak]}: ${rp(expense[peak])}.`);
  }
  return out;
}

module.exports = { accountReport, savingsReport, insight, budgetStatus, getSettings, saveSettings, checkAlerts, DEFAULT_SETTINGS, today, dateStr, addDays };
