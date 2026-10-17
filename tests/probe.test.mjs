import test from 'node:test';
import assert from 'node:assert/strict';
import {probe} from '../scripts/probe-live.mjs';

const manifests={
 '/manifest.json':{resources:['catalog',{name:'meta',types:['series'],idPrefixes:['kitsu:','tt']}],catalogs:[{id:'all',type:'series'}]},
 '/catalog/series/all.json':{metas:[{id:'kitsu:22',type:'series',name:'A series'}]},
 '/meta/series/kitsu%3A22.json':{meta:{id:'kitsu:22',type:'series',name:'A series',videos:[{id:'kitsu:22:1',title:'Episode 1'}]}},
 '/stream/series/kitsu%3A22%3A1.json':{streams:[]},
};
const fakeFetch=async (url)=>{
  const path=new URL(url).pathname.replace(/^\/config-secret/, '');
  if (!Object.hasOwn(manifests,path))return {ok:false,status:404};
  return {ok:true,json:async()=>manifests[path]};
};
test('live diagnostic distinguishes valid routing from zero scraper results',async()=>{
  const r=await probe({base:'https://example.test',torrentio:'https://private.example/config-secret',fetcher:fakeFetch,log:()=>{}});
  assert.equal(r.workingMeta,1);
  assert.equal(r.missingMeta,0);
  assert.equal(r.streamChecks,1);
  assert.equal(r.streamEmpty,1);
  assert.equal(r.streamErrors,0);
  assert.ok(!JSON.stringify(r).includes('config-secret'));
});
