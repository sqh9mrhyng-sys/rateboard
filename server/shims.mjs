/* Stand-ins for the Cloudflare pieces the site's functions use, so the same
   code runs on a plain Node server (2026-11-12, moving off Cloudflare):
   - D1 (env.RATEBOARD_DB)  -> a SQLite file (better-sqlite3), same calls
   - KV (env.RATEBOARD_KV)  -> a table in a second SQLite file
   - caches.default         -> an in-memory cache honouring max-age
   - HTMLRewriter           -> enough to add tags at the end of <head> */
import Database from 'better-sqlite3';

const norm = v => v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v;

class Stmt {
  constructor(db, sql, args = []) { this.db = db; this.sql = sql; this.args = args; }
  bind(...args) {
    const a = args.map(norm);
    // D1 takes ?1 ?2 ... as positions; better-sqlite3 wants those as {1: .., 2: ..}.
    if (/\?\d/.test(this.sql)) { const o = {}; a.forEach((v, i) => { o[i + 1] = v; }); return new Stmt(this.db, this.sql, [o]); }
    return new Stmt(this.db, this.sql, a);
  }
  _st() {
    let st = this.db._cache.get(this.sql);
    if (!st) { st = this.db.raw.prepare(this.sql); this.db._cache.set(this.sql, st); if (this.db._cache.size > 2000) this.db._cache.clear(); }
    return st;
  }
  _all() {
    const st = this._st();
    if (st.reader) return { results: st.all(...this.args), meta: { changes: 0 } };
    const r = st.run(...this.args);
    return { results: [], meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) } };
  }
  async first(col) {
    const st = this._st();
    if (!st.reader) { this._all(); return null; }
    const row = st.get(...this.args);
    if (row == null) return null;
    return col ? row[col] : row;
  }
  async all() { const r = this._all(); return { success: true, ...r }; }
  async run() { const r = this._all(); return { success: true, ...r }; }
  async raw() { const st = this._st(); return st.reader ? st.raw(true).all(...this.args) : (st.run(...this.args), []); }
}

export class D1 {
  constructor(file) {
    this.raw = new Database(file);
    this.raw.pragma('journal_mode = WAL');
    this.raw.pragma('synchronous = NORMAL');
    this.raw.pragma('busy_timeout = 5000');
    this._cache = new Map();
  }
  prepare(sql) { return new Stmt(this, sql); }
  async batch(stmts) {
    const out = [];
    this.raw.transaction(() => { for (const s of stmts) out.push({ success: true, ...s._all() }); })();
    return out;
  }
  async exec(sql) { this.raw.exec(sql); return { count: 1 }; }
}

export class KV {
  constructor(file) {
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.exec('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v BLOB, exp INTEGER)');
    this.g = this.db.prepare('SELECT v, exp FROM kv WHERE k=?');
    this.p = this.db.prepare('INSERT OR REPLACE INTO kv (k, v, exp) VALUES (?, ?, ?)');
    this.d = this.db.prepare('DELETE FROM kv WHERE k=?');
    setInterval(() => { try { this.db.prepare('DELETE FROM kv WHERE exp IS NOT NULL AND exp < ?').run(Date.now()); } catch (e) {} }, 10 * 60000).unref();
  }
  async get(k, opt) {
    const r = this.g.get(String(k));
    if (!r) return null;
    if (r.exp && r.exp < Date.now()) { this.d.run(String(k)); return null; }
    const v = Buffer.isBuffer(r.v) ? r.v.toString('utf8') : String(r.v);
    const type = typeof opt === 'string' ? opt : opt && opt.type;
    if (type === 'json') { try { return JSON.parse(v); } catch (e) { return null; } }
    return v;
  }
  async put(k, v, opt = {}) {
    let val = v;
    if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) val = Buffer.from(v.buffer ? v.buffer : v).toString('utf8');
    else if (typeof v !== 'string') val = String(v);
    const exp = opt.expirationTtl ? Date.now() + Number(opt.expirationTtl) * 1000 : opt.expiration ? Number(opt.expiration) * 1000 : null;
    this.p.run(String(k), val, exp);
  }
  async delete(k) { this.d.run(String(k)); }
  async list({ prefix = '', limit = 1000, cursor } = {}) {
    const off = Number(cursor || 0);
    const rows = this.db.prepare('SELECT k FROM kv WHERE k >= ? AND k < ? ORDER BY k LIMIT ? OFFSET ?').all(prefix, prefix + '￿', limit + 1, off);
    const more = rows.length > limit;
    return { keys: rows.slice(0, limit).map(r => ({ name: r.k })), list_complete: !more, cursor: more ? String(off + limit) : undefined };
  }
}

// caches.default: kept in memory, by URL, for as long as the response's max-age says.
class MemCache {
  constructor() { this.m = new Map(); }
  key(r) { return typeof r === 'string' ? r : r.url; }
  async match(r) {
    const e = this.m.get(this.key(r));
    if (!e) return undefined;
    if (e.until < Date.now()) { this.m.delete(this.key(r)); return undefined; }
    return new Response(e.body, { status: e.status, headers: e.headers });
  }
  async put(r, res) {
    const cc = res.headers.get('cache-control') || '';
    const m = cc.match(/s-maxage=(\d+)/) || cc.match(/max-age=(\d+)/);
    const ttl = m ? Number(m[1]) : 0;
    if (!ttl || /no-store|private/.test(cc)) return;
    const body = await res.arrayBuffer();
    if (this.m.size > 3000) this.m.delete(this.m.keys().next().value);
    this.m.set(this.key(r), { body, status: res.status, headers: [...res.headers.entries()], until: Date.now() + ttl * 1000 });
  }
  async delete(r) { return this.m.delete(this.key(r)); }
}
export const caches = { default: new MemCache() };

// HTMLRewriter: only what the site uses - appending HTML inside an element (here <head>).
export class HTMLRewriter {
  constructor() { this.h = []; }
  on(sel, handler) { this.h.push([sel, handler]); return this; }
  transform(res) {
    const hs = this.h;
    const p = (async () => {
      let html = await res.text();
      for (const [sel, handler] of hs) {
        const add = [];
        const el = { append: (c) => add.push(c), prepend: (c) => add.unshift(c), setAttribute() {}, getAttribute() { return null; } };
        if (handler.element) handler.element(el);
        if (!add.length) continue;
        const close = html.toLowerCase().indexOf(`</${sel}>`);
        if (close >= 0) html = html.slice(0, close) + add.join('') + html.slice(close);
      }
      return html;
    })();
    const headers = new Headers(res.headers); headers.delete('content-length');
    const stream = new ReadableStream({ async start(c) { c.enqueue(new TextEncoder().encode(await p)); c.close(); } });
    return new Response(stream, { status: res.status, statusText: res.statusText, headers });
  }
}
