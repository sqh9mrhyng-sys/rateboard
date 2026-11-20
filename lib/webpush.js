/* Web Push (Dennis, 2026-11-16): notifications to phones and browsers that allowed them, with no outside
   service. Each message is encrypted for that browser (RFC 8291, aes128gcm) and signed with the site's own
   VAPID key (RFC 8292). The key pair is made once on the server and kept in KV - nothing to paste anywhere.
   Every send is best-effort: a failure never stops the caller, and a subscription the browser has dropped
   (404/410) is removed. */
import crypto from 'node:crypto';

const VAPID_KV = 'push_vapid_v1';
export const PUSH_DDL = 'CREATE TABLE IF NOT EXISTS push_subs (endpoint TEXT PRIMARY KEY, key TEXT, p256dh TEXT, auth TEXT, at INTEGER, ua TEXT, fails INTEGER DEFAULT 0)';

const b64u = buf => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = s => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

// Read from KV each time (cheap) so every server process signs with the same key, even if two made one at once.
const VAPID_MEMO = new Map();
export async function vapidKeys(env) {
  let v = null; try { v = JSON.parse((await env.RATEBOARD_KV.get(VAPID_KV)) || 'null'); } catch (e) {}
  if (!v || !v.jwk || !v.pub) {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const pj = publicKey.export({ format: 'jwk' });
    await env.RATEBOARD_KV.put(VAPID_KV, JSON.stringify({ jwk: privateKey.export({ format: 'jwk' }), pub: b64u(Buffer.concat([Buffer.from([4]), unb64u(pj.x), unb64u(pj.y)])), at: Date.now() }));
    v = JSON.parse(await env.RATEBOARD_KV.get(VAPID_KV));   // whoever wrote last wins, for everyone
  }
  if (!VAPID_MEMO.has(v.pub)) VAPID_MEMO.set(v.pub, { pub: v.pub, key: crypto.createPrivateKey({ key: v.jwk, format: 'jwk' }) });
  return VAPID_MEMO.get(v.pub);
}

function vapidAuth(endpoint, vk) {
  const aud = new URL(endpoint).origin;
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const body = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: 'mailto:admin@raxacademy.app' }));
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${body}`), { key: vk.key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${vk.pub}`;
}

// RFC 8291: one record, aes128gcm.
export function encryptPayload(p256dh, authSecret, payload) {
  const uaPub = unb64u(p256dh), auth = unb64u(authSecret);
  const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
  const asPub = ecdh.getPublicKey(), shared = ecdh.computeSecret(uaPub);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPub, asPub]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, auth, keyInfo, 32));
  const salt = crypto.randomBytes(16);
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const c = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ct = Buffer.concat([c.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPub.length]), asPub, ct]);
}

async function sendOne(env, sub, msg) {
  const vk = await vapidKeys(env);
  const body = encryptPayload(sub.p256dh, sub.auth, JSON.stringify(msg));
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch(sub.endpoint, { method: 'POST', signal: ctl.signal, body,
      headers: { Authorization: vapidAuth(sub.endpoint, vk), TTL: String(msg.ttl || 3600), 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', Urgency: msg.urgent ? 'high' : 'normal' } });
    return r.status;
  } catch (e) { return 0; } finally { clearTimeout(t); }
}

/* Send to every browser a member turned on. msg: { title, body, url, tag }. Returns how many went out. */
export async function pushTo(env, db, key, msg) {
  try {
    if (!key || !db) return 0;
    /* No repeats (2026-11-19: members got the same notification every minute while a DM kept failing and was
       retried). The same message to the same member is sent once per 15 minutes, whatever calls it. Test
       buttons (tags ending in "test") are exempt. Counts per hour by tag go to KV for the health page. */
    const tag = String(msg.tag || 'none'), kv = env && env.RATEBOARD_KV;
    let h = 0; for (const c of String(key).toLowerCase() + '|' + tag + '|' + (msg.title || '') + '|' + (msg.body || '')) h = (h * 31 + c.charCodeAt(0)) | 0;
    const DK = 'pushdup_' + (h >>> 0).toString(36), hr = new Date().toISOString().slice(0, 13), tg = tag.replace(/-\d.*$/, '');
    const bump = async f => { try { if (!kv) return; const st = JSON.parse((await kv.get('push_stats')) || '{}') || {}; const o = (st[hr] = st[hr] || {}); o[tg + (f ? ':' + f : '')] = (o[tg + (f ? ':' + f : '')] || 0) + 1;
      for (const k of Object.keys(st).sort().slice(0, -12)) delete st[k]; await kv.put('push_stats', JSON.stringify(st)); } catch (e) {} };
    if (kv && !/test$/.test(tag)) { try { if (await kv.get(DK)) { await bump('dup'); return 1; } } catch (e) {} }
    /* Tap tracking (2026-11-20: on iPhone, tapping a notification with the app in the background still left
       Dennis on the page he was on). Each notification carries an id; tapping it tells the server (from the
       notification helper), and the page asks the server when it comes back on screen. */
    if (kv && msg.url && String(msg.url).startsWith('/')) { const nid = Array.from({ length: 12 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
      try { await kv.put('navpend_' + nid, JSON.stringify({ who: String(key).toLowerCase(), url: msg.url, at: Date.now() }), { expirationTtl: 1800 }); msg = { ...msg, nid }; } catch (e) {} }
    await db.prepare(PUSH_DDL).run();
    const subs = ((await db.prepare('SELECT endpoint, p256dh, auth FROM push_subs WHERE key=?').bind(String(key).toLowerCase()).all()).results) || [];
    let ok = 0;
    for (const s of subs.slice(0, 6)) {
      const st = await sendOne(env, s, msg);
      if (st >= 200 && st < 300) ok++;
      else if (st === 404 || st === 410) await db.prepare('DELETE FROM push_subs WHERE endpoint=?').bind(s.endpoint).run();
      else await db.prepare('UPDATE push_subs SET fails=COALESCE(fails,0)+1 WHERE endpoint=?').bind(s.endpoint).run();
    }
    if (kv && subs.length) { try { await kv.put(DK, '1', { expirationTtl: 15 * 60 }); } catch (e) {} await bump(''); }
    return ok;
  } catch (e) { return 0; }
}
