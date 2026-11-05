// raxacademy.app/h/<code>: the short link in a swap DM, sent on to the
// member's signed hour page ("buy" from the warning, "offer" from the contact).
export async function onRequestGet({ params, env }) {
  const code = String(params.code || '').replace(/[^0-9a-f]/gi, '').slice(0, 20);
  let r = null;
  try { r = await env.RATEBOARD_DB.prepare('SELECT u, d, t, s FROM hour_links2 WHERE code=?').bind(code).first(); } catch (e) {}
  if (!r) { try { r = await env.RATEBOARD_DB.prepare('SELECT u, d, t FROM hour_links WHERE code=?').bind(code).first(); } catch (e) {} }
  if (!r) return new Response('This link is not valid.', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  return Response.redirect(`https://raxacademy.app/hour?u=${encodeURIComponent(r.u)}&d=${r.d}&t=${r.t}&s=${r.s || 'buy'}`, 302);
}
