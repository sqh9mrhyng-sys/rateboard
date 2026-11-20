// Graphics marketplace (2026-11-19, Dennis: "/graphics - Creator, Browse, Contests").
//
// Creators list their graphic styles, each with a price range and example images; Browse shows every creator
// with their best 3-6 styles. Contests comes later.
//
//   GET  /api/gfx?op=list            creators with their styles (signed-in members)
//   GET  /api/gfx?op=mine            your creator profile
//   POST /api/gfx?op=save            save your profile + styles   {profile:{link,bio,open,hidden,unit}, styles:[...]}
//   POST /api/gfx?op=upload          one image, already shrunk to WebP by the page   {data:'<base64>'}
//   POST /api/gfx?op=delimg          {id} delete one of your images
//   GET  /api/gfx?img=<id>           an image (public, cached for good - ids never change)
//
// Images live on the server's disk (DATA_DIR/gfx), never in the database. Limits: 900 KB an image,
// 80 images a creator, 12 styles, 6 images a style.
import { sessionKey, allow } from '../../lib/auth.js';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DIR = path.join(process.env.DATA_DIR || '/opt/rax/data', 'gfx');
const MAX_BYTES = 900 * 1024, MAX_IMGS = 80, MAX_STYLES = 12, MAX_STYLE_IMGS = 6;
const DDL = [
  'CREATE TABLE IF NOT EXISTS gfx_creators (key TEXT PRIMARY KEY, link TEXT, bio TEXT, open INTEGER DEFAULT 1, hidden INTEGER DEFAULT 0, unit TEXT, styles TEXT, updatedAt INTEGER, createdAt INTEGER)',
  'CREATE TABLE IF NOT EXISTS gfx_imgs (id TEXT PRIMARY KEY, key TEXT, bytes INTEGER, type TEXT, at INTEGER)'
];
let ready = false;
async function prep(db) { if (ready) return; for (const d of DDL) await db.prepare(d).run(); ready = true; }
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const str = (v, n) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
const num = v => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= 0 && n <= 10000000 ? n : null; };
const sniff = b => b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' ? 'image/webp'
  : b[0] === 0xff && b[1] === 0xd8 ? 'image/jpeg' : b[0] === 0x89 && b.toString('ascii', 1, 4) === 'PNG' ? 'image/png' : null;
// Profile links: realapp.com/u/<Real username>. A pasted link (kept for later) must be on Real's own domains.
const realLink = v => { const s = str(v, 200); return /^https:\/\/(www\.)?(realapp\.com|realsports\.io)\/[A-Za-z0-9/_\-@.?=&]+$/.test(s) ? s : ''; };

function cleanStyles(list, mine) {
  const out = [];
  for (const s of (Array.isArray(list) ? list : []).slice(0, MAX_STYLES)) {
    const name = str(s && s.name, 40); if (!name) continue;
    let lo = num(s.min), hi = num(s.max); if (lo != null && hi != null && hi < lo) [lo, hi] = [hi, lo];
    const imgs = (Array.isArray(s.imgs) ? s.imgs : []).map(x => str(x, 40)).filter(x => mine.has(x)).slice(0, MAX_STYLE_IMGS);
    out.push({ id: str(s.id, 20) || crypto.randomBytes(5).toString('hex'), name, desc: str(s.desc, 220), min: lo, max: hi, turn: str(s.turn, 30), imgs, feat: !!s.feat });
  }
  return out;
}

