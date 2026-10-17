// Builds a static Stremio addon (manifest + catalogs) from the HentaiStream addon,
// mapping each title to IDs your scraper addons understand (Kitsu > IMDb > MAL/AniList).
// Run daily by GitHub Actions; output goes to ./dist and is deployed to GitHub Pages.
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { refreshQueue, applyMatchRefresh } from './scripts/cache-policy.mjs';

const SOURCE = (process.env.SOURCE_ADDON || 'https://hentaistream-addon.keypop3750.workers.dev').replace(/\/$/, '');
const TMDB_KEY = process.env.TMDB_KEY || '';                   // optional, enables IMDb fallback
const EXTRA_ANIME_IDS = process.env.EXTRA_ANIME_IDS === '1';   // allow mal:/anilist: IDs as last resort
const MAX_LOOKUPS = +(process.env.MAX_LOOKUPS_PER_RUN || 1500); // new titles resolved per run
const MAX_PAGES = 80;
const THRESHOLD = 0.85;
const RETRY_MISS_DAYS = 30;
const CACHE_FILE = 'cache/matches-v2.json';
const KITSU_H = { Accept: 'application/vnd.api+json' };

const SOURCE_CATALOGS = [
  { srcType: 'hentai', srcId: 'hentai-top-rated', id: 'hkb-top',    name: 'Hentai Bridge: Top Rated' },
  { srcType: 'hentai', srcId: 'hentai-monthly',   id: 'hkb-recent', name: 'Hentai Bridge: New Releases' },
  { srcType: 'hentai', srcId: 'hentai-all',       id: 'hkb-all',    name: 'Hentai Bridge: All' },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, headers = {}, init = {}, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url, { ...init, headers: { 'User-Agent': 'kitsu-bridge-builder', ...headers } });
      if (res.status === 404) return null;
      if (res.status === 429) { await sleep(5000 * i); throw new Error('rate limited'); }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (i === tries) { console.warn(`FAILED ${url}: ${e.message}`); return null; }
      await sleep(1000 * i);
    }
  }
}

