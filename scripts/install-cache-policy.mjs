// Minimal, idempotent installer. Patches the original repository's build.mjs
// rather than replacing its matching algorithm, source catalogs or settings.
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const MARKER = '// HenGuys cache refresh policy v3';
const START = 'const now = Date.now(); let lookups = 0, deferred = 0;';
const END = 'if (deferred) console.log(`${deferred} titles deferred to the next run (MAX_LOOKUPS_PER_RUN=${MAX_LOOKUPS}).`);';
const IMPORT = "import { refreshQueue, applyMatchRefresh } from './scripts/cache-policy.mjs';";
const REPLACEMENT = `${MARKER}
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
console.log('CACHE REFRESH SUMMARY', JSON.stringify(refreshStats));`;
export function patchSource(source) {
  if (source.includes(MARKER)) return {source, changed:false};
  if (source.includes(IMPORT)) throw new Error('Partial cache patch detected. Refusing to duplicate imports.');
  const first=source.indexOf(START), last=source.indexOf(END);
  if (first < 0 || last < first || source.indexOf(START, first+1) !== -1 || source.indexOf(END, last+1) !== -1) {
    throw new Error('Unknown build.mjs version: original cache loop not found uniquely; original left untouched.');
  }
  const next=source.slice(0,first)+REPLACEMENT+source.slice(last+END.length);
  const importPoint=next.indexOf('\n', next.indexOf("from 'node:fs/promises'"));
  if (importPoint === -1) throw new Error('Could not locate original fs import');
  return {source:next.slice(0,importPoint+1)+IMPORT+'\n'+next.slice(importPoint+1),changed:true};
}
export async function install(path='build.mjs') {
  const source=await readFile(path, 'utf8');
  const result=patchSource(source);
  if (result.changed) {await writeFile(path,result.source);console.log('Installed cache refresh policy v3 into build.mjs');}
  else console.log('Cache refresh policy v3 already installed');
  return result.changed;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await install();
}