export async function onRequest(ctx) {
  const { request, env } = ctx, url = new URL(request.url), db = env.RATEBOARD_DB;
  // Images: public by id (they're portfolio pieces), cached for good.
  const img = url.searchParams.get('img');
  if (img) {
    if (!/^[a-f0-9]{24}$/.test(img)) return new Response('Not found', { status: 404 });
    try { const b = fs.readFileSync(path.join(DIR, img)); return new Response(b, { headers: { 'content-type': sniff(b) || 'application/octet-stream', 'cache-control': 'public, max-age=31536000, immutable' } }); }
    catch (e) { return new Response('Not found', { status: 404 }); }
  }
  await prep(db);
  const me = await sessionKey(env, request); if (!me) return json({ error: 'Sign in first.' }, 401);
  const op = url.searchParams.get('op') || 'list';

  if (op === 'list') {
    const rows = ((await db.prepare('SELECT key, link, bio, open, unit, styles, updatedAt FROM gfx_creators WHERE COALESCE(hidden,0)=0').all()).results) || [];
    // Their Real username (from Swaps sign-up) for the profile link; the board name if they never signed up.
    const rs = {}; try { for (const u of ((await db.prepare('SELECT key, rsUser FROM swap_users WHERE rsUser IS NOT NULL').all()).results || [])) rs[String(u.key).toLowerCase()] = u.rsUser; } catch (e) {}
    const creators = rows.map(r => { let st = []; try { st = JSON.parse(r.styles || '[]') || []; } catch (e) {}
      // Best 3-6: the ones they starred first, then the ones with the most examples.
      st = st.filter(s => s.imgs && s.imgs.length).sort((a, b) => (b.feat - a.feat) || (b.imgs.length - a.imgs.length)).slice(0, 6);
      const name = rs[String(r.key).toLowerCase()] || r.key;
      return { user: name, link: 'https://www.realapp.com/u/' + encodeURIComponent(name), bio: r.bio || '', open: !!r.open, unit: r.unit || 'rax', styles: st, updatedAt: r.updatedAt }; })
      .filter(c => c.styles.length).sort((a, b) => (b.open - a.open) || (b.updatedAt - a.updatedAt));
    return json({ creators, me });
  }
  if (op === 'mine') {
    const r = await db.prepare('SELECT link, bio, open, hidden, unit, styles FROM gfx_creators WHERE key=?').bind(me).first();
    const imgs = ((await db.prepare('SELECT id FROM gfx_imgs WHERE key=? ORDER BY at').bind(me).all()).results || []).map(x => x.id);
    let styles = []; try { styles = JSON.parse((r && r.styles) || '[]') || []; } catch (e) {}
    return json({ me, profile: r ? { link: r.link || '', bio: r.bio || '', open: !!r.open, hidden: !!r.hidden, unit: r.unit || 'rax' } : null, styles, imgs });
  }
  if (request.method !== 'POST') return json({ error: 'POST only.' }, 405);
  let b = {}; try { b = await request.json(); } catch (e) { return json({ error: 'Bad request.' }, 400); }

  if (op === 'upload') {
    if (!(await allow(url.origin, 'gfxup:' + me, 40, 3600))) return json({ error: 'Too many uploads this hour - try again later.' }, 429);
    const n = await db.prepare('SELECT COUNT(*) AS n FROM gfx_imgs WHERE key=?').bind(me).first();
    if (Number(n && n.n) >= MAX_IMGS) return json({ error: `You can keep up to ${MAX_IMGS} images - delete some first.` }, 400);
    let buf; try { buf = Buffer.from(String(b.data || '').replace(/^data:[^,]+,/, ''), 'base64'); } catch (e) { return json({ error: 'Bad image.' }, 400); }
    const type = sniff(buf); if (!type) return json({ error: 'Images must be JPG, PNG or WebP.' }, 400);
    if (buf.length > MAX_BYTES) return json({ error: 'That image is too big even after shrinking - try a smaller one.' }, 400);
    const id = crypto.randomBytes(12).toString('hex');
    fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(path.join(DIR, id), buf);
    await db.prepare('INSERT INTO gfx_imgs (id, key, bytes, type, at) VALUES (?, ?, ?, ?, ?)').bind(id, me, buf.length, type, Date.now()).run();
    return json({ ok: true, id });
  }
  if (op === 'delimg') {
    const id = str(b.id, 40); const r = await db.prepare('SELECT id FROM gfx_imgs WHERE id=? AND key=?').bind(id, me).first();
    if (!r) return json({ error: 'Not your image.' }, 404);
    await db.prepare('DELETE FROM gfx_imgs WHERE id=?').bind(id).run(); try { fs.unlinkSync(path.join(DIR, id)); } catch (e) {}
    return json({ ok: true });
  }
  if (op === 'save') {
    if (!(await allow(url.origin, 'gfxsave:' + me, 60, 600))) return json({ error: 'Too many saves - wait a minute.' }, 429);
    const mine = new Set(((await db.prepare('SELECT id FROM gfx_imgs WHERE key=?').bind(me).all()).results || []).map(x => x.id));
    const p = b.profile || {}, styles = cleanStyles(b.styles, mine), now = Date.now();
    await db.prepare(`INSERT INTO gfx_creators (key, link, bio, open, hidden, unit, styles, updatedAt, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET link=excluded.link, bio=excluded.bio, open=excluded.open, hidden=excluded.hidden, unit=excluded.unit, styles=excluded.styles, updatedAt=excluded.updatedAt`)
      .bind(me, realLink(p.link), str(p.bio, 280), p.open === false ? 0 : 1, p.hidden ? 1 : 0, p.unit === 'usd' ? 'usd' : 'rax', JSON.stringify(styles), now, now).run();
    // Images uploaded over an hour ago that no style uses any more are deleted, so they don't count against the limit.
    const used = new Set(styles.flatMap(s => s.imgs));
    const old = ((await db.prepare('SELECT id FROM gfx_imgs WHERE key=? AND at<?').bind(me, now - 3600e3).all()).results || []).filter(x => !used.has(x.id));
    for (const x of old) { await db.prepare('DELETE FROM gfx_imgs WHERE id=?').bind(x.id).run(); try { fs.unlinkSync(path.join(DIR, x.id)); } catch (e) {} }
    return json({ ok: true, styles, linkOk: !p.link || !!realLink(p.link) });
  }
  return json({ error: 'Unknown op.' }, 400);
}
