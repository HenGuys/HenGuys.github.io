import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {makeMeta, addonBase, isSupportedId, writeMetadata, validateStaticAddon} from '../scripts/metadata-core.mjs';

test('supports Kitsu/IMDb; rejects identifiers Torrentio cannot receive', () => {
  assert.ok(isSupportedId('kitsu:42766'));
  assert.ok(isSupportedId('tt1234567'));
  for (const id of ['kitsu:','kitsu:foo','mal:123','anilist:123','x:y']) assert.equal(isSupportedId(id),false);
});

test('Kitsu IDs provide per-episode stream IDs, not just posters', () => {
  const meta = makeMeta({id:'kitsu:42766',type:'anime',name:'Example Anime',poster:'https://example.com/p.jpg'},
    {episodeCount:3,startDate:'2020-01-01',synopsis:'Some text'});
  assert.deepEqual(meta.videos.map(v=>v.id), ['kitsu:42766:1','kitsu:42766:2','kitsu:42766:3']);
  assert.equal(meta.videos[0].released, '2020-01-01T00:00:00.000Z');
  assert.equal(meta.description,'Some text');
});

test('IMDb series and movies use supported Stremio video conventions', () => {
  const s = makeMeta({id:'tt1234567',type:'series',name:'A series'});
  assert.equal(s.videos[0].id,'tt1234567:1:1');
  const movie = makeMeta({id:'tt7654321',type:'movie',name:'A movie'});
  assert.equal(movie.videos,undefined);
});

test('GitHub Pages root URL correctly handles username.github.io repo', () => {
  assert.equal(addonBase('HenGuys/HenGuys.github.io'), 'henguys.github.io');
  assert.equal(addonBase('person/my-addon'), 'person.github.io/my-addon');
});

test('full offline overlay builds metadata matching every catalog item', async () => {
  const root=await mkdtemp(join(tmpdir(), 'henbridge-test-'));
  try {
    const dist=join(root,'dist'), cache=join(root,'cache','metadata-v1.json');
    await mkdir(join(dist,'catalog','anime'), {recursive:true});
    await mkdir(join(dist,'catalog','movie'), {recursive:true});
    const catalogs=[{type:'anime',id:'hkb-top',name:'Top'},{type:'movie',id:'hkb-top',name:'Top'}];
    await writeFile(join(dist,'manifest.json'),JSON.stringify({id:'test',types:['anime','movie'],resources:['catalog'],catalogs}));
    await writeFile(join(dist,'catalog','anime','hkb-top.json'),JSON.stringify({metas:[{id:'kitsu:42766',type:'anime',name:'Example',poster:'https://example.com/p.jpg'}]}));
    await writeFile(join(dist,'catalog','movie','hkb-top.json'),JSON.stringify({metas:[{id:'tt7654321',type:'movie',name:'Movie'}]}));
    const stats=await writeMetadata({dist,cache,repository:'HenGuys/HenGuys.github.io', maxLookups:2,fetcher:async p=>p.type==='anime'? {episodeCount:2,startDate:'2020-01-01'} : {startDate:'2021-01-01'},log:()=>{}});
    assert.equal(stats.records,2);
    const m=JSON.parse(await readFile(join(dist,'manifest.json'),'utf8'));
    assert.ok(m.resources.some(r=>r.name==='meta'));
    const d=JSON.parse(await readFile(join(dist,'meta','anime','kitsu:42766.json'),'utf8'));
    assert.equal(d.meta.videos[1].id,'kitsu:42766:2');
    await validateStaticAddon(dist);
    assert.match(await readFile(join(dist,'index.html'),'utf8'), /https:\/\/henguys\.github\.io\/manifest\.json/);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('fallback detail includes a playable-format Kitsu episode without network access', async () => {
  const root=await mkdtemp(join(tmpdir(),'henbridge-fallback-'));
  try {
    const dist=join(root,'dist');
    await mkdir(join(dist,'catalog','anime'),{recursive:true});
    await writeFile(join(dist,'manifest.json'),JSON.stringify({id:'test',types:['anime'],resources:['catalog'],catalogs:[{type:'anime',id:'all'}]}));
    await writeFile(join(dist,'catalog','anime','all.json'),JSON.stringify({metas:[{id:'kitsu:46028',name:'Another Anime',type:'anime'}]}));
    await writeMetadata({dist, cache:join(root,'cache','meta.json'),maxLookups:0,log:()=>{}});
    const {meta}=JSON.parse(await readFile(join(dist,'meta','anime','kitsu:46028.json'),'utf8'));
    assert.equal(meta.videos[0].id,'kitsu:46028:1');
    assert.equal(meta.videos.length,1);
    assert.equal(meta.videos[0].released,'1970-01-01T00:00:00.000Z');
  } finally { await rm(root,{recursive:true,force:true}); }
});