// ---------- title matching ----------
function norm(s = '') {
  return String(s).toLowerCase()
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\[.*?\]|\(.*?\)/g, ' ')
    .replace(/\b(the animation|uncensored|censored|subbed|dubbed|episode \d+|ep \d+|hd)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
function bigrams(s) {
  const t = ` ${s} `; const m = new Map();
  for (let i = 0; i < t.length - 1; i++) { const g = t.slice(i, i + 2); m.set(g, (m.get(g) || 0) + 1); }
  return m;
}
function dice(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const A = bigrams(a), B = bigrams(b); let hit = 0, total = 0;
  for (const [g, n] of A) { total += n; if (B.has(g)) hit += Math.min(n, B.get(g)); }
  for (const n of B.values()) total += n;
  return (2 * hit) / total;
}
const bestScore = (q, titles) => Math.max(0, ...titles.filter(Boolean).map(norm).filter(Boolean).map((t) => dice(q, t)));

// ---------- Kitsu ----------
async function kitsuMatch(title) {
  const q = norm(title); if (!q) return null;
  const d = await getJson(`https://kitsu.io/api/edge/anime?filter[text]=${encodeURIComponent(q)}&page[limit]=10`, KITSU_H);
  await sleep(350);
  let best = null;
  for (const it of d?.data || []) {
    const a = it.attributes || {};
    if (!(a.nsfw || a.ageRating === 'R18')) continue;
    const score = bestScore(q, [a.canonicalTitle, ...Object.values(a.titles || {}), ...(a.abbreviatedTitles || [])]);
    if (score >= THRESHOLD && (!best || score > best.score))
      best = { id: it.id, title: a.canonicalTitle, score, poster: a.posterImage?.medium || null };
  }
  return best;
}
async function kitsuMappings(id) {
  const d = await getJson(`https://kitsu.io/api/edge/anime/${id}/mappings?page[limit]=20`, KITSU_H);
  await sleep(350);
  const out = {};
  for (const m of d?.data || []) {
    const a = m.attributes || {};
    if (a.externalSite === 'myanimelist/anime') out.mal = String(a.externalId);
    else if (a.externalSite === 'anilist/anime') out.anilist = String(a.externalId);
    else if (a.externalSite === 'anidb') out.anidb = String(a.externalId);
  }
  return out;
}
// reverse lookup: MAL/AniList id -> Kitsu id
async function kitsuFromExternal(site, extId) {
  const d = await getJson(`https://kitsu.io/api/edge/mappings?filter[externalSite]=${site}&filter[externalId]=${extId}&include=item`, KITSU_H);
  await sleep(350);
  return d?.included?.find((x) => x.type === 'anime')?.id || null;
}

// ---------- AniList ----------
const ANILIST_QUERY = `query($q:String){Page(perPage:10){media(search:$q,type:ANIME,isAdult:true){id idMal title{romaji english native} synonyms}}}`;
async function anilistMatch(title) {
  const q = norm(title); if (!q) return null;
  const d = await getJson('https://graphql.anilist.co', { 'Content-Type': 'application/json', Accept: 'application/json' },
    { method: 'POST', body: JSON.stringify({ query: ANILIST_QUERY, variables: { q } }) });
  await sleep(800); // ~75 req/min, under AniList's limit
  let best = null;
  for (const m of d?.data?.Page?.media || []) {
    const score = bestScore(q, [m.title?.romaji, m.title?.english, m.title?.native, ...(m.synonyms || [])]);
    if (score >= THRESHOLD && (!best || score > best.score))
      best = { id: m.id, idMal: m.idMal, title: m.title?.english || m.title?.romaji, score };
  }
  return best;
}

// ---------- TMDB (optional) ----------
async function tmdbMatch(title) {
  if (!TMDB_KEY) return null;
  const q = norm(title); if (!q) return null;
  let best = null;
  for (const kind of ['tv', 'movie']) {
    const d = await getJson(`https://api.themoviedb.org/3/search/${kind}?api_key=${TMDB_KEY}&include_adult=true&query=${encodeURIComponent(q)}`);
    await sleep(120);
    for (const r of d?.results || []) {
      if (!(r.genre_ids || []).includes(16)) continue; // animation only
      const score = bestScore(q, [r.name, r.original_name, r.title, r.original_title]);
      if (score >= THRESHOLD + 0.05 && (!best || score > best.score))
        best = { kind, id: r.id, score, title: r.name || r.title, poster: r.poster_path ? `https://image.tmdb.org/t/p/w342${r.poster_path}` : null };
    }
  }
  if (!best) return null;
  const ext = await getJson(`https://api.themoviedb.org/3/${best.kind}/${best.id}/external_ids?api_key=${TMDB_KEY}`);
  await sleep(120);
  if (!ext?.imdb_id) return null;
  return { imdb: ext.imdb_id, imdbType: best.kind === 'tv' ? 'series' : 'movie', title: best.title, poster: best.poster };
}

// ---------- resolve one title to a set of IDs ----------
async function resolve(title) {
  const e = { ids: {}, title: null, poster: null, checked: Date.now() };
  const k = await kitsuMatch(title);
  if (k) {
    e.ids.kitsu = k.id; e.title = k.title; e.poster = k.poster;
    Object.assign(e.ids, await kitsuMappings(k.id));
  } else {
    const al = await anilistMatch(title);
    if (al) {
      e.ids.anilist = String(al.id); e.title = al.title;
      if (al.idMal) e.ids.mal = String(al.idMal);
      const kid = (al.idMal && await kitsuFromExternal('myanimelist/anime', al.idMal)) || await kitsuFromExternal('anilist/anime', al.id);
      if (kid) e.ids.kitsu = kid;
    }
  }
  if (!e.ids.kitsu && TMDB_KEY) {
    const t = await tmdbMatch(title);
    if (t) { e.ids.imdb = t.imdb; e.imdbType = t.imdbType; e.title ||= t.title; e.poster ||= t.poster; }
  }
  return e;
}

// priority: Kitsu > IMDb > MAL > AniList (last two opt-in)
function pickId(e) {
  if (!e) return null;
  if (e.ids.kitsu) return { id: `kitsu:${e.ids.kitsu}`, type: 'anime', prefix: 'kitsu' };
  if (e.ids.imdb) return { id: e.ids.imdb, type: e.imdbType || 'series', prefix: 'tt' };
  if (EXTRA_ANIME_IDS && e.ids.mal) return { id: `mal:${e.ids.mal}`, type: 'anime', prefix: 'mal' };
  if (EXTRA_ANIME_IDS && e.ids.anilist) return { id: `anilist:${e.ids.anilist}`, type: 'anime', prefix: 'anilist' };
  return null;
}

// ---------- source addon ----------
async function fetchSourceCatalog({ srcType, srcId }) {
  const out = []; const seen = new Set(); let skip = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = skip === 0 ? `${SOURCE}/catalog/${srcType}/${srcId}.json` : `${SOURCE}/catalog/${srcType}/${srcId}/skip=${skip}.json`;
    const data = await getJson(url);
    const metas = data?.metas || [];
    const fresh = metas.filter((m) => m.id && !seen.has(m.id));
    if (!fresh.length) break;
    fresh.forEach((m) => { seen.add(m.id); out.push(m); });
    skip += metas.length;
    await sleep(200);
  }
  return out;
}

// ---------- main ----------
let cache = {};
try { cache = JSON.parse(await readFile(CACHE_FILE, 'utf8')); } catch {}

