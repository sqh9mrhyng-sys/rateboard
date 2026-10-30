// raxacademy.app is the board's address now. Anyone opening the old
// pages.dev address in a browser is sent there, path and query kept.
//
// /api/ is left alone on purpose: the cron Worker calls
// rateboard-cgi.pages.dev/api/rax every minute and is not being redeployed,
// and a redirect on that path would stop collection. Preview deployments
// (<hash>.rateboard-cgi.pages.dev) are a different host and are not touched.
const OLD_HOST = 'rateboard-cgi.pages.dev';
const NEW_ORIGIN = 'https://raxacademy.app';

export async function onRequest({ request, next }) {
  const url = new URL(request.url);
  if (url.hostname === OLD_HOST && !url.pathname.startsWith('/api/')) {
    return Response.redirect(NEW_ORIGIN + url.pathname + url.search, 301);
  }
  return next();
}
