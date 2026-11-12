/* Copies every key in the site's Cloudflare KV into the droplet's kv.db.
   Needs CF_API_TOKEN, CF_ACCOUNT_ID, CF_KV_ID (migrate.sh sets them). */
import { KV } from './shims.mjs';
const { CF_API_TOKEN: T, CF_ACCOUNT_ID: A, CF_KV_ID: N, DATA_DIR = '/opt/rax/data' } = process.env;
const kv = new KV(DATA_DIR + '/kv.db');
const base = `https://api.cloudflare.com/client/v4/accounts/${A}/storage/kv/namespaces/${N}`;
const h = { authorization: `Bearer ${T}` };
const keys = []; let cursor = '';
do {
  const r = await (await fetch(`${base}/keys?limit=1000${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`, { headers: h })).json();
  if (!r.success) { console.error('listing failed', JSON.stringify(r.errors)); process.exit(1); }
  keys.push(...r.result); cursor = r.result_info && r.result_info.cursor;
  process.stdout.write(`\rlisted ${keys.length} keys`);
} while (cursor);
console.log();
let done = 0, failed = 0;
const now = Date.now() / 1000;
const todo = keys.filter(k => !k.expiration || k.expiration > now + 5);
async function worker() {
  while (todo.length) {
    const k = todo.pop();
    for (let i = 0; i < 4; i++) {
      try {
        const r = await fetch(`${base}/values/${encodeURIComponent(k.name)}`, { headers: h });
        if (r.status === 404) break;
        if (r.status === 429 || r.status >= 500) { await new Promise(x => setTimeout(x, 1500 * (i + 1))); continue; }
        const v = await r.text();
        await kv.put(k.name, v, k.expiration ? { expiration: k.expiration } : {});
        done++; break;
      } catch (e) { if (i === 3) failed++; await new Promise(x => setTimeout(x, 1000)); }
    }
    if (done % 200 === 0) process.stdout.write(`\rcopied ${done}/${keys.length}`);
  }
}
await Promise.all(Array.from({ length: 12 }, worker));
console.log(`\nKV copied: ${done} keys${failed ? `, ${failed} failed` : ''}.`);