const catalogs = {};
for (const sc of SOURCE_CATALOGS) {
  catalogs[sc.id] = await fetchSourceCatalog(sc);
  console.log(`${sc.srcId}: ${catalogs[sc.id].length} source items`);
}
if (!Object.values(catalogs).some((a) => a.length)) { console.error('Source returned nothing; keeping previous deployment.'); process.exit(1); }

// HenGuys cache refresh policy v3
const now = Date.now(); let lookups = 0;
const candidates = refreshQueue({ catalogs, cache, norm, pickId, now, env: process.env });
const refreshStats = { candidates:candidates.length, attempted:0, deferred:0, newMatches:0,
  revalidated:0, updatedIds:0, retainedExisting:0, missed:0, reasons:{} };
for (const task of candidates.slice(0, MAX_LOOKUPS)) {
  lookups++;
  const previous = cache[task.key];
  const incoming = await resolve(task.title);
  const { entry, outcome } = applyMatchRefresh({previous, incoming, pickId, now:Date.now()});
  cache[task.key] = entry;
  refreshStats.attempted++;
  refreshStats.reasons[task.reason] = (refreshStats.reasons[task.reason] || 0) + 1;
  if (outcome === 'new-match') refreshStats.newMatches++;
  else if (outcome === 'revalidated') refreshStats.revalidated++;
  else if (outcome === 'updated-id') refreshStats.updatedIds++;
  else if (outcome === 'retained-existing') refreshStats.retainedExisting++;
  else refreshStats.missed++;
  console.log('CACHE ' + outcome + ' [' + task.reason + '] ' + task.title + ' => ' + (pickId(entry)?.id ?? '-'));
}
refreshStats.deferred = Math.max(0, candidates.length - lookups);
if (refreshStats.deferred) console.log(refreshStats.deferred + ' title lookups deferred to the next run.');
await mkdir('dist', { recursive:true });
await writeFile('dist/cache-refresh-status.json', JSON.stringify({ ...refreshStats,
  policyVersion:3, generatedAt:new Date().toISOString(),
  mode:process.env.CACHE_REFRESH_MODE || 'stale',
  note:'The existing cache is retained; previously matched titles are revalidated in batches.' }, null, 2));
console.log('CACHE REFRESH SUMMARY', JSON.stringify(refreshStats));

// build catalogs grouped by stremio type
const out = {}; const prefixes = new Set(); const stats = {};
for (const sc of SOURCE_CATALOGS) {
  const seen = new Set();
  for (const m of catalogs[sc.id]) {
    const e = cache[norm(m.name)]; const p = pickId(e);
    if (!p || seen.has(p.id)) continue;
    seen.add(p.id); prefixes.add(p.prefix); stats[p.prefix] = (stats[p.prefix] || 0) + 1;
    ((out[p.type] ||= {})[sc.id] ||= []).push({ id: p.id, type: p.type, name: e.title || m.name, poster: m.poster || e.poster || undefined });
  }
}

await mkdir('dist', { recursive: true });
await writeFile('dist/.nojekyll', '');
const manifestCatalogs = [];
for (const [type, byCat] of Object.entries(out)) {
  await mkdir(`dist/catalog/${type}`, { recursive: true });
  for (const sc of SOURCE_CATALOGS) {
    const metas = byCat[sc.id]; if (!metas?.length) continue;
    await writeFile(`dist/catalog/${type}/${sc.id}.json`, JSON.stringify({ metas }));
    manifestCatalogs.push({ type, id: sc.id, name: sc.name });
  }
}
const manifest = {
  id: 'community.hentai.kitsu.bridge',
  version: `1.0.${Math.floor(now / 864e5)}`,
  name: 'Hentai Kitsu Bridge',
  description: '18+ only. Catalog mapped to Kitsu/IMDb IDs so your scraper and debrid addons can find streams. Auto-updated daily.',
  resources: ['catalog'],
  types: Object.keys(out),
  idPrefixes: [...prefixes],
  catalogs: manifestCatalogs,
  behaviorHints: { adult: true },
};
await writeFile('dist/manifest.json', JSON.stringify(manifest, null, 2));

const total = Object.values(stats).reduce((a, b) => a + b, 0);
const [owner, repo] = (process.env.GITHUB_REPOSITORY || 'USER/REPO').split('/');
const base = `${owner}.github.io/${repo}`;
await writeFile('dist/index.html',
  `<!doctype html><meta charset="utf-8"><title>Hentai Kitsu Bridge</title>` +
  `<body style="font-family:sans-serif;max-width:480px;margin:3em auto"><h1>Hentai Kitsu Bridge</h1>` +
  `<p>18+ only. ${total} matched items.</p><p><a href="stremio://${base}/manifest.json">Install in Stremio</a></p>` +
  `<p>Manifest: https://${base}/manifest.json</p>`);

await mkdir('cache', { recursive: true });
await writeFile(CACHE_FILE, JSON.stringify(cache, null, 1));
console.log('Done.', JSON.stringify(stats), `(${total} entries)`);
