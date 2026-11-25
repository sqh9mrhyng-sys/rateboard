/* Testers (Dennis, 2026-11-25: "give people perms to the part of site I need testers"). Pages still being built are
   Dennis's only; he can open one to chosen members from the Testers page. KV tester_access_v1 = { "/otd": ["key", ...] }.
   Add a page to TESTER_PAGES to make it grantable. */
export const TESTER_PAGES = { '/otd': 'OTD breakdown' };
export const TESTER_KV = 'tester_access_v1';
export async function testerMap(env) { try { return JSON.parse((await env.RATEBOARD_KV.get(TESTER_KV)) || '{}') || {}; } catch (e) { return {}; } }
// Pages this member may test (every one for Dennis).
export async function testerPagesFor(env, who) {
  const w = String(who || '').toLowerCase(); if (!w) return [];
  if (w === 'dennis') return Object.keys(TESTER_PAGES);
  const m = await testerMap(env); return Object.keys(TESTER_PAGES).filter(p => (m[p] || []).includes(w));
}
