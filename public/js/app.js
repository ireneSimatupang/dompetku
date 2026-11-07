import { api, state, h, toast, rp } from './core.js';
import * as P from './pages.js';
import * as notify from './notify.js';

const $ = s => document.querySelector(s);

const ROUTES = {
  '/dashboard': { title: 'Dashboard', view: P.dashboard },
  '/transaksi': { title: 'Transaksi', view: P.transaksi },
  '/rekening': { title: 'Rekening', view: P.rekening },
  '/tabungan': { title: 'Tabungan', view: P.tabungan },
  '/kelola/rekening': { title: 'Manajemen rekening', view: P.kelolaRekening },
  '/kelola/kategori': { title: 'Manajemen kategori', view: P.kelolaKategori },
  '/kelola/tabungan': { title: 'Manajemen tabungan', view: P.kelolaTabungan },
  '/pengaturan': { title: 'Pengaturan', view: P.pengaturan, own: true },
  '/pengguna': { title: 'Pengguna', view: P.pengguna, admin: true, own: true }
};

function navHtml() {
  const link = (href, label, sub) => `<a href="#${href}" class="${sub ? 'sub' : ''}" data-route="${href}"><span class="dot"></span>${label}</a>`;
  return link('/dashboard', 'Dashboard') + link('/transaksi', 'Transaksi') + link('/rekening', 'Rekening') + link('/tabungan', 'Tabungan')
    + '<div class="nav-group">Manajemen</div>'
    + link('/kelola/rekening', 'Rekening', true) + link('/kelola/kategori', 'Kategori', true) + link('/kelola/tabungan', 'Tabungan', true)
    + '<div class="nav-group">Akun</div>'
    + link('/pengaturan', 'Pengaturan')
    + (state.user.role === 'admin' ? link('/pengguna', 'Pengguna') : '');
}

function closeMenu() { $('#sidebar').classList.remove('open'); $('#scrim').classList.remove('show'); }

async function route() {
  const path = location.hash.replace(/^#/, '') || '/dashboard';
  let r = ROUTES[path];
  if (!r || (r.admin && state.user.role !== 'admin')) { location.hash = '#/dashboard'; return; }
  if (r.own && state.viewUid) { state.viewUid = null; renderViewing(); }
  P.cleanup();
  closeMenu();
  $('#pageTitle').textContent = r.title;
  document.title = `${r.title} · Dompet Harian`;
  document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('active', a.dataset.route === path));
  $('#fab').classList.toggle('hide', !!(state.viewUid || r.own));
  const content = $('#content');
  content.innerHTML = '';
  try { await r.view(content); } catch (e) { content.innerHTML = `<div class="panel"><p class="empty-note">${h(e.message)}</p></div>`; }
  window.scrollTo(0, 0);
}

function renderViewing() {
  const bar = $('#viewingBar');
  if (!state.viewUid) { bar.hidden = true; $('#fab').classList.remove('hide'); return; }
  bar.hidden = false;
  bar.innerHTML = `<span>Anda melihat data <b>${h(state.viewName)}</b>. Mode lihat saja, data tidak bisa diubah.</span><button class="btn btn-sm" type="button" id="backMine">Kembali ke data saya</button>`;
  bar.querySelector('#backMine').onclick = () => { state.viewUid = null; renderViewing(); route(); };
}

// ---------- notifications ----------
let lastSeen = Number(localStorage.getItem('lastNotifId') || 0);
async function pollNotifications() {
  if (!state.user) return;
  try {
    const { items, unread } = await api('GET', '/api/notifications');
    const badge = $('#bellBadge');
    badge.hidden = !unread; badge.textContent = unread > 9 ? '9+' : unread;
    $('#notifList').innerHTML = items.length ? items.map(n => `<div class="notif ${n.level} ${n.read ? '' : 'unread'}"><b>${h(n.title)}</b>${h(n.body)}<br><small>${new Date(n.createdAt).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' })}</small></div>`).join('')
      : '<div class="notif" style="border:0"><small>Belum ada notifikasi. Atur batas pengeluaran di Pengaturan.</small></div>';
    const fresh = items.filter(n => n.id > lastSeen && !n.read);
    if (fresh.length) {
      // first load after login: only remember position, don't replay old alerts
      if (lastSeen > 0) fresh.reverse().forEach(n => notify.showLocal(n.title, n.body, n.key));
      lastSeen = Math.max(...items.map(n => n.id));
      localStorage.setItem('lastNotifId', lastSeen);
    } else if (!lastSeen && items.length) { lastSeen = Math.max(...items.map(n => n.id)); localStorage.setItem('lastNotifId', lastSeen); }
  } catch { /* offline */ }
}

