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

/* Usage meter. D1 bills by rows read and rows written, and every result
   says how many it used, so each one is added up here by request type and
   statement, and the totals are folded into one KV record per day at most
   every five minutes per worker. */
const USE_FLUSH_MS = 5 * 60000;
let use = new Map(), useFlushed = Date.now();
function addUse(where, sql, meta, tally) {
  if (!meta) return;
  const r = Number(meta.rows_read) || 0, w = Number(meta.rows_written) || 0;
  if (!r && !w) return;
  if (tally) { tally.r += r; tally.w += w; }
  const k = where + ' | ' + String(sql).replace(/\s+/g, ' ').slice(0, 90);
  const u = use.get(k) || { n: 0, r: 0, w: 0 };
  u.n++; u.r += r; u.w += w; use.set(k, u);
}
async function flushUse(env) {
  if (!use.size || !env.RATEBOARD_KV) return;
  const add = use; use = new Map(); useFlushed = Date.now();
  const key = 'dbuse_v1_' + new Date().toISOString().slice(0, 10);
  let cur = {};
  try { cur = JSON.parse((await env.RATEBOARD_KV.get(key)) || '{}') || {}; } catch (e) {}
  for (const [k, u] of add) { const c = cur[k] || { n: 0, r: 0, w: 0 }; c.n += u.n; c.r += u.r; c.w += u.w; cur[k] = c; }
  // Keep the biggest few hundred so the record stays small.
  const top = Object.entries(cur).sort((a, b) => (b[1].r / 1000 + b[1].w) - (a[1].r / 1000 + a[1].w)).slice(0, 300);
  try { await env.RATEBOARD_KV.put(key, JSON.stringify(Object.fromEntries(top)), { expirationTtl: 14 * 86400 }); } catch (e) {}
}
export async function readUse(env, day) {
  try { await flushUse(env); } catch (e) {}
  try { return JSON.parse((await env.RATEBOARD_KV.get('dbuse_v1_' + (day || new Date().toISOString().slice(0, 10)))) || '{}') || {}; } catch (e) { return {}; }
}

async function flush(env) {
  if (!pending.length || !env.RATEBOARD_KV) return;
  const add = pending; pending = [];
  lastFlush = Date.now();
  let list = [];
  try { list = JSON.parse((await env.RATEBOARD_KV.get(KEY)) || '[]') || []; } catch (e) {}
  list = add.concat(list).slice(0, KEEP);
  try { await env.RATEBOARD_KV.put(KEY, JSON.stringify(list), { expirationTtl: 3 * 86400 }); } catch (e) {}
}

/* CREATE ... IF NOT EXISTS statements are run at the top of most requests;
   each one is a full round trip to the database. Once one has worked in this
   worker it is skipped for the worker's life (2026-11-04, pages were slow
   to open). */
