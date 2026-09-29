/**
 * Rate Board collector driver.
 *
 * Cloudflare Pages Functions have no scheduled handler, so this small Worker
 * exists only to poke the collectors on /api/rax on a timer. It holds no
 * credentials: every call goes to Rate Board's own endpoints, which already
 * carry the RS token server side.
 *
 * Each firing does ONE bounded slice of work and returns, so a run never
 * outlasts its slot. The collectors track their own progress, so a missed or
 * repeated firing costs nothing but a little time.
 *
 * Deploy with a cron trigger of every minute:  * * * * *
 */

const BASE = 'https://rateboard-cgi.pages.dev/api/rax';

// Worked through in order. A season is finished when its player list is built,
// every player has a game log, and every player has been through the rax pass.
// Add or reorder freely — anything already done is skipped in a single cheap
// status call.
const JOBS = [
  // Already fully collected, so this one only ever takes its daily owner
  // snapshot. A finished season still needs to be listed here or its
  // ownership history never starts.
  { sport: 'ncaam', season: 2026 },   // 2025-26

  { sport: 'ncaam', season: 2025 },   // 2024-25
  { sport: 'ncaam', season: 2024 },   // 2023-24

  // Golf, newest first. Only 2026 is queued until the shape has been checked:
  // the game-log table is built around team sports, so a golf round may not
  // fill it sensibly. The rest go in once 2026 looks right.
  { sport: 'golf', season: 2026 }
  // { sport: 'golf', season: 2025 }, { sport: 'golf', season: 2024 },
  // { sport: 'golf', season: 2023 }, { sport: 'golf', season: 2022 },
  // { sport: 'golf', season: 2021 }, { sport: 'golf', season: 2020 },
  // { sport: 'golf', season: 2019 }, { sport: 'golf', season: 2018 },
  // { sport: 'golf', season: 2017 }, { sport: 'golf', season: 2016 },
  // { sport: 'golf', season: 2015 }, { sport: 'golf', season: 2014 }
];

// Players per firing. At roughly a third of a second each this keeps a run
// comfortably inside its minute, so two firings never overlap.
const SLICE = 120;

async function get(path) {
  const r = await fetch(`${BASE}?${path}`, { cf: { cacheTtl: 0 } });
  const text = await r.text();
  try { return { ok: r.ok, json: JSON.parse(text), text }; }
  catch (e) { return { ok: r.ok, json: null, text }; }
}

// Runs the next outstanding slice for one season. Returns a short line
// describing what it did, or null when this season is finished.
async function step(job) {
  const q = `sport=${job.sport}&season=${job.season}`;
  const tag = `${job.sport} ${job.season}`;

  // 1. The player list. Everything else reads from it.
  const gs = await get(`${q}&games=status`);
  if (!gs.json) return `${tag}: could not read status`;
  if (!gs.json.players) {
    await get(`${q}&games=1&limit=25`);          // builds the list, then stops
    return `${tag}: building the player list`;
  }

  // 2. Box scores. This also gives games played, so the separate
  //    games-played pass is not needed for a new season.
  const gl = await get(`${q}&gamelog=status`);
  if (gl.json && gl.json.remaining > 0) {
    await get(`${q}&gamelog=1&limit=${SLICE}`);
    return `${tag}: game logs, ${gl.json.remaining} players to go`;
  }

  // 3. Whole-number rax per game.
  const rx = await get(`${q}&gamelog=raxstatus`);
  if (rx.json && rx.json.remaining > 0) {
    await get(`${q}&gamelog=rax&limit=${SLICE}`);
    return `${tag}: rax per game, ${rx.json.remaining} players to go`;
  }

  // 4. Blanks mean the player earned nothing that game. Safe only once every
  //    player has been through the rax pass, which is what we just confirmed.
  if (gl.json && gl.json.rowsWithRax != null && gl.json.gameRows != null
      && gl.json.rowsWithRax < gl.json.gameRows) {
    const z = await get(`${q}&gamelog=zerofill`);
    return `${tag}: filled ${z.json && z.json.filled} blank rax values`;
  }

  // 5. Owner counts, one snapshot a day. Cheap - a single leaderboard walk
  //    covers the whole season - so it re-arms every day once the rest of a
  //    season is finished, building ownership history over time.
  const ow = await get(`${q}&owners=status`);
  if (ow.json && !ow.json.done) {
    await get(`${q}&owners=1`);
    return `${tag}: owner counts, ${ow.json.collectedToday} players so far today`;
  }

  return null;   // nothing left for this season today
}

export default {
  async scheduled(event, env, ctx) {
    for (const job of JOBS) {
      let line = null;
      try { line = await step(job); }
      catch (e) { console.log(`${job.sport} ${job.season}: ${e && e.message}`); return; }
      if (line) { console.log(line); return; }    // one slice per firing
    }
    console.log('nothing outstanding');
  },

  // Visiting the Worker shows how far along everything is, and ?run=1 does one
  // slice by hand without waiting for the timer.
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.searchParams.get('run') === '1') {
      for (const job of JOBS) {
        const line = await step(job);
        if (line) return new Response(line + '\n', { headers: { 'content-type': 'text/plain' } });
      }
      return new Response('nothing outstanding\n', { headers: { 'content-type': 'text/plain' } });
    }

    const out = [];
    for (const job of JOBS) {
      const q = `sport=${job.sport}&season=${job.season}`;
      const gs = await get(`${q}&games=status`);
      const gl = await get(`${q}&gamelog=status`);
      const rx = await get(`${q}&gamelog=raxstatus`);
      out.push(`${job.sport} ${job.season}`);
      out.push(`  players in list : ${gs.json ? gs.json.players : '?'}`);
      out.push(`  game logs done  : ${gl.json ? `${gl.json.playersDone} (${gl.json.gameRows} rows)` : '?'}`);
      out.push(`  rax done        : ${rx.json ? rx.json.playersDone : '?'}`);
      const ow = await get(`${q}&owners=status`);
      out.push(`  owners today    : ${ow.json ? `${ow.json.collectedToday}${ow.json.done ? ' (done)' : ''}`
                                              + ` over ${ow.json.snapshotDays || 0} day(s)` : '?'}`);
      out.push('');
    }
    return new Response(out.join('\n'), { headers: { 'content-type': 'text/plain' } });
  }
};
