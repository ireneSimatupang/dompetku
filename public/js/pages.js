import { trendChart, shareBars } from './charts.js';
import {
  api, state, h, rp, tgl, toast, openForm, confirmDialog, periodPicker, table, seg, loadMaster, readOnly,
  bindMoney, parseMoney, moneyVal, todayStr, nowTime, addDays, rangeLabel, TX_LABEL, ACC_LABEL
} from './core.js';
import * as notify from './notify.js';

const C = { masuk: 'var(--masuk)', keluar: 'var(--keluar)', primary: 'var(--primary)', tabungan: 'var(--tabungan)', transfer: 'var(--transfer)' };
// fabCovered: on phones the floating + button already does this, so the header button is hidden there.
const addBtn = (label = 'Tambah', fabCovered = false) => readOnly() ? '' : `<button class="btn btn-primary add-btn ${fabCovered ? 'fab-covered' : ''}" type="button" data-add>${h(label)}</button>`;
const chg = (v, goodWhenUp) => {
  if (v === null || v === undefined) return '<span class="chg flat">tidak ada pembanding</span>';
  const up = v >= 0; const cls = Math.abs(v) < 0.05 ? 'flat' : (up === goodWhenUp ? 'down' : 'up');
  return `<span class="chg ${cls}">${up ? '▲' : '▼'} ${Math.abs(v).toFixed(1)}% vs periode lalu</span>`;
};
let charts = [];
export function cleanup() { charts.forEach(c => c.destroy()); charts = []; }

// =====================================================================
// DASHBOARD
// =====================================================================
const dash = { preset: '7', from: '', to: '', feature: 'transaksi' };
const PRESETS = [['0', 'Hari ini'], ['1', 'Kemarin'], ['7', '7 hari'], ['30', '30 hari'], ['bulan', 'Bulan ini'], ['kustom', 'Pilih tanggal']];

function presetRange(p) {
  const t = todayStr();
  if (p === '0') return [t, t];
  if (p === '1') return [addDays(t, -1), addDays(t, -1)];
  if (p === '7') return [addDays(t, -6), t];
  if (p === '30') return [addDays(t, -29), t];
  if (p === 'bulan') return [t.slice(0, 8) + '01', t];
  return [dash.from || addDays(t, -6), dash.to || t];
}

export async function dashboard(root) {
  root.innerHTML = `
    <div class="page-head">
      <div class="tools"><div id="presets"></div><div id="custom"></div></div>
      ${addBtn('Tambah transaksi', true)}
    </div>
    <div class="page-head" style="margin-bottom:14px"><div id="features"></div><small class="hint" id="rangeText"></small></div>
    <div id="dashBody" class="stack"><div class="panel"><p class="empty-note">Memuat…</p></div></div>`;
  const add = root.querySelector('[data-add]'); if (add) add.onclick = () => openTxForm();

  const renderCustom = () => {
    const box = root.querySelector('#custom');
    if (dash.preset !== 'kustom') { box.innerHTML = ''; return; }
    const [f, t] = presetRange('kustom');
    box.innerHTML = `<div class="period"><input type="date" id="cf" value="${f}" aria-label="Dari"><span class="sep">s/d</span><input type="date" id="ct" value="${t}" aria-label="Sampai"></div>`;
    box.querySelectorAll('input').forEach(i => i.onchange = () => { dash.from = box.querySelector('#cf').value; dash.to = box.querySelector('#ct').value; if (dash.from > dash.to) [dash.from, dash.to] = [dash.to, dash.from]; load(); });
  };
  seg(root.querySelector('#presets'), PRESETS, dash.preset, v => { dash.preset = v; renderCustom(); load(); });
  seg(root.querySelector('#features'), [['transaksi', 'Insight transaksi'], ['rekening', 'Insight rekening'], ['tabungan', 'Insight tabungan']], dash.feature, v => { dash.feature = v; load(); });
  renderCustom();

  async function load() {
    const [from, to] = presetRange(dash.preset);
    root.querySelector('#rangeText').textContent = rangeLabel(from, to);
    const body = root.querySelector('#dashBody');
    try {
      const d = await api('GET', `/api/insight?feature=${dash.feature}&from=${from}&to=${to}`);
      cleanup();
      renderInsight(body, d);
    } catch (e) { body.innerHTML = `<div class="panel"><p class="empty-note">${h(e.message)}</p></div>`; }
  }
  load();
}

function budgetHtml(budget) {
  const rows = budget.filter(b => b.limit > 0);
  if (!rows.length) return `<p class="empty-note">Batas pengeluaran belum diatur. ${readOnly() ? '' : '<a href="#/pengaturan">Atur di Pengaturan</a>.'}</p>`;
  const warn = state.settings ? state.settings.warnPercent : 80;
  return `<div class="budget">${rows.map(b => {
    const p = b.persen; const cls = p >= 100 ? 'over' : p >= warn ? 'warn' : '';
    return `<div class="rail-row"><div class="rail-top"><span>${b.label}</span><b>${rp(b.spent)} <small class="hint">/ ${rp(b.limit)}</small></b></div>
      <div class="rail ${cls}"><span style="width:${Math.min(100, p)}%"></span></div></div>`;
  }).join('')}</div>`;
}

function flowBar(a, b, ca, cb) {
  const tot = a + b;
  if (tot <= 0) return '<div class="flow-bar"></div>';
  return `<div class="flow-bar" role="img" aria-label="Perbandingan"><span style="width:${(a / tot) * 100}%;background:${ca}"></span><span style="width:${(b / tot) * 100}%;background:${cb}"></span></div>`;
}

