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
  // Already collected, so these only take their daily owner snapshot.
  { sport: 'ncaam', season: 2026 },   // CBB 2025-26
  { sport: 'ncaam', season: 2025 },   // CBB 2024-25
  { sport: 'ncaam', season: 2024 },   // CBB 2023-24

  // FC. 2026 is the 2026-27 season, 2025 the 2025-26 one.
  { sport: 'soccer', season: 2026 },
  { sport: 'soccer', season: 2025 },

  // Golf, newest first. Plain calendar years.
  { sport: 'golf', season: 2026 },
  { sport: 'golf', season: 2025 }, { sport: 'golf', season: 2024 },
  { sport: 'golf', season: 2023 }, { sport: 'golf', season: 2022 },
  { sport: 'golf', season: 2021 }, { sport: 'golf', season: 2020 },
  { sport: 'golf', season: 2019 }, { sport: 'golf', season: 2018 },
  { sport: 'golf', season: 2017 }, { sport: 'golf', season: 2016 },
  { sport: 'golf', season: 2015 }, { sport: 'golf', season: 2014 },

  // MLB, plain calendar years.
  { sport: 'mlb', season: 2026 }, { sport: 'mlb', season: 2025 },
  { sport: 'mlb', season: 2024 }, { sport: 'mlb', season: 2023 },
  { sport: 'mlb', season: 2022 },

  // NBA. 2026 is 2025-26, back to 2023 which is 2022-23.
  { sport: 'nba', season: 2026 }, { sport: 'nba', season: 2025 },
  { sport: 'nba', season: 2024 }, { sport: 'nba', season: 2023 },

  // NHL. 2026 is 2026-27, back to 2023 which is 2023-24.
  { sport: 'nhl', season: 2026 }, { sport: 'nhl', season: 2025 },
  { sport: 'nhl', season: 2024 }, { sport: 'nhl', season: 2023 },

  // WNBA, plain calendar years.
  { sport: 'wnba', season: 2026 }, { sport: 'wnba', season: 2025 },
  { sport: 'wnba', season: 2024 },

  // NFL. 2026 is 2026-27, back to 2023 which is 2023-24.
  { sport: 'nfl', season: 2026 }, { sport: 'nfl', season: 2025 },
  { sport: 'nfl', season: 2024 }, { sport: 'nfl', season: 2023 },

  // CFB last - much the biggest, since it covers FBS and FCS.
  { sport: 'ncaaf', season: 2026 }, { sport: 'ncaaf', season: 2025 },
  { sport: 'ncaaf', season: 2024 }, { sport: 'ncaaf', season: 2023 }
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
const JOB_LIST = JOBS.map(j => `${j.sport}:${j.season}`).join(',');

// Asks the board what needs doing next across the whole queue, then does that
// one bounded slice. Two requests a firing however long the queue gets.
async function step() {
  const n = await get(`queue=next&jobs=${encodeURIComponent(JOB_LIST)}`);
  if (!n.json) return 'could not read the queue';
  if (!n.json.phase) return null;

  const { sport, season, phase } = n.json;
  const q = `sport=${sport}&season=${season}`;
  const tag = `${sport} ${season}`;

  if (phase === 'list')     { await get(`${q}&games=1&limit=25`);            return `${tag}: building the player list`; }
  if (phase === 'gamelog')  { await get(`${q}&gamelog=1&limit=${SLICE}`);    return `${tag}: game logs`; }
  if (phase === 'rax')      { await get(`${q}&gamelog=rax&limit=${SLICE}`);  return `${tag}: rax per game`; }
  if (phase === 'zerofill') { await get(`${q}&gamelog=zerofill`);            return `${tag}: filling blank rax`; }
  if (phase === 'conf')     { await get(`${q}&conf=1`);                      return `${tag}: conferences`; }
  if (phase === 'owners')   { await get(`${q}&owners=1`);                    return `${tag}: owner counts`; }
  return `${tag}: unknown phase ${phase}`;
}

export default {
  async scheduled(event, env, ctx) {
    try {
      const line = await step();
      console.log(line || 'nothing outstanding');
    } catch (e) {
      console.log('failed: ' + (e && e.message));
    }
  },

  // Visiting the Worker shows how far along everything is, and ?run=1 does one
  // slice by hand without waiting for the timer.
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.searchParams.get('run') === '1') {
      const line = await step();
      return new Response((line || 'nothing outstanding') + '\n',
        { headers: { 'content-type': 'text/plain' } });
    }

    // Progress for everything in the queue. One row a season, so a long queue
    // stays readable.
    const out = ['queue: ' + JOBS.length + ' seasons', ''];
    const next = await get(`queue=next&jobs=${encodeURIComponent(JOB_LIST)}`);
    out.push(next.json && next.json.phase
      ? `working on: ${next.json.sport} ${next.json.season} — ${next.json.phase}`
      : 'working on: nothing outstanding right now');
    out.push('');

    for (const job of JOBS) {
      const q = `sport=${job.sport}&season=${job.season}`;
      const gl = await get(`${q}&gamelog=status`);
      const j = gl.json || {};
      out.push(`${job.sport} ${job.season}`.padEnd(14)
        + `${j.players || 0} players, ${j.playersDone || 0} done, ${(j.gameRows || 0).toLocaleString()} rows`);
    }
    return new Response(out.join('\n'), { headers: { 'content-type': 'text/plain' } });
  }
};
