// Records every slow or failing database call, so an overload can be traced to
// the request behind it instead of guessed at. Wraps the D1 binding for one
// request: each statement is timed, and anything over SLOW_MS (or any error)
// is added to a short rolling list in KV that the admin page shows.
//
// Writes to KV are batched per worker and made at most every 15 seconds, so
// this never becomes a load of its own.

const SLOW_MS = 3000;
const KEY = 'dbslow_v1';
const KEEP = 80;
let pending = [];
let lastFlush = 0;

async function flush(env) {
  if (!pending.length || !env.RATEBOARD_KV) return;
  const add = pending; pending = [];
  lastFlush = Date.now();
  let list = [];
  try { list = JSON.parse((await env.RATEBOARD_KV.get(KEY)) || '[]') || []; } catch (e) {}
  list = add.concat(list).slice(0, KEEP);
  try { await env.RATEBOARD_KV.put(KEY, JSON.stringify(list), { expirationTtl: 3 * 86400 }); } catch (e) {}
}

function note(env, waitUntil, entry) {
  pending.push(entry);
  if (pending.length > 40) pending = pending.slice(-40);
  if (Date.now() - lastFlush > 15000 && waitUntil) {
    try { waitUntil(flush(env).catch(() => {})); } catch (e) {}
  }
}

export function watchEnv(env, request, waitUntil) {
  const db = env && env.RATEBOARD_DB;
  if (!db || db.__watched) return env;
  let where = '';
  try { const u = new URL(request.url); where = (u.pathname + u.search).slice(0, 140); } catch (e) {}
  const real = new WeakMap();
  const wrapStmt = (stmt, sql) => {
    const p = new Proxy(stmt, {
      get(t, k) {
        if (k === 'bind') return (...a) => wrapStmt(t.bind(...a), sql);
        if (k === 'first' || k === 'all' || k === 'run' || k === 'raw') {
          return async (...a) => {
            const t0 = Date.now();
            try {
              const r = await t[k](...a);
              const ms = Date.now() - t0;
              if (ms > SLOW_MS) note(env, waitUntil, { at: new Date().toISOString(), ms, sql: String(sql).replace(/\s+/g, ' ').slice(0, 180), where });
              return r;
            } catch (e) {
              note(env, waitUntil, { at: new Date().toISOString(), ms: Date.now() - t0, sql: String(sql).replace(/\s+/g, ' ').slice(0, 180), where,
                err: String((e && e.message) || e).slice(0, 120) });
              throw e;
            }
          };
        }
        const v = t[k];
        return typeof v === 'function' ? v.bind(t) : v;
      }
    });
    real.set(p, stmt);
    return p;
  };
  const wdb = new Proxy(db, {
    get(t, k) {
      if (k === '__watched') return true;
      if (k === 'prepare') return sql => wrapStmt(t.prepare(sql), sql);
      if (k === 'batch') return async stmts => {
        const t0 = Date.now();
        try {
          const r = await t.batch(stmts.map(s => real.get(s) || s));
          const ms = Date.now() - t0;
          if (ms > SLOW_MS) note(env, waitUntil, { at: new Date().toISOString(), ms, sql: `batch of ${stmts.length}`, where });
          return r;
        } catch (e) {
          note(env, waitUntil, { at: new Date().toISOString(), ms: Date.now() - t0, sql: `batch of ${stmts.length}`, where, err: String((e && e.message) || e).slice(0, 120) });
          throw e;
        }
      };
      const v = t[k];
      return typeof v === 'function' ? v.bind(t) : v;
    }
  });
  return Object.assign({}, env, { RATEBOARD_DB: wdb });
}

export async function readSlow(env) {
  try { await flush(env); } catch (e) {}
  try { return JSON.parse((await env.RATEBOARD_KV.get(KEY)) || '[]') || []; } catch (e) { return []; }
}
