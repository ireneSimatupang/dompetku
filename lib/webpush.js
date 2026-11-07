'use strict';
// Minimal Web Push (RFC 8030 / 8291 / 8292) using only Node's stdlib.
// Lets the server push alerts to the phone/desktop notification tray even when the tab is closed.
const crypto = require('crypto');
const https = require('https');
const { URL } = require('url');

const b64u = buf => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = str => Buffer.from(String(str).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

function generateVapidKeys() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()) };
}

function vapidPrivateKeyObject(vapid) {
  const pub = unb64u(vapid.publicKey);
  return crypto.createPrivateKey({
    format: 'jwk',
    key: { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)), d: vapid.privateKey }
  });
}

function vapidAuthHeader(endpoint, vapid, subject) {
  const aud = new URL(endpoint).origin;
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject }));
  const unsigned = `${header}.${claims}`;
  const sig = crypto.sign('sha256', Buffer.from(unsigned), { key: vapidPrivateKeyObject(vapid), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${unsigned}.${b64u(sig)}, k=${vapid.publicKey}`;
}

// RFC 8291 aes128gcm payload encryption
function encrypt(subscription, payload) {
  const uaPublic = unb64u(subscription.keys.p256dh);
  const authSecret = unb64u(subscription.keys.auth);
  const ecdh = crypto.createECDH('prime256v1');
  const asPublic = ecdh.generateKeys();
  const sharedSecret = ecdh.computeSecret(uaPublic);
  const salt = crypto.randomBytes(16);

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', sharedSecret, authSecret, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));

  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const plaintext = Buffer.concat([Buffer.from(payload), Buffer.from([2])]); // 0x02 = last record delimiter
  const body = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);

  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  const header = Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic]);
  return Buffer.concat([header, body]);
}

// Resolves { statusCode }. 404/410 mean the subscription is gone and should be deleted.
function sendNotification(subscription, payloadObj, vapid, subject) {
  return new Promise((resolve) => {
    let body;
    try { body = encrypt(subscription, JSON.stringify(payloadObj)); }
    catch (e) { return resolve({ statusCode: 0, error: e.message }); }
    const url = new URL(subscription.endpoint);
    const req = https.request({
      method: 'POST',
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      timeout: 10000,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Encoding': 'aes128gcm',
        'Content-Length': body.length,
        'TTL': '86400',
        'Urgency': 'high',
        'Authorization': vapidAuthHeader(subscription.endpoint, vapid, subject)
      }
    }, res => { res.resume(); res.on('end', () => resolve({ statusCode: res.statusCode })); });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', e => resolve({ statusCode: 0, error: e.message }));
    req.end(body);
  });
}

module.exports = { generateVapidKeys, sendNotification };