function renderInsight(body, d) {
  const range = rangeLabel(d.from, d.to);
  const per = d.bucketMode === 'jam' ? 'per jam' : d.bucketMode === 'hari' ? 'per hari' : 'per bulan';
  let hero = '', chartTitle = '', series = [], type = 'line', extra = '';

  if (d.feature === 'transaksi') {
    const t = d.totals;
    hero = `<div><div class="net-label">Sisa uang periode ini</div><div class="net ${t.net < 0 ? 'neg' : ''}">${rp(t.net)}</div>
      <p class="net-sub">${t.count ? `${t.count} transaksi tercatat, ${range}.` : `Belum ada transaksi pada ${range}.`}</p></div>
      <div class="flow">${flowBar(t.income, t.expense, C.masuk, C.keluar)}
      <div class="flow-legend">
        <div><small><i style="background:${C.masuk}"></i>Pemasukan</small><b>${rp(t.income)}</b>${chg(d.change.income, true)}</div>
        <div><small><i style="background:${C.keluar}"></i>Pengeluaran</small><b>${rp(t.expense)}</b>${chg(d.change.expense, false)}</div>
        <div><small>Periode sebelumnya</small><b>${rp(d.previous.net)}</b><span class="chg flat">${rangeLabel(d.prevFrom, d.prevTo)}</span></div>
      </div></div>`;
    chartTitle = `Tren pemasukan & pengeluaran ${per}`;
    series = [{ name: 'Pemasukan', color: C.masuk, values: d.series.income }, { name: 'Pengeluaran', color: C.keluar, values: d.series.expense }];
    type = d.labels.length > 45 ? 'line' : 'bar';
    extra = `<div class="cols">
      <div class="panel"><h2>Pengeluaran per kategori</h2><div id="catOut"></div></div>
      <div class="panel"><h2>Pemasukan per kategori</h2><div id="catIn"></div></div></div>
      <div id="topExp"></div>`;
  } else if (d.feature === 'rekening') {
    const t = d.totals;
    hero = `<div><div class="net-label">Total saldo semua rekening</div><div class="net ${t.akhir < 0 ? 'neg' : ''}">${rp(t.akhir)}</div>
      <p class="net-sub">Posisi akhir ${tgl(d.to)}, dari saldo awal ${rp(t.awal)}.</p></div>
      <div class="flow">${flowBar(t.masuk, t.keluar, C.masuk, C.keluar)}
      <div class="flow-legend">
        <div><small><i style="background:${C.masuk}"></i>Saldo masuk</small><b>${rp(t.masuk)}</b></div>
        <div><small><i style="background:${C.keluar}"></i>Saldo keluar</small><b>${rp(t.keluar)}</b></div>
        <div><small>Selisih</small><b>${rp(t.masuk - t.keluar)}</b></div>
      </div></div>`;
    chartTitle = `Pergerakan total saldo ${per}`;
    series = [{ name: 'Total saldo', color: C.primary, values: d.series.saldo, fill: true }];
    extra = `<div class="cols cols-even"><div class="panel"><h2>Sebaran saldo</h2><div id="accShare"></div></div>
      <div class="panel"><h2>Rincian rekening</h2><div id="accTable"></div></div></div>`;
  } else {
    const t = d.totals;
    hero = `<div><div class="net-label">Total saldo tabungan</div><div class="net">${rp(t.saldo)}</div>
      <p class="net-sub">Setoran ${rp(t.setor)} dan penarikan ${rp(t.tarik)} pada ${range}.</p></div>
      <div class="flow">${flowBar(t.setor, t.tarik, C.tabungan, C.keluar)}
      <div class="flow-legend">
        <div><small><i style="background:${C.tabungan}"></i>Setoran</small><b>${rp(t.setor)}</b></div>
        <div><small><i style="background:${C.keluar}"></i>Penarikan</small><b>${rp(t.tarik)}</b></div>
        <div><small>Bersih</small><b>${rp(t.setor - t.tarik)}</b></div>
      </div></div>`;
    chartTitle = `Setoran & penarikan tabungan ${per}`;
    series = [{ name: 'Setor', color: C.tabungan, values: d.series.setor }, { name: 'Tarik', color: C.keluar, values: d.series.tarik }];
    type = 'bar';
    extra = `<div class="panel"><h2>Progres target tabungan</h2><div id="savTable"></div></div>`;
  }

  body.innerHTML = `<div class="ledger">${hero}</div>
    <div class="cols">
      <div class="panel"><h2>${chartTitle}</h2><div id="trend"></div></div>
      <div class="stack">
        <div class="panel"><h2>Catatan</h2>${d.notes.length ? `<ul class="notes">${d.notes.map(n => `<li>${h(n)}</li>`).join('')}</ul>` : '<p class="empty-note">Belum cukup data untuk dianalisis.</p>'}</div>
        <div class="panel"><h2>Batas pengeluaran</h2>${budgetHtml(d.budget)}</div>
      </div>
    </div>${extra}`;

  charts.push(trendChart(body.querySelector('#trend'), { labels: d.labels, series, type, format: rp, ariaLabel: chartTitle }));

  if (d.feature === 'transaksi') {
    shareBars(body.querySelector('#catOut'), d.expenseByCategory, { color: C.keluar, format: rp });
    shareBars(body.querySelector('#catIn'), d.incomeByCategory, { color: C.masuk, format: rp });
    if (d.topExpenses.length) {
      const box = body.querySelector('#topExp');
      box.innerHTML = '<div class="panel"><h2>Pengeluaran terbesar</h2><div id="topTbl"></div></div>';
      table(box.querySelector('#topTbl'), { rows: d.topExpenses, columns: [
        { label: 'Detail', card: 'title', render: r => h(r.detail || r.category) },
        { label: 'Nominal', cls: 'num amt-keluar', card: 'amount', render: r => rp(r.amount) },
        { label: 'Kategori', render: r => h(r.category) },
        { label: 'Tanggal', render: r => tgl(r.date) }
      ] });
    }
  } else if (d.feature === 'rekening') {
    shareBars(body.querySelector('#accShare'), d.accounts.filter(a => a.akhir > 0).map(a => ({ name: a.name, amount: a.akhir })), { color: C.primary, format: rp });
    table(body.querySelector('#accTable'), { rows: d.accounts, empty: 'Belum ada rekening.', columns: [
      { label: 'Rekening', card: 'title', render: r => h(r.name) },
      { label: 'Saldo akhir', cls: 'num', card: 'amount', render: r => rp(r.akhir) },
      { label: 'Masuk', cls: 'num amt-masuk', render: r => rp(r.masuk) },
      { label: 'Keluar', cls: 'num amt-keluar', render: r => rp(r.keluar) }
    ] });
  } else {
    savingsTable(body.querySelector('#savTable'), d.savings.filter(s => s.active !== false), true);
  }
}

