'use strict';
const crypto = require('crypto');

function hashPassword(pw, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(String(pw), salt, 64).toString('hex') };
}
function verifyPassword(pw, user) {
  const h = crypto.scryptSync(String(pw), user.salt, 64);
  const ref = Buffer.from(user.hash, 'hex');
  return ref.length === h.length && crypto.timingSafeEqual(h, ref);
}

const DEFAULT_CATEGORIES = {
  pemasukan: ['Gaji', 'Bonus', 'Usaha Sampingan'],
  pengeluaran: ['Makan & Minum', 'Transportasi', 'Belanja', 'Tagihan', 'Hiburan', 'Kesehatan'],
  transfer: ['Pindah Bank', 'Isi Saldo E-Wallet']
};

// Creates a user plus the starter categories and a "Cash" account. Call inside a transaction.
function createUser(db, { username, name, password, role = 'user' }) {
  const { salt, hash } = hashPassword(password);
  const { id } = db.prepare(`INSERT INTO users (username, name, role, active, salt, hash, created_at)
    VALUES (?, ?, ?, 1, ?, ?, ?) RETURNING id`).get(username, name || username, role === 'admin' ? 'admin' : 'user', salt, hash, new Date().toISOString());
  const cat = db.prepare('INSERT INTO categories (user_id, type, name, limit_amount, active) VALUES (?, ?, ?, 0, 1)');
  for (const [type, names] of Object.entries(DEFAULT_CATEGORIES)) for (const n of names) cat.run(id, type, n);
  db.prepare("INSERT INTO accounts (user_id, name, type, initial_balance, active) VALUES (?, 'Cash', 'cash', 0, 1)").run(id);
  return id;
}

module.exports = { hashPassword, verifyPassword, createUser };
