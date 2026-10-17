import test from 'node:test';
import assert from 'node:assert/strict';
import { refreshQueue, applyMatchRefresh, supportedMatch } from '../scripts/cache-policy.mjs';
import { patchSource } from '../scripts/install-cache-policy.mjs';
const now=1_900_000_000_000;
const day=86400000;
const pickId=e=>e?.ids?.kitsu ? {id:`kitsu:${e.ids.kitsu}`} : e?.ids?.imdb ? {id:e.ids.imdb} : null;
const norm=s=>s.toLowerCase().trim();
const item=name=>({name});
const e=(id,checked,other={})=>({ids:id?{kitsu:id}:{}, checked, ...other});
function queue(cache,env={},names=['Alpha','Beta']) {
 return refreshQueue({catalogs:{all:names.map(item),recent:[item('Alpha')]},cache,norm,pickId,now,env});
}
test('previously matched legacy IDs are revalidated, never permanently skipped',()=>{
 const q=queue({alpha:e('10',now-day),beta:e('20',now-day*3)});
 assert.equal(q.length,2);
 assert.deepEqual(q.map(x=>x.key),['beta','alpha']);
 assert.equal(q[0].reason,'legacy-cache');
});
test('refreshed matches obey TTL and do not starve other titles',()=>{
 const q=queue({alpha:e('10',now-day, {policyVersion:3,lastAttempt:now-day}),
                 beta:e('20',now-day*20,{policyVersion:3,lastAttempt:now-day*20})});
 assert.deepEqual(q.map(x=>x.key),['beta']);
});
test('retry cooldown keeps an unavailable API from being spammed',()=>{
 const q=queue({alpha:e('10',now-day*100,{policyVersion:3,lastAttempt:now-3600000})}, {}, ['Alpha']);
 assert.equal(q.length,0);
});
test('unmatched entries retry within three days instead of thirty',()=>{
 const q=queue({alpha:e(null,now-day*4,{policyVersion:3})},{},['Alpha']);
 assert.equal(q.length,1);
 assert.equal(q[0].reason,'expired-miss');
});
test('forced title refresh takes precedence over ordinary matches',()=>{
 const q=queue({alpha:e('10',now-day,{policyVersion:3}),beta:e('20',now-day,{policyVersion:3})},
   {CACHE_FORCE_TITLES:'Beta'});
 assert.deepEqual(q.map(x=>x.key),['beta']);
});
test('manual ALL mode covers matches even if within TTL',()=>{
 const q=queue({alpha:e('10',now-day,{policyVersion:3})}, {CACHE_REFRESH_MODE:'all'},['Alpha']);
 assert.equal(q.length,1);
});
test('a new verified match can replace an old cached ID',()=>{
 const r=applyMatchRefresh({previous:e('10',now-day),incoming:e('20',now),pickId,now});
 assert.equal(r.outcome,'updated-id'); assert.equal(r.entry.ids.kitsu,'20');assert.equal(r.entry.policyVersion,3);
});
test('failed matching preserves an old valid match, but records the retry time',()=>{
 const r=applyMatchRefresh({previous:e('10',now-day),incoming:e(null,now),pickId,now});
 assert.equal(r.outcome,'retained-existing');assert.equal(r.entry.ids.kitsu,'10');
 assert.equal(r.entry.lastAttempt,now);
});
test('old crosswalk retained only if Kitsu ID is unchanged',()=>{
 const prev={ids:{kitsu:'10',imdb:'tt1234567'},imdbType:'series',checked:now-day};
 const same=applyMatchRefresh({previous:prev,incoming:e('10',now),pickId,now}).entry;
 const changed=applyMatchRefresh({previous:prev,incoming:e('11',now),pickId,now}).entry;
 assert.equal(same.ids.imdb,'tt1234567');assert.equal(changed.ids.imdb,undefined);
});
test('invalid cached IDs are candidates for repair',()=>{
 assert.equal(supportedMatch({id:'kitsu:garbage'}),false);
 const q=queue({alpha:e('foo',now-day,{policyVersion:3})},{},['Alpha']);
 assert.equal(q[0].reason,'invalid-id');
});
test('installer changes only matching loop and is safe to run twice',()=>{
 const sample=`import { mkdir, writeFile, readFile } from 'node:fs/promises';\n`+
 `const START='before';\nconst now = Date.now(); let lookups = 0, deferred = 0;\n`+
 `for(const items of Object.values(catalogs)) { doOldStuff(); }\n`+
 'if (deferred) console.log(`${deferred} titles deferred to the next run (MAX_LOOKUPS_PER_RUN=${MAX_LOOKUPS}).`);\n'+
 `const END='after';\n`;
 const p=patchSource(sample);assert.equal(p.changed,true);
 assert.match(p.source,/refreshQueue\(/);
 assert.match(p.source,/const END='after'/);
 assert.equal(patchSource(p.source).changed,false);
 assert.throws(()=>patchSource('wrong file'),/Unknown build.mjs/);
});