function wireChrome() {
  $('#menuBtn').onclick = () => { $('#sidebar').classList.add('open'); $('#scrim').classList.add('show'); };
  $('#scrim').onclick = closeMenu;
  $('#fab').onclick = () => P.openTxForm();
  $('#logoutBtn').onclick = async () => {
    $('#logoutBtn').disabled = true;
    try { await api('POST', '/api/logout'); } catch (e) { toast('Gagal keluar: ' + e.message, 'error'); $('#logoutBtn').disabled = false; return; }
    localStorage.removeItem('lastNotifId');
    location.replace('/');
  };
  const panel = $('#notifPanel');
  $('#bellBtn').onclick = e => { e.stopPropagation(); panel.hidden = !panel.hidden; $('#bellBtn').setAttribute('aria-expanded', !panel.hidden); };
  document.addEventListener('click', e => { if (!panel.hidden && !panel.contains(e.target)) panel.hidden = true; });
  $('#readAllBtn').onclick = async () => { await api('POST', '/api/notifications/read-all'); pollNotifications(); };

  window.addEventListener('hashchange', route);
  window.addEventListener('route:refresh', route);
  window.addEventListener('view:changed', renderViewing);
  window.addEventListener('notif:poll', pollNotifications);
  window.addEventListener('alerts:new', e => {
    for (const n of e.detail) { toast(`${n.title}. ${n.body}`, n.level === 'bahaya' ? 'error' : ''); notify.showLocal(n.title, n.body, n.key); }
    lastSeen = Math.max(lastSeen, ...e.detail.map(n => n.id)); localStorage.setItem('lastNotifId', lastSeen);
    pollNotifications();
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) pollNotifications(); });
  setInterval(pollNotifications, 60000);
}

async function startApp(me) {
  state.user = me.user; state.settings = me.settings; state.vapidKey = me.vapidPublicKey; state.today = me.today;
  $('#login').hidden = true; $('#app').hidden = false;
  $('#nav').innerHTML = navHtml();
  $('#who').innerHTML = `<b>${h(me.user.name)}</b>@${h(me.user.username)}${me.user.role === 'admin' ? ' · admin' : ''}`;
  wireChrome();
  setupInstall();
  route();
  pollNotifications();
}

function showLogin() {
  $('#app').hidden = true; $('#login').hidden = false;
  const form = $('#loginForm');
  form.onsubmit = async e => {
    e.preventDefault();
    const err = $('#loginError'); err.textContent = '';
    const btn = form.querySelector('button'); btn.disabled = true;
    try {
      await api('POST', '/api/login', Object.fromEntries(new FormData(form)));
      localStorage.removeItem('lastNotifId'); lastSeen = 0;
      startApp(await api('GET', '/api/me'));
    } catch (ex) { err.textContent = ex.message; }
    finally { btn.disabled = false; }
  };
  form.querySelector('input').focus();
}

// ---------- install as app ----------
let installEvt = null;
const standalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; $('#installBtn').hidden = false; });
window.addEventListener('appinstalled', () => { installEvt = null; $('#installBtn').hidden = true; toast('Aplikasi terpasang di layar utama'); });
function setupInstall() {
  const btn = $('#installBtn');
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (standalone()) { btn.hidden = true; return; }
  if (ios || !window.isSecureContext) btn.hidden = false; // show instructions even without the browser prompt
  btn.onclick = async () => {
    if (installEvt) { installEvt.prompt(); const { outcome } = await installEvt.userChoice; if (outcome === 'accepted') btn.hidden = true; installEvt = null; return; }
    const msg = !window.isSecureContext
      ? 'Pemasangan butuh HTTPS. Buka aplikasi lewat alamat https:// (lihat README bagian "Pasang di HP").'
      : ios ? 'Di Safari: ketuk tombol Bagikan, lalu pilih “Tambahkan ke Layar Utama”.'
      : 'Buka menu browser (⋮), lalu pilih “Instal aplikasi” atau “Tambahkan ke layar utama”.';
    toast(msg);
  };
}

window.addEventListener('auth:lost', () => { if (state.user) location.reload(); });
notify.registerSW();
api('GET', '/api/me').then(startApp).catch(showLogin);