// =====================================================================
// TRANSAKSI
// =====================================================================
const txFilter = { type: '', accountId: '', q: '' };

export async function transaksi(root) {
  await loadMaster();
  root.innerHTML = `
    <div class="page-head"><div class="tools" id="period"></div>${addBtn('Tambah', true)}</div>
    <div class="filters">
      <select id="fType" aria-label="Filter jenis"><option value="">Semua jenis</option>${Object.entries(TX_LABEL).map(([v, l]) => `<option value="${v}" ${txFilter.type === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <select id="fAcc" aria-label="Filter rekening"><option value="">Semua rekening</option>${state.master.accounts.map(a => `<option value="${a.id}" ${String(txFilter.accountId) === String(a.id) ? 'selected' : ''}>${h(a.name)}</option>`).join('')}</select>
      <input id="fQ" type="search" placeholder="Cari detail atau kategori" value="${h(txFilter.q)}">
    </div>
    <p class="summary-line" id="sum"></p>
    <div id="list"></div>`;
  const add = root.querySelector('[data-add]'); if (add) add.onclick = () => openTxForm(null, load);
  let range = periodPicker(root.querySelector('#period'), 'transaksi', r => { range = r; load(); });
  root.querySelector('#fType').onchange = e => { txFilter.type = e.target.value; load(); };
  root.querySelector('#fAcc').onchange = e => { txFilter.accountId = e.target.value; load(); };
  let tmr; root.querySelector('#fQ').oninput = e => { clearTimeout(tmr); tmr = setTimeout(() => { txFilter.q = e.target.value; load(); }, 250); };

  async function load() {
    const qs = new URLSearchParams({ from: range.from, to: range.to, type: txFilter.type, accountId: txFilter.accountId, q: txFilter.q });
    const rows = await api('GET', '/api/transactions?' + qs).catch(e => { toast(e.message, 'error'); return []; });
    const sum = t => rows.filter(r => r.type === t).reduce((s, r) => s + r.amount, 0);
    const inc = sum('pemasukan'), exp = sum('pengeluaran');
    root.querySelector('#sum').innerHTML = `<span>Pemasukan <b class="amt-masuk">${rp(inc)}</b></span><span>Pengeluaran <b class="amt-keluar">${rp(exp)}</b></span><span>Selisih <b>${rp(inc - exp)}</b></span><span><b>${rows.length}</b> transaksi</span>`;
    const tujuan = r => r.type === 'tabungan' ? `${r.direction === 'tarik' ? 'Tarik dari' : 'Setor ke'} ${h(r.savingName)}` : h(r.categoryName || (r.type === 'transfer' ? 'Transfer' : '-'));
    const sign = r => r.type === 'pemasukan' || (r.type === 'tabungan' && r.direction === 'tarik') ? '+' : r.type === 'transfer' ? '' : '−';
    const amtCls = r => r.type === 'pemasukan' ? 'amt-masuk' : r.type === 'pengeluaran' ? 'amt-keluar' : 'amt-' + r.type;
    table(root.querySelector('#list'), {
      rows, empty: readOnly() ? 'Tidak ada transaksi di periode ini.' : 'Tidak ada transaksi di periode ini. Tekan Tambah untuk mencatat.',
      columns: [
        { label: 'No', cls: 'no', render: (r, i) => i + 1 },
        { label: 'Kategori', render: r => `<span class="tag tag-${r.type}">${TX_LABEL[r.type]}</span>` },
        { label: 'Tujuan', card: 'title', render: tujuan },
        { label: 'Detail', card: 'sub', render: r => h(r.detail) + `<span class="mobile-date">${r.detail ? ' · ' : ''}${tgl(r.date)} ${r.time}</span>`, emptyIf: () => false },
        { label: 'Nominal', cls: 'num', card: 'amount', render: r => `<span class="${amtCls(r)}">${sign(r)}${rp(r.amount)}</span>` },
        { label: 'Rekening', render: r => h(r.accountName) },
        { label: 'Rek. tujuan', render: r => r.type === 'transfer' ? h(r.toAccountName) : r.type === 'tabungan' && r.direction === 'setor' ? h(r.savingName) : '' },
        { label: 'Tanggal', cls: 'date-col', render: r => `${tgl(r.date)} <small class="hint">${r.time}</small>` },
        ...(readOnly() ? [] : [{ label: 'Aksi', cls: 'acts', render: r => `<button class="btn btn-sm" data-edit="${r.id}">Edit</button><button class="btn btn-sm btn-danger" data-del="${r.id}">Hapus</button>` }])
      ]
    });
    root.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => openTxForm(rows.find(r => r.id === Number(b.dataset.edit)), load));
    root.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
      const r = rows.find(x => x.id === Number(b.dataset.del));
      if (!await confirmDialog('Hapus transaksi?', `${TX_LABEL[r.type]} ${rp(r.amount)} pada ${tgl(r.date)} akan dihapus permanen.`)) return;
      try { await api('DELETE', '/api/transactions/' + r.id); toast('Transaksi dihapus'); load(); } catch (e) { toast(e.message, 'error'); }
    });
  }
  load();
}

export async function openTxForm(tx, after) {
  if (readOnly()) return;
  await loadMaster();
  const m = state.master;
  if (!m.accounts.some(a => a.active)) { toast('Tambahkan rekening dulu di Manajemen › Rekening', 'error'); location.hash = '#/kelola/rekening'; return; }
  const cur = tx || { type: 'pengeluaran', date: todayStr(), time: nowTime(), amount: '', detail: '', accountId: (m.accounts.find(a => a.active) || {}).id, direction: 'setor' };
  const opt = (list, sel, blank) => (blank ? `<option value="">${blank}</option>` : '') + list.map(x => `<option value="${x.id}" ${x.id === sel ? 'selected' : ''}>${h(x.name)}</option>`).join('');
  const usable = (list, sel) => list.filter(x => x.active || x.id === sel);

  openForm({
    title: tx ? 'Ubah transaksi' : 'Tambah transaksi',
    body: `
      <div class="seg seg-radio" role="radiogroup" aria-label="Jenis transaksi">${Object.entries(TX_LABEL).map(([v, l]) =>
        `<label><input type="radio" name="type" value="${v}" ${cur.type === v ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div>
      <label>Nominal<input name="amount" data-money required value="${moneyVal(cur.amount)}" placeholder="0"></label>
      <div class="grid-2"><label>Tanggal<input type="date" name="date" required value="${cur.date}"></label><label>Jam<input type="time" name="time" value="${cur.time}"></label></div>
      <label data-for="cat"><span>Tujuan / kategori</span><select name="categoryId"></select></label>
      <div data-for="sav" class="grid-2"><label>Tabungan<select name="savingId">${opt(usable(m.savings, cur.savingId), cur.savingId)}</select></label>
        <label>Arah<select name="direction"><option value="setor" ${cur.direction !== 'tarik' ? 'selected' : ''}>Setor ke tabungan</option><option value="tarik" ${cur.direction === 'tarik' ? 'selected' : ''}>Tarik dari tabungan</option></select></label></div>
      <label><span data-acc-label>Rekening</span><select name="accountId">${opt(usable(m.accounts, cur.accountId), cur.accountId)}</select></label>
      <label data-for="to">Ke rekening<select name="toAccountId">${opt(usable(m.accounts, cur.toAccountId), cur.toAccountId, 'Pilih rekening tujuan')}</select></label>
      <label>Detail<input name="detail" maxlength="200" value="${h(cur.detail)}" placeholder="Contoh: gaji Oktober"></label>`,
    onOpen(form) {
      const sync = () => {
        const type = form.querySelector('input[name=type]:checked').value;
        const cats = usable(m.categories.filter(c => c.type === type), cur.categoryId);
        const catSel = form.querySelector('select[name=categoryId]');
        const keep = catSel.value || cur.categoryId;
        catSel.innerHTML = opt(cats, cats.some(c => c.id === Number(keep)) ? Number(keep) : null, type === 'transfer' ? 'Tanpa kategori' : null);
        form.querySelector('[data-for=cat]').hidden = type === 'tabungan';
        form.querySelector('[data-for=sav]').hidden = type !== 'tabungan';
        form.querySelector('[data-for=to]').hidden = type !== 'transfer';
        const dir = form.querySelector('select[name=direction]').value;
        form.querySelector('[data-acc-label]').textContent = type === 'transfer' ? 'Dari rekening' : type === 'tabungan' ? (dir === 'tarik' ? 'Masuk ke rekening' : 'Dari rekening') : type === 'pemasukan' ? 'Masuk ke rekening' : 'Dibayar dari rekening';
      };
      form.querySelectorAll('input[name=type], select[name=direction]').forEach(i => i.addEventListener('change', sync));
      sync();
    },
    async onSubmit(d) {
      const body = { type: d.type, date: d.date, time: d.time, amount: parseMoney(d.amount), detail: d.detail, accountId: Number(d.accountId),
        categoryId: d.categoryId ? Number(d.categoryId) : null, toAccountId: d.toAccountId ? Number(d.toAccountId) : null,
        savingId: d.savingId ? Number(d.savingId) : null, direction: d.direction };
      if (!body.amount) throw new Error('Isi nominal transaksi');
      if (body.type === 'tabungan' && !body.savingId) throw new Error('Buat tabungan dulu di Manajemen › Tabungan');
      if ((body.type === 'pemasukan' || body.type === 'pengeluaran') && !body.categoryId) throw new Error('Pilih kategori. Tambah kategori di Manajemen › Kategori.');
      const res = tx ? await api('PUT', '/api/transactions/' + tx.id, body) : await api('POST', '/api/transactions', body);
      toast(tx ? 'Transaksi diperbarui' : 'Transaksi disimpan');
      if (res.alerts && res.alerts.length) window.dispatchEvent(new CustomEvent('alerts:new', { detail: res.alerts }));
      if (after) after(); else window.dispatchEvent(new Event('route:refresh'));
    }
  });
}

// =====================================================================
// REKENING (report)
// =====================================================================
export async function rekening(root) {
  root.innerHTML = `<div class="page-head"><div class="tools" id="period"></div></div><div id="list"></div>`;
  let range = periodPicker(root.querySelector('#period'), 'rekening', r => { range = r; load(); });
  async function load() {
    const rows = await api('GET', `/api/reports/accounts?from=${range.from}&to=${range.to}`).catch(e => { toast(e.message, 'error'); return []; });
    const shown = rows.filter(r => r.active || r.masuk || r.keluar || r.awal);
    const tot = k => shown.reduce((s, r) => s + r[k], 0);
    table(root.querySelector('#list'), {
      rows: shown, empty: 'Belum ada rekening. Tambahkan di Manajemen › Rekening.',
      rowClass: r => r.active ? '' : 'inactive',
      columns: [
        { label: 'No', cls: 'no', render: (r, i) => i + 1 },
        { label: 'Rekening', card: 'title', render: r => `${h(r.name)} <small class="hint">${ACC_LABEL[r.type] || ''}</small>` },
        { label: 'Total', cls: 'num', card: 'amount', render: r => `<span class="${r.akhir < 0 ? 'amt-keluar' : ''}">${rp(r.akhir)}</span>` },
        { label: 'Awal', cls: 'num', render: r => rp(r.awal) },
        { label: 'Saldo masuk', cls: 'num amt-masuk', render: r => rp(r.masuk) },
        { label: 'Saldo keluar', cls: 'num amt-keluar', render: r => rp(r.keluar) }
      ],
      footer: [{ html: '', cls: 'no' }, { html: 'Total', label: '' }, { html: rp(tot('akhir')), cls: 'num', label: 'Total saldo' }, { html: rp(tot('awal')), cls: 'num', label: 'Awal' },
        { html: rp(tot('masuk')), cls: 'num', label: 'Masuk' }, { html: rp(tot('keluar')), cls: 'num', label: 'Keluar' }]
    });
  }
  load();
}

// =====================================================================
// TABUNGAN (report)
// =====================================================================
function savingsTable(box, rows, compact) {
  table(box, {
    rows, empty: 'Belum ada tabungan. Tambahkan di Manajemen › Tabungan.',
    rowClass: r => r.active === false ? 'inactive' : '',
    columns: [
      { label: 'No', cls: 'no', render: (r, i) => i + 1 },
      { label: 'Tabungan', card: 'title', render: r => `${h(r.name)}${r.place ? ` <small class="hint">${h(r.place)}</small>` : ''}` },
      { label: 'Saldo', cls: 'num amt-tabungan', card: 'amount', render: r => rp(r.saldo) },
      { label: 'Target', cls: 'num', render: r => r.target ? rp(r.target) : '' },
      ...(compact ? [] : [
        { label: 'Masuk', cls: 'num amt-masuk', render: r => rp(r.masuk) },
        { label: 'Keluar', cls: 'num amt-keluar', render: r => rp(r.keluar) }]),
      { label: 'Tanggal target', render: r => r.targetDate ? tgl(r.targetDate) : '' },
      { label: 'Rekomendasi/bulan', cls: 'num', render: r => r.target ? (r.sisa <= 0 ? 'Tercapai' : r.bulanSisa !== null && r.bulanSisa <= 0 ? `<span class="amt-keluar">Lewat target</span>` : r.rekomendasi ? rp(r.rekomendasi) : '') : '' },
      { label: 'Persentase', render: r => r.persen === null ? '' : `<div class="progress"><div class="rail"><span style="width:${Math.min(100, r.persen)}%;background:var(--tabungan)"></span></div><b>${Math.floor(r.persen)}%</b></div>` }
    ]
  });
}

export async function tabungan(root) {
  root.innerHTML = `<div class="page-head"><div class="tools" id="period"></div></div><div id="list"></div>`;
  let range = periodPicker(root.querySelector('#period'), 'tabungan', r => { range = r; load(); });
  async function load() {
    const rows = await api('GET', `/api/reports/savings?from=${range.from}&to=${range.to}`).catch(e => { toast(e.message, 'error'); return []; });
    savingsTable(root.querySelector('#list'), rows, false);
  }
  load();
}

// =====================================================================
// MANAJEMEN
// =====================================================================
function statusTag(r) { return r.active ? '<span class="tag tag-pemasukan">Aktif</span>' : '<span class="tag tag-off">Nonaktif</span>'; }
function actsHtml(r) {
  if (readOnly()) return '';
  return `<button class="btn btn-sm" data-edit="${r.id}">Edit</button><button class="btn btn-sm" data-toggle="${r.id}">${r.active ? 'Nonaktifkan' : 'Aktifkan'}</button><button class="btn btn-sm btn-danger" data-del="${r.id}">Hapus</button>`;
}
function wireActs(root, rows, { endpoint, label, edit, reload }) {
  root.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => edit(rows.find(r => r.id === Number(b.dataset.edit))));
  root.querySelectorAll('[data-toggle]').forEach(b => b.onclick = async () => {
    const r = rows.find(x => x.id === Number(b.dataset.toggle));
    try { await api('PUT', `${endpoint}/${r.id}`, { ...r, active: !r.active }); toast(`${label} ${r.active ? 'dinonaktifkan' : 'diaktifkan'}`); reload(); } catch (e) { toast(e.message, 'error'); }
  });
  root.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    const r = rows.find(x => x.id === Number(b.dataset.del));
    if (!await confirmDialog(`Hapus ${label.toLowerCase()}?`, `"${r.name}" akan dihapus. Data yang sudah dipakai transaksi tidak bisa dihapus, nonaktifkan saja.`)) return;
    try { await api('DELETE', `${endpoint}/${r.id}`); toast(`${label} dihapus`); reload(); } catch (e) { toast(e.message, 'error'); }
  });
}