const DDL_RE = /^\s*CREATE\s+(UNIQUE\s+)?(TABLE|INDEX)\s+IF\s+NOT\s+EXISTS/i;
const ddlDone = new Set();
/* A whole request that took long, recorded with the slow calls. */
export function noteSlowRequest(env, waitUntil, entry) { note(env, waitUntil, entry); }
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
  let kind = '';
  try {
    const u = new URL(request.url); where = (u.pathname + u.search).slice(0, 140);
    const ps = [...u.searchParams.keys()].filter(k => !['t', 'sport', 'season', 'playerId', 'q', 'jobs', 'key'].includes(k)).slice(0, 2);
    kind = u.pathname.replace('/api/', '') + (ps.length ? '?' + ps.map(k => `${k}=${String(u.searchParams.get(k)).slice(0, 20)}`).join('&') : '');
  } catch (e) {}
  const real = new WeakMap();
  // What this one request has used, for the background jobs' daily budget.
  const tally = { r: 0, w: 0 };
  const wrapStmt = (stmt, sql) => {
    const p = new Proxy(stmt, {
      get(t, k) {
        if (k === 'bind') return (...a) => wrapStmt(t.bind(...a), sql);
        if (k === 'first' || k === 'all' || k === 'run' || k === 'raw') {
          return async (...a) => {
            if (k === 'run' && DDL_RE.test(sql) && ddlDone.has(sql)) return { success: true, meta: {}, results: [] };
            const t0 = Date.now();
            try {
              let r;
              // first() carries no usage numbers, so it is run as all() and
              // the first row handed back, which is the same thing.
              if (k === 'first') {
                const res = await t.all();
                addUse(kind, sql, res && res.meta, tally);
                const row = res && res.results && res.results[0];
                r = a.length ? (row ? row[a[0]] : null) : (row || null);
              } else {
                r = await t[k](...a);
                if (k !== 'raw') addUse(kind, sql, r && r.meta, tally);
                if (k === 'run' && DDL_RE.test(sql)) { ddlDone.add(sql); if (ddlDone.size > 500) ddlDone.clear(); }
              }
              if (Date.now() - useFlushed > USE_FLUSH_MS && waitUntil) { try { waitUntil(flushUse(env).catch(() => {})); } catch (e) {} }
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
      if (k === '__tally') return tally;
      if (k === 'prepare') return sql => wrapStmt(t.prepare(sql), sql);
      if (k === 'batch') return async stmts => {
        const t0 = Date.now();
        try {
          const r = await t.batch(stmts.map(s => real.get(s) || s));
          try { for (const x of (r || [])) addUse(kind, 'batch', x && x.meta, tally); } catch (e) {}
          if (Date.now() - useFlushed > USE_FLUSH_MS && waitUntil) { try { waitUntil(flushUse(env).catch(() => {})); } catch (e) {} }
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

/* ---- the background jobs' daily budget ------------------------------------
   The plan includes 50 million rows written and 25 billion read a month. The
   collectors and the market pull together are held to a share of that each
   day, so they can't run up usage charges again; past it they rest until
   midnight UTC. The rest of the allowance is left for people using the site. */
export const JOB_CAP = { w: 5000000, r: 2500000000 };   // per day (raised 2026-11-04, Dennis: bill sorted) - was 1.2M writes / 300M reads, which stopped the collector for the rest of the day once the re-walks hit it
/* Until the billing cycle that ran up the overage ends (Nov 16), the plan's
   included rows are already used, so every row is billed. The jobs get a much
   smaller daily share until then: at most about $0.40 a day if they hit it. */
const TIGHT_UNTIL = 0;   // bill sorted (2026-11-03): back to the normal JOB_CAP right away
export const TIGHT_CAP = { w: 300000, r: 100000000 };
export const capNow = () => (Date.now() < TIGHT_UNTIL ? TIGHT_CAP : JOB_CAP);
const jobKey = () => 'jobuse_v1_' + new Date().toISOString().slice(0, 10);
export async function jobUse(env) {
  try { return JSON.parse((await env.RATEBOARD_KV.get(jobKey())) || 'null') || { r: 0, w: 0, n: 0 }; } catch (e) { return { r: 0, w: 0, n: 0 }; }
}
const BUDGET_ON = false;   // removed 2026-11-04 (Dennis: usage and price aren't a worry) - flip to bring the daily cap back
export async function jobOverBudget(env) {
  if (!BUDGET_ON) return null;
  const u = await jobUse(env);
  const cap = capNow();
  return u.w >= cap.w || u.r >= cap.r ? u : null;
}
export async function addJobUse(env, tally, label) {
  if (!tally || (!tally.r && !tally.w)) return;
  const u = await jobUse(env);
  u.r += tally.r; u.w += tally.w; u.n = (u.n || 0) + 1;
  if (label) { u.by = u.by || {}; const b = u.by[label] || { r: 0, w: 0, n: 0 }; b.r += tally.r; b.w += tally.w; b.n++; u.by[label] = b; }
  try { await env.RATEBOARD_KV.put(jobKey(), JSON.stringify(u), { expirationTtl: 40 * 86400 }); } catch (e) {}
}
export async function jobHistory(env, days = 14) {
  const out = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    try { const v = JSON.parse((await env.RATEBOARD_KV.get('jobuse_v1_' + d)) || 'null'); if (v) out.push({ day: d, ...v }); } catch (e) {}
  }
  return out;
}
