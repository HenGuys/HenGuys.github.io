// HenGuys cache refresh policy v3.
// Pure, offline-testable helpers; no remote API calls.
export const POLICY_VERSION = 3;
const DAY = 86_400_000;
const DEFAULT_MATCH_TTL_DAYS = 14;
const DEFAULT_MISS_TTL_DAYS = 3;
const DEFAULT_RETRY_HOURS = 48;

export function supportedMatch(p) {
  if (!p || typeof p.id !== 'string') return false;
  if (p.id.startsWith('kitsu:')) return /^kitsu:[1-9]\d*$/.test(p.id);
  return /^tt\d{7,10}$/.test(p.id);
}

export function refreshQueue({ catalogs, cache, norm, pickId, now = Date.now(), env = {} }) {
  const matchedDays = Math.max(1, Number(env.CACHE_MATCH_TTL_DAYS) || DEFAULT_MATCH_TTL_DAYS);
  const missDays = Math.max(1, Number(env.CACHE_MISS_TTL_DAYS) || DEFAULT_MISS_TTL_DAYS);
  const retryHours = Math.max(1, Number(env.CACHE_RETRY_COOLDOWN_HOURS) || DEFAULT_RETRY_HOURS);
  const forceAll = env.CACHE_REFRESH_MODE === 'all';
  const forceTitles = new Set(String(env.CACHE_FORCE_TITLES || '').split(/[,\n]/).map(norm).filter(Boolean));
  const candidates = [];
  const seen = new Set();
  for (const items of Object.values(catalogs)) {
    for (const item of items) {
      const key = norm(item.name);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const old = cache[key];
      const current = old && pickId(old);
      const matched = supportedMatch(current);
      const checked = Number(old?.checked) || 0;
      const lastAttempt = Number(old?.lastAttempt) || 0;
      const forcedTitle = forceTitles.has(key);
      const forced = forceAll || forcedTitle;
      const versionIsOld = old && old.policyVersion !== POLICY_VERSION;
      const expired = old && now - checked >= (matched ? matchedDays : missDays) * DAY;
      const invalid = old && current && !matched;
      const shouldRetry = !lastAttempt || now - lastAttempt >= retryHours * 3_600_000;
      if (!(forced || !old || ((versionIsOld || expired || invalid) && shouldRetry))) continue;
      let priority = 3;
      if (forcedTitle) priority = 0;
      else if (invalid) priority = 1;
      else if (!old) priority = 2;
      else if (matched) priority = 3;
      else priority = 4;
      candidates.push({key, title:item.name, reason: forcedTitle ? 'forced-title' : forceAll ? 'forced-all' : !old ? 'new' : invalid ? 'invalid-id' : versionIsOld ? 'legacy-cache' : matched ? 'expired-match' : 'expired-miss', priority, age: lastAttempt || checked || 0});
    }
  }
  // Oldest first: avoids refreshing the same first catalog on every run.
  return candidates.sort((a,b) => a.priority - b.priority || a.age - b.age || a.key.localeCompare(b.key));
}

export function applyMatchRefresh({previous, incoming, pickId, now=Date.now()}) {
  const before = previous && supportedMatch(pickId(previous)) ? pickId(previous) : null;
  const after = incoming && supportedMatch(pickId(incoming)) ? pickId(incoming) : null;
  if (!after) {
    // An API timeout/no-result must not overwrite the last *valid* match.
    if (before) {
      return {entry:{...previous, policyVersion:POLICY_VERSION, lastAttempt:now, lastOutcome:'retained-existing'}, outcome:'retained-existing'};
    }
    return {entry:{ids:{},title:null,poster:null,...incoming,ids:incoming?.ids || {},checked:now,lastAttempt:now,policyVersion:POLICY_VERSION,lastOutcome:'miss'},outcome:'miss'};
  }
  const entry = {...incoming, ids:{...incoming.ids}, checked:now,lastAttempt:now,policyVersion:POLICY_VERSION,lastOutcome:'matched'};
  // Keep a verified IMDb crosswalk only if the Kitsu identity did not change.
  // Never splice a stale IMDb ID onto a different anime.
  if (previous?.ids?.kitsu && String(previous.ids.kitsu) === String(entry.ids.kitsu) &&
      /^tt\d{7,10}$/.test(String(previous?.ids?.imdb || '')) && !entry.ids.imdb) {
    entry.ids.imdb = previous.ids.imdb;
    if (['series','movie'].includes(previous.imdbType)) entry.imdbType = previous.imdbType;
  }
  return {entry, outcome:before?.id === after.id ? 'revalidated' : before ? 'updated-id' : 'new-match'};
}
