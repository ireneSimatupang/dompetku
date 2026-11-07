import { escapeHtml } from './charts.js';
export const h = escapeHtml;

export const state = {
  user: null, settings: null, vapidKey: '', today: '',
  viewUid: null, viewName: '',
  master: { accounts: [], categories: [], savings: [] },
  periods: {}
};

export const readOnly = () => !!state.viewUid;

// ---------- API ----------
export async function api(method, path, body) {
  if (body === undefined && (method === 'POST' || method === 'PUT')) body = {}; // server expects JSON on writes
  let url = path;
  if (state.viewUid && method === 'GET' && !path.startsWith('/api/admin') && !path.startsWith('/api/notifications') && path !== '/api/me') {
    url += (url.includes('?') ? '&' : '?') + 'uid=' + state.viewUid;
  }
  const res = await fetch(url, {
    method, credentials: 'same-origin',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (res.status === 401 && path !== '/api/login') { window.dispatchEvent(new Event('auth:lost')); }
  if (!res.ok) throw new Error((data && data.error) || `Gagal (${res.status})`);
  return data;
}

export async function loadMaster() {
  const [accounts, categories, savings] = await Promise.all([api('GET', '/api/accounts'), api('GET', '/api/categories'), api('GET', '/api/savings')]);
  state.master = { accounts, categories, savings };
  return state.master;
}

// ---------- format ----------
const nf = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 2 });
export const rp = n => (n < 0 ? '−Rp ' : 'Rp ') + nf.format(Math.abs(Math.round((Number(n) || 0) * 100) / 100));
const BULAN = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
const BLN = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
export const tgl = s => { if (!s) return '-'; const [y, m, d] = s.split('-'); return `${Number(d)} ${BLN[m - 1]} ${y}`; };
export const pad = n => String(n).padStart(2, '0');
export const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const addDays = (s, n) => { const [y, m, d] = s.split('-').map(Number); return ymd(new Date(y, m - 1, d + n)); };
export const todayStr = () => ymd(new Date());
export const nowTime = () => { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
export const rangeLabel = (f, t) => f === t ? tgl(f) : `${tgl(f)} – ${tgl(t)}`;
export const TX_LABEL = { pemasukan: 'Pemasukan', pengeluaran: 'Pengeluaran', transfer: 'Transfer', tabungan: 'Tabungan' };
export const ACC_LABEL = { bank: 'Bank', cash: 'Tunai', ewallet: 'E-Wallet', lainnya: 'Lainnya' };

// ---------- toast ----------
export function toast(msg, type = '') {
  const t = document.createElement('div');
  t.className = 'toast ' + type; t.textContent = msg;
  document.getElementById('toasts').append(t);
  setTimeout(() => t.remove(), type === 'error' ? 5000 : 3000);
}

// ---------- money input (thousand separators while typing) ----------
export function bindMoney(root) {
  root.querySelectorAll('input[data-money]').forEach(inp => {
    const fmt = () => {
      const neg = inp.dataset.money === 'neg' && inp.value.trim().startsWith('-');
      const digits = inp.value.replace(/[^\d]/g, '');
      inp.value = (neg ? '-' : '') + (digits ? Number(digits).toLocaleString('id-ID') : '');
    };
    inp.setAttribute('inputmode', 'numeric');
    inp.addEventListener('input', fmt); fmt();
  });
}
export const parseMoney = v => { const s = String(v || ''); const n = Number(s.replace(/[^\d]/g, '')) || 0; return s.trim().startsWith('-') ? -n : n; };
export const moneyVal = n => (Number(n) || 0) === 0 ? '' : Math.round(n).toLocaleString('id-ID');

// ---------- modal ----------
const modal = () => document.getElementById('modal');
/**
 * openForm({ title, body, submitLabel, onSubmit(data, form) , onOpen(form) })
 * onSubmit may throw to show the error inside the form.
 */
export function openForm({ title, body, submitLabel = 'Simpan', danger = false, onSubmit, onOpen }) {
  const dlg = modal(); const form = document.getElementById('modalForm');
  form.innerHTML = `<h2>${h(title)}</h2>${body}<p class="form-error" role="alert"></p>
    <div class="modal-actions"><button type="button" class="btn" data-close>Batal</button>
    <button type="submit" class="btn ${danger ? 'btn-danger' : 'btn-primary'}">${h(submitLabel)}</button></div>`;
  bindMoney(form);
  form.querySelector('[data-close]').onclick = () => dlg.close();
  form.onsubmit = async ev => {
    ev.preventDefault();
    const btn = form.querySelector('button[type=submit]'); btn.disabled = true;
    const err = form.querySelector('.form-error'); err.textContent = '';
    try {
      const data = Object.fromEntries(new FormData(form).entries());
      await onSubmit(data, form);
      dlg.close();
    } catch (e) { err.textContent = e.message; }
    finally { btn.disabled = false; }
  };
  if (onOpen) onOpen(form);
  dlg.showModal();
  const first = form.querySelector('input:not([type=hidden]):not([type=radio]), select');
  if (first && window.matchMedia('(min-width: 861px)').matches) first.focus();
}

export function confirmDialog(title, message, label = 'Hapus') {
  return new Promise(resolve => {
    let ok = false;
    openForm({ title, body: `<p>${h(message)}</p>`, submitLabel: label, danger: true, onSubmit: async () => { ok = true; } });
    modal().addEventListener('close', () => resolve(ok), { once: true });
  });
}

// ---------- period picker: Hari / Bulan / Tahun / Rentang ----------
export function periodPicker(container, key, onChange) {
  const t = todayStr();
  const p = state.periods[key] || (state.periods[key] = { mode: 'bulan', day: t, month: t.slice(0, 7), year: t.slice(0, 4), from: t.slice(0, 8) + '01', to: t });
  const render = () => {
    let inputs = '';
    if (p.mode === 'hari') inputs = `<input type="date" data-k="day" value="${p.day}" aria-label="Tanggal">`;
    if (p.mode === 'bulan') inputs = `<input type="month" data-k="month" value="${p.month}" aria-label="Bulan">`;
    if (p.mode === 'tahun') inputs = `<input type="number" data-k="year" value="${p.year}" min="2000" max="2100" aria-label="Tahun" style="width:90px">`;
    if (p.mode === 'rentang') inputs = `<input type="date" data-k="from" value="${p.from}" aria-label="Dari"><span class="sep">s/d</span><input type="date" data-k="to" value="${p.to}" aria-label="Sampai">`;
    container.innerHTML = `<div class="period"><select aria-label="Jenis periode">
      ${[['hari', 'Harian'], ['bulan', 'Bulanan'], ['tahun', 'Tahunan'], ['rentang', 'Rentang']].map(([v, l]) => `<option value="${v}" ${p.mode === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select>${inputs}</div>`;
    container.querySelector('select').onchange = e => { p.mode = e.target.value; render(); fire(); };
    container.querySelectorAll('input').forEach(i => i.onchange = () => { if (i.value) { p[i.dataset.k] = i.value; fire(); } });
  };
  const get = () => {
    if (p.mode === 'hari') return { from: p.day, to: p.day };
    if (p.mode === 'bulan') { const [y, m] = p.month.split('-').map(Number); return { from: `${p.month}-01`, to: ymd(new Date(y, m, 0)) }; }
    if (p.mode === 'tahun') return { from: `${p.year}-01-01`, to: `${p.year}-12-31` };
    return p.from <= p.to ? { from: p.from, to: p.to } : { from: p.to, to: p.from };
  };
  const fire = () => onChange(get());
  render();
  return get();
}

// ---------- responsive table ----------
/**
 * columns: [{ label, render(row, i) => html, cls, card: 'title'|'amount'|'sub', emptyIf(row) }]
 */
export function table(container, { columns, rows, empty = 'Belum ada data.', footer, rowClass }) {
  const head = columns.map(c => `<th class="${c.cls || ''}">${h(c.label)}</th>`).join('');
  const body = rows.length ? rows.map((r, i) => `<tr class="${rowClass ? rowClass(r) : ''}">${columns.map(c => {
    const html = c.render(r, i);
    const isEmpty = html === '' || html == null || (c.emptyIf && c.emptyIf(r));
    const cls = [c.cls, c.card ? 'card-' + c.card : '', isEmpty ? 'is-empty' : ''].filter(Boolean).join(' ');
    return `<td class="${cls}" data-label="${h(c.label)}">${html == null ? '' : html}</td>`;
  }).join('')}</tr>`).join('')
    : `<tr class="empty-row"><td colspan="${columns.length}">${h(empty)}</td></tr>`;
  const foot = footer && rows.length ? `<tfoot><tr>${footer.map(f => `<td class="${f.cls || ''}" data-label="${h(f.label || '')}" ${f.span ? `colspan="${f.span}"` : ''}>${f.html}</td>`).join('')}</tr></tfoot>` : '';
  container.innerHTML = `<div class="table-wrap"><table class="tbl"><thead><tr>${head}</tr></thead><tbody>${body}</tbody>${foot}</table></div>`;
}

export function seg(container, options, current, onPick) {
  container.innerHTML = `<div class="seg" role="group">${options.map(([v, l]) => `<button type="button" data-v="${v}" aria-pressed="${v === current}">${h(l)}</button>`).join('')}</div>`;
  container.querySelectorAll('button').forEach(b => b.onclick = () => {
    container.querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', x === b));
    onPick(b.dataset.v);
  });
}
