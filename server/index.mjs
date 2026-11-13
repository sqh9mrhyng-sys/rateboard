/* Rax Academy server entry (2026-11-12). Starts several 'web' processes that
   share the site's port and one 'jobs' process for the bot and collectors
   (see app.mjs). A process that dies is started again; on a restart every
   process finishes its work in flight before exiting. */
import cluster from 'node:cluster';
import os from 'node:os';

if (cluster.isPrimary && !process.env.ROLE) {
  const WEB = Math.max(2, Math.min(4, os.cpus().length));
  let stopping = false;
  const roles = new Map();
  const start = role => { const w = cluster.fork({ ROLE: role }); roles.set(w.id, role); return w; };
  for (let i = 0; i < WEB; i++) start('web');
  start('jobs');
  cluster.on('exit', (w, code, sig) => {
    const role = roles.get(w.id); roles.delete(w.id);
    if (stopping) { if (!Object.keys(cluster.workers).length) process.exit(0); return; }
    console.error(`${role} process ended (${code ?? sig}) - starting another`);
    setTimeout(() => start(role), 1000);
  });
  const stop = () => {
    if (stopping) return; stopping = true;
    for (const w of Object.values(cluster.workers)) { try { w.process.kill('SIGTERM'); } catch (e) {} }
    setTimeout(() => process.exit(0), 95000).unref();
    if (!Object.keys(cluster.workers).length) process.exit(0);
  };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
} else {
  await import('./app.mjs');
}
