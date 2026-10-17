// Static Stremio metadata builder for the existing HenGuys bridge.
// No extra npm dependencies. Preserve the original title matcher and its cache.
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const KITSU = /^kitsu:[1-9]\d*$/;
const IMDB = /^tt\d{7,10}$/;
export const SUPPORTED = ['kitsu', 'tt'];
const iso = (x) => {
  if (typeof x !== 'string' || !/^\d{4}-\d\d-\d\d/.test(x)) return null;
  const t = Date.parse(x);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};
export const isSupportedId = (id) => KITSU.test(id) || IMDB.test(id);
const string = (v) => typeof v === 'string' && v.trim() ? v.trim() : undefined;
const url = (v) => typeof v === 'string' && /^https:\/\//.test(v) ? v : undefined;

// A release date is required by the Stremio video schema. A title's premiere
// is used only when an actual episode airdate isn't available. 1970 is a
// sentinel for a truly unknown date, NOT a claim about the release year.
const UNKNOWN_DATE = '1970-01-01T00:00:00.000Z';
function episodesForKitsu(id, details = {}) {
  const count = Number.isInteger(details.episodeCount) && details.episodeCount > 0
    ? Math.min(details.episodeCount, 500) : 1;
  const episodes = Array.isArray(details.episodes) ? details.episodes : [];
  // Don't pretend the supplied first-air date is an individual episode's air date.
  // It is a spec-compatible fallback until per-episode dates are known.
  const byNum = new Map(episodes.filter(e => Number.isInteger(e.number) && e.number > 0).map(e => [e.number, e]));
  return Array.from({ length: count }, (_, index) => {
    const num = index + 1;
    const ep = byNum.get(num) || {};
    return {
      id: `${id}:${num}`, // Recognized by Torrentio's Kitsu anime stream route
      title: string(ep.title) || `Episode ${num}`,
      season: 1,
      episode: num,
      released: iso(ep.airdate) || iso(details.startDate) || UNKNOWN_DATE,
      ...(string(ep.synopsis) ? {overview: string(ep.synopsis)} : {}),
      ...(url(ep.thumbnail) ? {thumbnail: url(ep.thumbnail)} : {}),
    };
  });
}

export function makeMeta(preview, details = {}) {
  if (!isSupportedId(preview?.id)) throw new Error(`Unsupported ID: ${preview?.id}`);
  if (!['anime', 'series', 'movie'].includes(preview.type)) throw new Error(`Unsupported type: ${preview.type}`);
  if (!string(preview.name)) throw new Error(`Missing title: ${preview.id}`);
  const { id, type, name } = preview;
  const poster = url(preview.poster) || url(details.poster);
  const meta = {
    id, type, name,
    ...(poster ? { poster } : {}),
    ...(url(details.cover) ? { background: url(details.cover) } : {}),
    ...(string(details.synopsis) ? { description: string(details.synopsis) } : {}),
    ...(iso(details.startDate) ? { released: iso(details.startDate), releaseInfo: details.startDate.slice(0,4) } : {}),
    ...(details.rating && Number.isFinite(Number(details.rating)) ? { imdbRating: String((Number(details.rating)/10).toFixed(1)) } : {}),
  };
  if (type !== 'movie') {
    if (KITSU.test(id)) {
      meta.videos = episodesForKitsu(id, details);
    } else if (Array.isArray(details.videos) && details.videos.length) {
      // A Cinemeta series can have multiple seasons and different air dates.
      meta.videos = details.videos.filter(v => new RegExp(`^${id}:\\d+:\\d+$`).test(v.id))
        .map(v => ({ id:v.id, title:string(v.title) || `Episode ${v.episode}`,
          season:v.season, episode:v.episode,
          released:iso(v.released) || UNKNOWN_DATE,
          ...(string(v.overview) ? {overview:string(v.overview)} : {}),
          ...(url(v.thumbnail) ? {thumbnail:url(v.thumbnail)} : {}) }));
      if (!meta.videos.length) meta.videos = [{id:`${id}:1:1`,title:'Episode 1',season:1,episode:1,released:UNKNOWN_DATE}];
    } else {
      meta.videos = [{ id:`${id}:1:1`, title:'Episode 1', season:1, episode:1, released:UNKNOWN_DATE }];
    }
  }
  return meta;
}