export async function kelolaRekening(root) {
  root.innerHTML = `<div class="page-head"><p class="hint">Daftar rekening, dompet tunai, dan e-wallet beserta saldo awalnya.</p>${addBtn()}</div><div id="list"></div>`;
  const edit = r => openForm({
    title: r ? 'Ubah rekening' : 'Tambah rekening',
    body: `<label>Jenis rekening<input name="name" required maxlength="60" value="${h(r ? r.name : '')}" placeholder="Contoh: BNI, Mandiri, Cash"></label>
      <label>Tipe<select name="type">${Object.entries(ACC_LABEL).map(([v, l]) => `<option value="${v}" ${r && r.type === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label>Saldo awal<input name="initialBalance" data-money="neg" value="${r ? moneyVal(r.initialBalance) : ''}" placeholder="0"><span class="hint">Saldo sebelum transaksi pertama dicatat.</span></label>`,
    async onSubmit(d) {
      const body = { ...(r || {}), name: d.name, type: d.type, initialBalance: parseMoney(d.initialBalance) };
      r ? await api('PUT', '/api/accounts/' + r.id, body) : await api('POST', '/api/accounts', body);
      toast('Rekening disimpan'); load();
    }
  });
  const add = root.querySelector('[data-add]'); if (add) add.onclick = () => edit(null);
  async function load() {
    const rows = await api('GET', '/api/accounts');
    table(root.querySelector('#list'), {
      rows, empty: 'Belum ada rekening.', rowClass: r => r.active ? '' : 'inactive',
      columns: [
        { label: 'No', cls: 'no', render: (r, i) => i + 1 },
        { label: 'Jenis rekening', card: 'title', render: r => h(r.name) },
        { label: 'Saldo awal', cls: 'num', card: 'amount', render: r => rp(r.initialBalance) },
        { label: 'Tipe', render: r => ACC_LABEL[r.type] || r.type },
        { label: 'Status', render: statusTag },
        ...(readOnly() ? [] : [{ label: 'Aksi', cls: 'acts', render: actsHtml }])
      ]
    });
    wireActs(root, rows, { endpoint: '/api/accounts', label: 'Rekening', edit, reload: load });
  }
  load();
}

let catTab = 'pemasukan';
export async function kelolaKategori(root) {
  root.innerHTML = `<div class="page-head"><p class="hint">Kategori dipakai sebagai “tujuan” saat mencatat transaksi.</p>${addBtn()}</div>
    <div class="tabs" role="tablist">${[['pemasukan', 'Pemasukan'], ['pengeluaran', 'Pengeluaran'], ['transfer', 'Transfer']].map(([v, l]) =>
      `<button role="tab" data-tab="${v}" aria-selected="${catTab === v}">${l}</button>`).join('')}</div><div id="list"></div>`;
  root.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { catTab = b.dataset.tab; root.querySelectorAll('[data-tab]').forEach(x => x.setAttribute('aria-selected', x === b)); load(); });
  const edit = r => openForm({
    title: (r ? 'Ubah' : 'Tambah') + ' kategori ' + TX_LABEL[catTab].toLowerCase(),
    body: `<label>Jenis ${TX_LABEL[catTab].toLowerCase()}<input name="name" required maxlength="60" value="${h(r ? r.name : '')}" placeholder="${catTab === 'pemasukan' ? 'Contoh: Gaji, Bonus' : catTab === 'pengeluaran' ? 'Contoh: Makan, Bensin' : 'Contoh: Pindah bank'}"></label>
      ${catTab === 'pengeluaran' ? `<label>Batas bulanan (opsional)<input name="limit" data-money value="${r ? moneyVal(r.limit) : ''}" placeholder="0 = tanpa batas"><span class="hint">Anda akan diberi notifikasi saat pengeluaran kategori ini mendekati batas.</span></label>` : ''}`,
    async onSubmit(d) {
      const body = { ...(r || {}), name: d.name, type: catTab, limit: parseMoney(d.limit) };
      r ? await api('PUT', '/api/categories/' + r.id, body) : await api('POST', '/api/categories', body);
      toast('Kategori disimpan'); load();
    }
  });
  const add = root.querySelector('[data-add]'); if (add) add.onclick = () => edit(null);
  async function load() {
    const rows = (await api('GET', '/api/categories')).filter(c => c.type === catTab);
    table(root.querySelector('#list'), {
      rows, empty: 'Belum ada kategori di tab ini.', rowClass: r => r.active ? '' : 'inactive',
      columns: [
        { label: 'No', cls: 'no', render: (r, i) => i + 1 },
        { label: 'Jenis ' + TX_LABEL[catTab].toLowerCase(), card: 'title', render: r => h(r.name) },
        ...(catTab === 'pengeluaran' ? [{ label: 'Batas bulanan', cls: 'num', card: 'amount', render: r => r.limit ? rp(r.limit) : '<span class="hint">Tanpa batas</span>' }] : []),
        { label: 'Status', render: statusTag },
        ...(readOnly() ? [] : [{ label: 'Aksi', cls: 'acts', render: actsHtml }])
      ]
    });
    wireActs(root, rows, { endpoint: '/api/categories', label: 'Kategori', edit, reload: load });
  }
  load();
}

export async function kelolaTabungan(root) {
  root.innerHTML = `<div class="page-head"><p class="hint">Pos tabungan dan target yang ingin dicapai.</p>${addBtn()}</div><div id="list"></div>`;
  const edit = r => openForm({
    title: r ? 'Ubah tabungan' : 'Tambah tabungan',
    body: `<label>Jenis tabungan<input name="name" required maxlength="60" value="${h(r ? r.name : '')}" placeholder="Contoh: Tabungan pribadi, Emas"></label>
      <label>Tempat<input name="place" maxlength="60" value="${h(r ? r.place : '')}" placeholder="Contoh: Jago, Pegadaian"></label>
      <div class="grid-2"><label>Saldo awal<input name="initialBalance" data-money value="${r ? moneyVal(r.initialBalance) : ''}" placeholder="0"></label>
      <label>Target<input name="target" data-money value="${r ? moneyVal(r.target) : ''}" placeholder="0 = tanpa target"></label></div>
      <label>Tanggal target<input type="date" name="targetDate" value="${r ? r.targetDate : ''}"><span class="hint">Dipakai untuk menghitung rekomendasi setoran per bulan.</span></label>`,
    async onSubmit(d) {
      const body = { ...(r || {}), name: d.name, place: d.place, initialBalance: parseMoney(d.initialBalance), target: parseMoney(d.target), targetDate: d.targetDate };
      r ? await api('PUT', '/api/savings/' + r.id, body) : await api('POST', '/api/savings', body);
      toast('Tabungan disimpan'); load();
    }
  });
  const add = root.querySelector('[data-add]'); if (add) add.onclick = () => edit(null);
  async function load() {
    const rows = await api('GET', '/api/savings');
    table(root.querySelector('#list'), {
      rows, empty: 'Belum ada tabungan.', rowClass: r => r.active ? '' : 'inactive',
      columns: [
        { label: 'No', cls: 'no', render: (r, i) => i + 1 },
        { label: 'Jenis tabungan', card: 'title', render: r => h(r.name) },
        { label: 'Saldo awal', cls: 'num', card: 'amount', render: r => rp(r.initialBalance) },
        { label: 'Tempat', render: r => h(r.place) },
        { label: 'Target', cls: 'num', render: r => r.target ? rp(r.target) : '' },
        { label: 'Tanggal target', render: r => r.targetDate ? tgl(r.targetDate) : '' },
        { label: 'Status', render: statusTag },
        ...(readOnly() ? [] : [{ label: 'Aksi', cls: 'acts', render: actsHtml }])
      ]
    });
    wireActs(root, rows, { endpoint: '/api/savings', label: 'Tabungan', edit, reload: load });
  }
  load();
}

// =====================================================================
// PENGATURAN
// =====================================================================
export async function pengaturan(root) {
  const s = await api('GET', '/api/settings');
  root.innerHTML = `<div class="settings">
    <div class="panel"><h2>Batas pengeluaran</h2>
      <form id="limits">
        <label>Batas harian<input name="dailyLimit" data-money value="${moneyVal(s.dailyLimit)}" placeholder="0 = tidak dipakai"></label>
        <label>Batas mingguan<input name="weeklyLimit" data-money value="${moneyVal(s.weeklyLimit)}" placeholder="0 = tidak dipakai"></label>
        <label>Batas bulanan<input name="monthlyLimit" data-money value="${moneyVal(s.monthlyLimit)}" placeholder="0 = tidak dipakai"></label>
        <label>Beri peringatan saat mencapai (%)<input name="warnPercent" type="number" min="10" max="100" value="${s.warnPercent}"></label>
        <label class="check"><input type="checkbox" name="notify" ${s.notify ? 'checked' : ''}>Kirim notifikasi saat mendekati atau melewati batas</label>
        <span class="hint">Batas per kategori bisa diatur di Manajemen › Kategori › Pengeluaran.</span>
        <button class="btn btn-primary" type="submit">Simpan batas</button>
      </form></div>
    <div class="panel"><h2>Notifikasi di perangkat ini</h2><div class="stack" id="dev"></div></div>
    <div class="panel"><h2>Ganti password</h2>
      <form id="pw">
        <label>Password lama<input type="password" name="oldPassword" required autocomplete="current-password"></label>
        <label>Password baru<input type="password" name="newPassword" required minlength="6" autocomplete="new-password"></label>
        <button class="btn" type="submit">Ganti password</button>
      </form></div>
  </div>`;
  bindMoney(root);
  root.querySelector('#limits').onsubmit = async e => {
    e.preventDefault(); const f = new FormData(e.target);
    try {
      state.settings = await api('PUT', '/api/settings', { dailyLimit: parseMoney(f.get('dailyLimit')), weeklyLimit: parseMoney(f.get('weeklyLimit')),
        monthlyLimit: parseMoney(f.get('monthlyLimit')), warnPercent: Number(f.get('warnPercent')), notify: f.get('notify') === 'on' });
      toast('Batas pengeluaran disimpan');
      window.dispatchEvent(new Event('notif:poll'));
    } catch (err) { toast(err.message, 'error'); }
  };
  root.querySelector('#pw').onsubmit = async e => {
    e.preventDefault(); const f = new FormData(e.target);
    try { await api('PUT', '/api/me/password', Object.fromEntries(f)); toast('Password diganti'); e.target.reset(); } catch (err) { toast(err.message, 'error'); }
  };
  renderDevice(root.querySelector('#dev'));
}

async function renderDevice(box) {
  const st = await notify.status();
  const on = st.permission === 'granted';
  let text;
  if (!st.supported) text = 'Browser ini tidak mendukung notifikasi sistem.';
  else if (st.permission === 'denied') text = 'Notifikasi diblokir. Izinkan lewat pengaturan situs di browser, lalu muat ulang.';
  else if (on && st.push) text = 'Aktif. Peringatan tetap muncul walau aplikasi ditutup.';
  else if (on) text = st.pushCapable ? 'Aktif saat aplikasi terbuka.' : 'Aktif saat aplikasi terbuka. Untuk notifikasi saat aplikasi ditutup, buka lewat HTTPS.';
  else text = 'Belum aktif.';
  box.innerHTML = `<div class="status-line ${on ? 'on' : ''}"><i></i>${text}</div>
    <p class="hint">Di HP: buka lewat Chrome/Safari, lalu “Tambahkan ke layar utama” agar notifikasi tampil seperti aplikasi.</p>
    <div class="filters">
      ${!on || !st.push ? `<button class="btn btn-primary" id="enable" ${!st.supported || st.permission === 'denied' ? 'disabled' : ''}>Aktifkan notifikasi</button>` : ''}
      ${on ? '<button class="btn" id="test">Kirim tes</button>' : ''}
      ${st.push ? '<button class="btn btn-ghost" id="off">Matikan di perangkat ini</button>' : ''}
    </div>`;
  const q = s => box.querySelector(s);
  if (q('#enable')) q('#enable').onclick = async () => {
    try { const mode = await notify.enable(); toast(mode === 'push' ? 'Notifikasi diaktifkan' : 'Notifikasi aktif saat aplikasi terbuka'); } catch (e) { toast(e.message, 'error'); }
    renderDevice(box);
  };
  if (q('#test')) q('#test').onclick = async () => {
    if (st.push) {
      const r = await api('POST', '/api/push/test').catch(e => ({ error: e.message }));
      toast(r.sent ? 'Notifikasi tes dikirim' : 'Server tidak bisa menjangkau layanan push. Cek koneksi internet server.', r.sent ? '' : 'error');
    } else {
      localStorage.removeItem('pushOn');
      notify.showLocal('Notifikasi aktif', 'Peringatan batas pengeluaran akan muncul seperti ini.', 'test');
    }
  };
  if (q('#off')) q('#off').onclick = async () => { await notify.disable(); toast('Notifikasi push dimatikan di perangkat ini'); renderDevice(box); };
}

// =====================================================================
// PENGGUNA (admin)
// =====================================================================
export async function pengguna(root) {
  root.innerHTML = `<div class="page-head"><p class="hint">Kelola akun dan lihat laporan keuangan setiap pengguna.</p><div class="tools"><a class="btn" href="/api/admin/backup" download>Unduh cadangan data</a><button class="btn btn-primary add-btn" type="button" data-add>Tambah pengguna</button></div></div><div id="list"></div>`;
  const form = u => openForm({
    title: u ? 'Ubah pengguna' : 'Tambah pengguna',
    body: `${u ? `<p class="hint">Username: <b>${h(u.username)}</b></p>` : '<label>Username<input name="username" required autocapitalize="none" placeholder="huruf kecil, tanpa spasi"></label>'}
      <label>Nama<input name="name" value="${h(u ? u.name : '')}"></label>
      <label>Peran<select name="role"><option value="user">Pengguna</option><option value="admin" ${u && u.role === 'admin' ? 'selected' : ''}>Admin</option></select></label>
      <label>${u ? 'Password baru (kosongkan jika tidak diganti)' : 'Password'}<input name="password" type="password" ${u ? '' : 'required'} minlength="6" autocomplete="new-password"></label>`,
    async onSubmit(d) {
      if (u) await api('PUT', '/api/admin/users/' + u.id, { name: d.name, role: d.role, ...(d.password ? { password: d.password } : {}) });
      else await api('POST', '/api/admin/users', d);
      toast('Pengguna disimpan'); load();
    }
  });
  root.querySelector('[data-add]').onclick = () => form(null);
  async function load() {
    const rows = await api('GET', '/api/admin/users');
    table(root.querySelector('#list'), {
      rows, rowClass: r => r.active ? '' : 'inactive',
      columns: [
        { label: 'No', cls: 'no', render: (r, i) => i + 1 },
        { label: 'Nama', card: 'title', render: r => `${h(r.name)} <small class="hint">@${h(r.username)}</small>` },
        { label: 'Peran', card: 'amount', render: r => r.role === 'admin' ? '<span class="tag tag-admin">Admin</span>' : '<span class="tag tag-off">Pengguna</span>' },
        { label: 'Status', render: statusTag },
        { label: 'Transaksi', cls: 'num', render: r => r.txCount },
        { label: 'Pemasukan bulan ini', cls: 'num amt-masuk', render: r => rp(r.monthIncome) },
        { label: 'Pengeluaran bulan ini', cls: 'num amt-keluar', render: r => rp(r.monthExpense) },
        { label: 'Aksi', cls: 'acts', render: r => `<button class="btn btn-sm btn-primary" data-view="${r.id}">Lihat data</button><button class="btn btn-sm" data-edit="${r.id}">Edit</button>` +
          (r.id === state.user.id ? '' : `<button class="btn btn-sm" data-toggle="${r.id}">${r.active ? 'Nonaktifkan' : 'Aktifkan'}</button><button class="btn btn-sm btn-danger" data-del="${r.id}">Hapus</button>`) }
      ]
    });
    const find = id => rows.find(r => r.id === Number(id));
    root.querySelectorAll('[data-view]').forEach(b => b.onclick = () => {
      const u = find(b.dataset.view);
      if (u.id === state.user.id) { state.viewUid = null; } else { state.viewUid = u.id; state.viewName = u.name; }
      window.dispatchEvent(new Event('view:changed'));
      location.hash = '#/dashboard';
    });
    root.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => form(find(b.dataset.edit)));
    root.querySelectorAll('[data-toggle]').forEach(b => b.onclick = async () => {
      const u = find(b.dataset.toggle);
      try { await api('PUT', '/api/admin/users/' + u.id, { active: !u.active }); toast(u.active ? 'Pengguna dinonaktifkan' : 'Pengguna diaktifkan'); load(); } catch (e) { toast(e.message, 'error'); }
    });
    root.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
      const u = find(b.dataset.del);
      if (!await confirmDialog('Hapus pengguna?', `Akun ${u.name} beserta seluruh data keuangannya akan dihapus permanen.`)) return;
      try { await api('DELETE', '/api/admin/users/' + u.id); toast('Pengguna dihapus'); load(); } catch (e) { toast(e.message, 'error'); }
    });
  }
  load();
}
