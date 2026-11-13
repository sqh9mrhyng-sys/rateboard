/* Rax Academy server entry (2026-11-12). Starts several 'web' processes that
   share the site's port and one 'jobs' process for the bot and collectors
   (see app.mjs). A process that dies is started again; on a restart every
   process finishes its work in flight before exiting. */
import cluster from 'node:cluster';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

/* A short log of process starts and endings (2026-11-13: the site went down
   for a few minutes with no way to see why). Read at /__status. */
const EV = path.join(process.env.DATA_DIR || '/opt/rax/data', 'server-events.log');
const logEv = msg => { try { fs.appendFileSync(EV, new Date().toISOString() + ' ' + msg + '\n'); } catch (e) {} };

if (cluster.isPrimary && !process.env.ROLE) {
  const WEB = Math.max(2, Math.min(4, os.cpus().length));
  let stopping = false;
  const roles = new Map();
  const start = role => { const w = cluster.fork({ ROLE: role }); roles.set(w.id, role); return w; };
  logEv(`primary started: ${WEB} web + 1 heavy + 1 jobs, ${Math.round(os.totalmem() / 1048576)}MB RAM, ${os.cpus().length} CPUs`);
  for (let i = 0; i < WEB; i++) start('web');
  start('heavy');
  start('jobs');
  cluster.on('exit', (w, code, sig) => {
    const role = roles.get(w.id); roles.delete(w.id);
    if (stopping) { if (!Object.keys(cluster.workers).length) process.exit(0); return; }
    console.error(`${role} process ended (${code ?? sig}) - starting another`);
    logEv(`${role} process ended (${code ?? sig}), free RAM ${Math.round(os.freemem() / 1048576)}MB - restarting it`);
    setTimeout(() => start(role), 1000);
  });
  /* Stopping in order (2026-11-13: web processes quit at once while the jobs
     process finished its DMs, so the site showed errors for ~85 seconds on
     every update): the jobs process finishes first while the web processes
     keep answering, then the web processes stop (about a second). */
  const stop = () => {
    if (stopping) return; stopping = true; logEv('restart/stop requested');
    const all = () => Object.values(cluster.workers);
    const webs = () => all().filter(w => roles.get(w.id) === 'web');
    const jobs = all().filter(w => roles.get(w.id) === 'jobs');
    let webStopped = false;
    const stopWebs = () => { if (webStopped) return; webStopped = true; for (const w of all()) { if (roles.get(w.id) !== 'jobs') try { w.send('stop'); } catch (e) {} } };
    setTimeout(stopWebs, 50000).unref();   // never wait on the bot past 50s
    if (jobs.length) { for (const w of jobs) { try { w.send('stop'); } catch (e) {} w.on('exit', () => { if (!all().some(x => x !== w && x.id !== w.id && roles.get(x.id) === 'jobs')) stopWebs(); }); } }
    else stopWebs();
    setTimeout(() => { logEv('stop took too long - exiting'); for (const w of all()) { try { w.process.kill('SIGKILL'); } catch (e) {} } process.exit(0); }, 75000).unref();
    if (!all().length) process.exit(0);
  };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
} else {
  await import('./app.mjs');
}