export function addonBase(repository = '') {
  const [owner, repo] = repository.split('/');
  if (!owner || !repo) return '';
  // User/organization site repositories deploy at the domain root.
  return `${owner.toLowerCase()}.github.io${repo.toLowerCase() === `${owner.toLowerCase()}.github.io` ? '' : `/${repo}`}`;
}

const request = async (address) => {
  const res = await fetch(address, { signal: AbortSignal.timeout(4500), headers: { 'User-Agent':'henguys-metadata/1.1', Accept:'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};

export async function fetchDetails(p) {
  if (KITSU.test(p.id)) {
    const d = await request(`https://kitsu.io/api/edge/anime/${p.id.slice(6)}`);
    const a = d?.data?.attributes;
    if (!a) throw new Error('Kitsu returned no anime record');
    // Some adult titles have episodeCount=null; unknown count stays at one
    // instead of inventing episodes that might not exist.
    const episodes = [];
    // Fetch up to 60 real episode records for titles that expose them.
    // Many adult entries have only a handful of episodes; cap requests per title.
    for (let offset=0; offset < Math.min(a.episodeCount || 0, 60); offset+=20) {
      try {
        const page = await request(`https://kitsu.io/api/edge/anime/${p.id.slice(6)}/episodes?page[limit]=20&page[offset]=${offset}&sort=number`);
        for (const e of page?.data || []) {
          const v=e.attributes || {};
          if (Number.isInteger(v.number) && v.number>0) episodes.push({
            number:v.number, title:v.canonicalTitle, airdate:v.airdate,
            synopsis:v.synopsis, thumbnail:v.thumbnail?.original,
          });
        }
        if ((page?.data || []).length < 20) break;
      } catch { break; } // If episode service is down, the title metadata still works.
    }
    return {
      episodeCount: a.episodeCount, episodes,
      startDate: a.startDate,
      synopsis: a.synopsis,
      rating: a.averageRating,
      poster: a.posterImage?.large || a.posterImage?.original,
      cover: a.coverImage?.large || a.coverImage?.original,
    };
  }
  if (IMDB.test(p.id)) {
    const d = await request(`https://v3-cinemeta.strem.io/meta/${p.type}/${p.id}.json`);
    const m = d?.meta;
    if (!m || m.id !== p.id) throw new Error('Cinemeta metadata not found');
    return {
      startDate: m.released,
      synopsis: m.description,
      poster: m.poster,
      cover: m.background,
      videos: m.videos,
    };
  }
  return {};
}

export async function readCatalogPreviews(dist) {
  const manifest = JSON.parse(await readFile(join(dist, 'manifest.json'), 'utf8'));
  const previews = new Map();
  for (const { type, id } of manifest.catalogs || []) {
    const catalog = JSON.parse(await readFile(join(dist, 'catalog', type, `${id}.json`), 'utf8'));
    for (const m of catalog.metas || []) {
      if (!isSupportedId(m.id)) throw new Error(`No Torrentio-compatible ID for ${m.name}: ${m.id}`);
      if (m.type !== type) throw new Error(`Catalog type mismatch: ${m.id}`);
      // Same item appearing in Top, Recent, All must have one consistent detail file.
      if (!previews.has(`${type}/${m.id}`)) previews.set(`${type}/${m.id}`, m);
    }
  }
  return { manifest, previews };
}

export async function writeMetadata({ dist='dist', cache='cache/metadata-v1.json', repository='', maxLookups=100, fetcher=fetchDetails, now=Date.now(), log=console.log } = {}) {
  const { manifest, previews } = await readCatalogPreviews(dist);
  let detailCache = {};
  try { detailCache = JSON.parse(await readFile(cache, 'utf8')); } catch { /* first build */ }
  const stats = { records:previews.size, enriched:0, requested:0, fallback:0, failures:0 };
  // Prioritize cached data; don't block a successful publish on an external service outage.
  let failuresInRow=0;
  for (const [key, p] of previews) {
    let entry = detailCache[key];
    const expired = !entry?.checked || now - entry.checked > (entry.failed ? 7 : 30) * 86400000;
    if (expired && stats.requested < maxLookups && failuresInRow < 5) {
      stats.requested++;
      try { entry = { checked: now, data: await fetcher(p) }; detailCache[key] = entry; failuresInRow=0; }
      catch(e) { stats.failures++; failuresInRow++; entry={checked:now,failed:true,data:{}}; detailCache[key]=entry; log(`Metadata lookup failed for ${p.id}: ${e.message}`); }
      // Small politeness delay between calls to Kitsu/Cinemeta.
      if (maxLookups && process.env.NO_LOOKUP_DELAY !== '1') await new Promise(r => setTimeout(r, 200));
    }
    const details = entry?.data || {};
    const meta = makeMeta(p, details);
    if (Object.keys(details).length) stats.enriched++; else stats.fallback++;
    const dir = join(dist, 'meta', p.type);
    await mkdir(dir, { recursive:true });
    await writeFile(join(dir, `${p.id}.json`), JSON.stringify({meta}));
  }
  manifest.resources = ['catalog', { name:'meta', types:manifest.types, idPrefixes:SUPPORTED }];
  manifest.idPrefixes = SUPPORTED;
  manifest.version = `1.1.${Math.floor(now/86400000)}`;
  await writeFile(join(dist, 'manifest.json'), JSON.stringify(manifest, null, 2));
  await mkdir(join(cache, '..'), { recursive:true });
  await writeFile(cache, JSON.stringify(detailCache));
  const base = addonBase(repository);
  if (base) {
    // Fix original builder's URL calculation: HenGuys.github.io is a root Pages site.
    const link = `https://${base}/manifest.json`;
    await writeFile(join(dist, 'index.html'), `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Hentai Kitsu Bridge</title></head><body style="font-family:sans-serif;max-width:620px;margin:3em auto;padding:1em"><h1>Hentai Kitsu Bridge</h1><p>18+ catalog with metadata and episode IDs. Torrentio or another stream addon must be installed separately.</p><p><a href="stremio://${base}/manifest.json">Install in Stremio</a></p><p>Manifest: <a href="${link}">${link}</a></p></body></html>`);
  }
  await writeFile(join(dist, 'metadata-status.json'), JSON.stringify({ ...stats, generatedAt:new Date(now).toISOString() }, null, 2));
  await validateStaticAddon(dist);
  log(`Metadata ready: ${JSON.stringify(stats)}`);
  return stats;
}

export async function validateStaticAddon(dist='dist') {
  const { manifest, previews } = await readCatalogPreviews(dist);
  if (!manifest.resources.some(r => (typeof r === 'string' ? r : r.name) === 'meta')) throw new Error('Manifest has no meta resource');
  for (const [key, p] of previews) {
    const [type, id] = key.split('/');
    const { meta } = JSON.parse(await readFile(join(dist, 'meta', type, `${id}.json`), 'utf8'));
    if (!meta || meta.id !== id || meta.type !== type || !meta.name) throw new Error(`Invalid metadata: ${key}`);
    if (type !== 'movie') {
      if (!Array.isArray(meta.videos) || !meta.videos.length) throw new Error(`Missing episodes: ${key}`);
      for (const ep of meta.videos) {
        if (!ep.id || !ep.title || !ep.released) throw new Error(`Invalid episode: ${key}`);
        const correct = id.startsWith('kitsu:') ? new RegExp(`^${id}:\\d+$`) : new RegExp(`^${id}:\\d+:\\d+$`);
        if (!correct.test(ep.id)) throw new Error(`Wrong stream ID ${ep.id} in ${key}`);
      }
    }
  }
  return { catalogEntries: previews.size, types: manifest.types };
}
