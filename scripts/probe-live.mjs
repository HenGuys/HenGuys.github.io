// Run independently to distinguish broken addon routing from zero Torrentio matches.
// Optional TORRENTIO_BASE should be your actual configured Torrentio addon URL.
// Never print that URL: it can embed debrid credentials.
import { pathToFileURL } from 'node:url';
const DEFAULT = 'https://henguys.github.io';
const TIMEOUT_MS = 12000;

async function getJson(url,fetcher) {
  const response=await fetcher(url,{headers:{Accept:'application/json'},signal:AbortSignal.timeout(TIMEOUT_MS)});
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const value=await response.json();
  if (!value || typeof value!=='object') throw new Error('not JSON object');
  return value;
}

export async function probe({base=DEFAULT, torrentio='',fetcher=fetch, log=console.log, perCatalog=2}={}) {
  base=base.replace(/\/$/,'');torrentio=torrentio.replace(/\/$/,'');
  const report={manifest:false, catalogsChecked:0, titlesChecked:0, workingMeta:0,
    missingMeta:0, noEpisodes:0, streamChecks:0, streamWithResults:0, streamEmpty:0,
    streamErrors:0, failures:[], exampleRequests:[]};
  let manifest;
  try { manifest=await getJson(`${base}/manifest.json`,fetcher);report.manifest=true; }
  catch(e) {report.failures.push(`Manifest: ${e.message}`); log(JSON.stringify(report,null,2));return report;}
  if (!manifest.resources?.some(r=>(typeof r==='string'?r:r.name)==='meta')) report.failures.push('Manifest does not advertise meta');
  for (const c of manifest.catalogs || []) {
    let catalog;
    try {catalog=await getJson(`${base}/catalog/${c.type}/${encodeURIComponent(c.id)}.json`,fetcher);report.catalogsChecked++;}
    catch(e) {report.failures.push(`Catalog ${c.type}/${c.id}: ${e.message}`);continue;}
    for (const p of (catalog.metas || []).slice(0,perCatalog)) {
      report.titlesChecked++;
      let detail;
      try {
        detail=await getJson(`${base}/meta/${c.type}/${encodeURIComponent(p.id)}.json`,fetcher);
        if (detail.meta?.id!==p.id || detail.meta?.type!==c.type) throw new Error('meta identity mismatch');
        report.workingMeta++;
      } catch(e) {report.missingMeta++;report.failures.push(`Meta ${c.type}/${p.id}: ${e.message}`);continue;}
      const videoId=c.type==='movie' ? p.id : detail.meta?.videos?.[0]?.id;
      if (!videoId) {report.noEpisodes++;continue;}
      if (report.exampleRequests.length<4) report.exampleRequests.push(`/stream/${c.type}/${videoId}.json`);
      if (!torrentio) continue;
      report.streamChecks++;
      try {
        const streams=await getJson(`${torrentio}/stream/${c.type}/${encodeURIComponent(videoId)}.json`,fetcher);
        if (streams.streams?.length) report.streamWithResults++;
        else report.streamEmpty++;
      } catch(e) {report.streamErrors++;report.failures.push(`Torrentio ${c.type}/${videoId}: ${e.message}`);}
    }
  }
  log(JSON.stringify(report,null,2));
  return report;
}

if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const r=await probe({base:process.env.HENGUYS_BASE || DEFAULT,torrentio:process.env.TORRENTIO_BASE || ''});
  // Zero Torrentio results means no matches on that provider, not broken addon metadata.
  if (!r.manifest || r.missingMeta || r.noEpisodes || r.failures.some(f=>f.includes('Manifest does not')||f.startsWith('Catalog'))) process.exitCode=1;
}
