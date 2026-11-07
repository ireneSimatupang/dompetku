# Dompet Harian — daily finance dashboard

Node.js **stdlib only** (no npm install) + plain HTML/CSS/JS. UI is in Bahasa Indonesia.

## Run

```bash
node server.js                      # Node 22.13+ (node:sqlite built in; 22.5–22.12 need --experimental-sqlite)
# optional env:
PORT=3000 HOST=0.0.0.0 TZ=Asia/Jakarta ADMIN_PASSWORD=rahasia123 node server.js
```

On first start an `admin` account is created and its password is printed to the console
(or taken from `ADMIN_PASSWORD`). Change it in **Pengaturan**.

| Env | Default | Meaning |
|---|---|---|
| `PORT` / `HOST` | 3000 / 0.0.0.0 | Listen address |
| `TZ` | Asia/Jakarta | Used for "hari ini", week and month boundaries |
| `DB_FILE` | `data/dompet.db` | SQLite database (node:sqlite, WAL mode) |
| `JSON_FILE` | `data/db.json` | Old JSON store, imported once on first start, then renamed to `db.json.migrated` |
| `COOKIE_SECURE` | off | Set `1` when served over HTTPS |
| `VAPID_SUBJECT` | mailto:admin@example.com | Contact sent to push services (use a real address) |

## Structure

```
server.js            HTTP server, auth, REST API, admin, static files
lib/db.js            SQLite schema, indexes, migrations, one-time JSON import
lib/users.js         password hashing, user creation with default categories
lib/finance.js       balances, reports, insights, threshold alerts
lib/webpush.js       Web Push (VAPID + aes128gcm) with node:crypto
public/index.html    app shell
public/css/app.css   styles (tables turn into cards under 860px, dark mode)
public/js/*.js       core, pages, charts (SVG, no library), notify
public/sw.js         service worker that shows pushed alerts
```

## Features → pages

- **Dashboard**: preset ranges (Hari ini, Kemarin, 7 hari, 30 hari, Bulan ini, Pilih tanggal); insight selector
  Transaksi / Rekening / Tabungan; trend chart (hourly for one day, daily up to 3 months, monthly beyond),
  comparison with the previous period, generated notes, budget rails.
- **Transaksi**: CRUD; types Pemasukan, Pengeluaran, Transfer (with Rek. tujuan), Tabungan (setor/tarik).
- **Rekening**: per-account Awal / Saldo masuk / Saldo keluar / Total for any period.
- **Tabungan**: Target, Masuk, Keluar, Tanggal target, Rekomendasi per bulan, Persentase.
- **Manajemen**: Rekening, Kategori (tabs Pemasukan/Pengeluaran/Transfer, optional monthly limit per
  expense category), Tabungan; edit, aktif/nonaktif, hapus (blocked when already used).
- **Pengaturan**: daily/weekly/monthly limits, warning %, device notifications, change password.
- **Pengguna** (admin): create/edit/reset password/deactivate/delete users, and **Lihat data**
  to open any user's dashboard and reports in read-only mode.

## Notifications

When an expense pushes spending past the warning % or the limit, the server stores an alert (once per
period and level) and sends it:

1. **Web Push** → appears in the Android/Windows/macOS notification tray even if the app is closed.
   Needs HTTPS (or `localhost`) and the server must reach the browser's push service
   (fcm.googleapis.com, updates.push.services.mozilla.com, web.push.apple.com…).
   On iPhone, add the app to the home screen first (iOS 16.4+).
2. **Fallback** when push isn't available (plain HTTP on a LAN, or an offline server): the page polls
   every minute and raises a system notification while the app is open.

The bell in the top bar always lists the alerts.

## Pasang di HP (install as app)

Browsers only allow installing a web app from **HTTPS** (or `localhost` on the same device).
Opened as `http://192.168.x.x:3000` from a phone, the install option will not appear and push
notifications won't work. Pick one:

1. **Built-in HTTPS** — give the server a certificate:
   ```bash
   TLS_CERT=cert.pem TLS_KEY=key.pem PORT=443 node server.js
   ```
   The certificate must be trusted by the phone: a real domain certificate (e.g. Let's Encrypt), or your
   own CA installed on the phone. A plain self-signed certificate opens with a warning and Chrome still
   refuses to install.
2. **Reverse proxy** (nginx/Caddy/IIS) with HTTPS in front of `http://localhost:3000`; set `COOKIE_SECURE=1`.
3. **Tunnel** for quick access from anywhere: `cloudflared tunnel --url http://localhost:3000`
   gives a trusted `https://….trycloudflare.com` address.
4. **Testing only on Android Chrome**: open `chrome://flags/#unsafely-treat-insecure-origin-as-secure`,
   add `http://192.168.x.x:3000`, enable, restart Chrome.

Then:
- **Android (Chrome/Edge)**: tap **Pasang aplikasi** in the menu, or ⋮ › *Instal aplikasi*.
- **iPhone/iPad**: Safari only › Share › *Tambahkan ke Layar Utama* (iOS 16.4+ for notifications).

## Storage

Data lives in `data/dompet.db` (SQLite via the built-in `node:sqlite`, no npm packages).

- Amounts are stored as whole rupiah (INTEGER), so totals are exact.
- Reports and insights are SQL aggregations on indexed `(user_id, date)`. Tested with 200,000 transactions:
  the 30-day dashboard answers in a few milliseconds; a multi-year account report takes ~0.3–0.5 s,
  because opening balances need the full history.
- Upgrading from the JSON version: just start the new server. If `data/db.json` exists and the database
  is empty, everything (users, passwords, ids, transactions, settings, push keys) is imported in one
  transaction and the old file is renamed to `db.json.migrated`.
- `seed-iren.js` can run while the server is running (WAL mode).

### Backup

- In the app: **Pengguna › Unduh cadangan data** (admin) downloads a consistent snapshot.
- From the shell, while the server runs: `sqlite3 data/dompet.db ".backup backup.db"`
- Don't copy `dompet.db` alone while the server runs; the `-wal` file holds the latest writes.
