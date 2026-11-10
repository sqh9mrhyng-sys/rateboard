// Sponsor spot and site traffic (2026-11-08).
//
// One sponsor at a time, set by Dennis on the admin page: a banner (text,
// optional image, link) shown at the top of the pages he picks, marked
// "Sponsored". Off until he turns it on. Views and clicks are counted per day
// so a sponsor can be shown real numbers; page views come from the middleware
// (functions/_middleware.js), which counts every page opened.
//
//   GET  /api/sponsor?p=<page>          the live banner for that page (public), counts a view
//   GET  /api/sponsor?click=1&p=<page>  counts a click, then sends them to the sponsor's link
//   GET  /api/sponsor?admin=1           settings + 30 days of page views and sponsor numbers (admin)
//   POST /api/sponsor                   save settings (admin)
import { isAdminRequest, etDay } from '../../lib/auth.js';

const KEY = 'sponsor_v1';
export const SP_PAGES = ['board', 'market', 'swaps', 'hour', 'otd', 'boosts', 'projections', 'tags', 'home', 'packs'];
const DDL = [
  'CREATE TABLE IF NOT EXISTS page_views (day TEXT, page TEXT, n INTEGER, PRIMARY KEY (day, page))',
  'CREATE TABLE IF NOT EXISTS sponsor_stats (day TEXT, sponsor TEXT, page TEXT, kind TEXT, n INTEGER, PRIMARY KEY (day, sponsor, page, kind))'
];
let ready = false;
async function prep(db) { if (ready) return; for (const d of DDL) { try { await db.prepare(d).run(); } catch (e) {} } ready = true; }

const json = (o, s = 200, h = {}) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...h } });

// Page views: one row per page per Eastern day.
export async function countPageView(env, page) {
  const db = env && env.RATEBOARD_DB; if (!db || !page) return;
  try { await prep(db); await db.prepare('INSERT INTO page_views (day, page, n) VALUES (?, ?, 1) ON CONFLICT(day, page) DO UPDATE SET n = n + 1').bind(etDay(), page).run(); } catch (e) {}
}
async function bump(db, sponsor, page, kind) {
  try { await prep(db); await db.prepare('INSERT INTO sponsor_stats (day, sponsor, page, kind, n) VALUES (?, ?, ?, ?, 1) ON CONFLICT(day, sponsor, page, kind) DO UPDATE SET n = n + 1').bind(etDay(), sponsor, page, kind).run(); } catch (e) {}
}
async function settings(env) { try { return JSON.parse((await env.RATEBOARD_KV.get(KEY)) || 'null') || {}; } catch (e) { return {}; } }
function live(s, page) {
  if (!s || !s.on || !s.name || !s.url) return false;
  if (s.until && etDay() > s.until) return false;
  if (s.from && etDay() < s.from) return false;
  return !page || !(s.pages && s.pages.length) || s.pages.includes(page);
}
const cleanUrl = u => { try { const x = new URL(String(u || '')); return x.protocol === 'https:' ? x.toString() : ''; } catch (e) { return ''; } };

export async function onRequest({ request, env, waitUntil }) {
  const url = new URL(request.url), db = env.RATEBOARD_DB;
  const page = SP_PAGES.includes(url.searchParams.get('p')) ? url.searchParams.get('p') : 'other';
  if (request.method === 'POST') {
    if (!(await isAdminRequest(env, request))) return json({ error: 'Admin only.' }, 403);
    let b = {}; try { b = await request.json(); } catch (e) {}
    const s = {
      on: !!b.on, name: String(b.name || '').trim().slice(0, 60), text: String(b.text || '').trim().slice(0, 160),
      cta: String(b.cta || '').trim().slice(0, 30), url: cleanUrl(b.url), img: cleanUrl(b.img),
      pages: (Array.isArray(b.pages) ? b.pages : []).filter(p => SP_PAGES.includes(p)),
      from: /^\d{4}-\d{2}-\d{2}$/.test(String(b.from || '')) ? b.from : '', until: /^\d{4}-\d{2}-\d{2}$/.test(String(b.until || '')) ? b.until : '',
      at: Date.now()
    };
    if (s.on && (!s.name || !s.url)) return json({ error: 'A sponsor needs a name and an https link.' }, 400);
    await env.RATEBOARD_KV.put(KEY, JSON.stringify(s));
    return json({ ok: true, settings: s });
  }
  if (url.searchParams.get('admin') != null) {
    if (!(await isAdminRequest(env, request))) return json({ error: 'Admin only.' }, 403);
    await prep(db);
    const since = etDay(Date.now() - 29 * 86400000);
    const pv = ((await db.prepare('SELECT day, page, n FROM page_views WHERE day >= ? ORDER BY day').bind(since).all()).results) || [];
    const sp = ((await db.prepare('SELECT day, sponsor, page, kind, n FROM sponsor_stats WHERE day >= ? ORDER BY day').bind(since).all()).results) || [];
    return json({ settings: await settings(env), pages: SP_PAGES, pageViews: pv, sponsor: sp, today: etDay() });
  }
  const s = await settings(env);
  if (url.searchParams.get('click') != null) {
    if (!live(s, null)) return Response.redirect(url.origin + '/', 302);
    waitUntil(bump(db, s.name, page, 'click'));
    return Response.redirect(s.url, 302);
  }
  if (!live(s, page)) return json({ on: false }, 200, { 'cache-control': 'public, max-age=60' });
  waitUntil(bump(db, s.name, page, 'view'));
  return json({ on: true, name: s.name, text: s.text, cta: s.cta || 'Learn more', img: s.img || null, href: `/api/sponsor?click=1&p=${page}` });
}
