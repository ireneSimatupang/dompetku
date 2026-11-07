import { api, state } from './core.js';

let regPromise = null;
export function registerSW() {
  if (!('serviceWorker' in navigator)) return null;
  regPromise = navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => null);
  return regPromise;
}

const b64ToBytes = s => {
  const p = '='.repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + p).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, c => c.charCodeAt(0));
};

export async function status() {
  const supported = 'Notification' in window;
  const pushCapable = supported && window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window;
  let push = false;
  if (pushCapable && regPromise) {
    const reg = await regPromise;
    push = !!(reg && await reg.pushManager.getSubscription());
  }
  return { supported, pushCapable, permission: supported ? Notification.permission : 'unsupported', push, secure: window.isSecureContext };
}

export async function enable() {
  if (!('Notification' in window)) throw new Error('Browser ini tidak mendukung notifikasi.');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Izin notifikasi ditolak. Aktifkan lewat pengaturan situs di browser.');
  const st = await status();
  if (!st.pushCapable) return 'local';
  const reg = await regPromise;
  if (!reg) return 'local';
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(state.vapidKey) });
  await api('POST', '/api/push/subscribe', { subscription: sub.toJSON() });
  localStorage.setItem('pushOn', '1');
  return 'push';
}

export async function disable() {
  localStorage.removeItem('pushOn');
  if (!regPromise) return;
  const reg = await regPromise;
  const sub = reg && await reg.pushManager.getSubscription();
  if (sub) { await api('POST', '/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {}); await sub.unsubscribe(); }
}

// Shows a system notification from the page itself (used when push isn't subscribed on this device).
export async function showLocal(title, body, tag) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  if (localStorage.getItem('pushOn') === '1') return; // server push already delivers it
  const reg = regPromise && await regPromise;
  const opts = { body, tag: tag || 'dompet', icon: '/icon.svg', badge: '/icon.svg', data: { url: '/#/dashboard' } };
  if (reg && reg.showNotification) reg.showNotification(title, opts);
  else new Notification(title, opts);
}
