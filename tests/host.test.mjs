import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostScope, plain } from './runtime.mjs';

const h = await hostScope();
for (const kind of ['stop','length','max-tokens','tool-calls','content-filter','aborted','error','new-dsh-reason']) test('DSH stream finish contract: '+kind, () => {
  const result = h.finishFailure({ kind });
  if (kind === 'stop') assert.equal(result, null); else assert.equal(typeof result, 'string');
  if (kind === 'new-dsh-reason') assert.match(result, /unsupported/);
});
test('stream assembler orders text blocks and ignores reasoning', () => {
  const a = h.accumulateText();
  for (const chunk of [{ type: 'text-delta', index: 2, text: 'tail' },{ type: 'reasoning-delta', index: 1, text: 'secret' },{ type: 'text-delta', index: 0, text: 'head' },{ type: 'text-delta', index: 0, text: '!' },{ type: 'block-start', blockType: 'tool-call' },{ type: 'finish', reason: { kind: 'stop' } }]) a.push(chunk);
  assert.equal(a.text(), 'head!\ntail'); assert.ok(a.openedToolCall()); assert.equal(a.reason().kind, 'stop');
  assert.match(h.finishFailure(undefined), /finish event/); assert.match(h.finishFailure({ kind: 'error', failure: { message: 'provider error' } }), /provider error/);
});
test('LLM stream contract includes isolated purpose, messages, token cap and signal', async () => {
  let options;
  const llm = { async *stream(opts) { options = opts; yield { type: 'text-delta', index: 0, text: 'answer' }; yield { type: 'finish', reason: { kind: 'stop' } }; } };
  assert.equal(await h.callModel(llm, { provider: 'p', model: 'm', reasoningEffort: 'high' }, 'system', 'draft'), 'answer');
  assert.equal(options.purpose, 'prompt-forge'); assert.equal(options.maxTokens, 4096); assert.equal(options.reasoningEffort, 'high');
  assert.deepEqual(plain(options.messages), [{ role: 'user', content: [{ type: 'text', text: 'draft' }] }]); assert.ok(options.signal instanceof AbortSignal);
  await assert.rejects(h.callModel({ async *stream() { throw Error('network changed'); } }, {}, '', ''), /network changed/);
});
test('route selection contract covers missing default and removed provider', () => {
  const llm = { listProviders: () => [{ id: 'p' }] }, state = h.normalizeState({ provider: 'p', model: 'm', reasoningEffort: 'high' });
  assert.deepEqual(plain(h.resolveRoute(llm, null, state)), { provider: 'p', model: 'm', reasoningEffort: 'high' });
  assert.throws(() => h.resolveRoute(llm, null, h.normalizeState({})), /no model/);
  assert.deepEqual(plain(h.resolveRoute(llm, { currentSelection: () => ({ provider: 'fallback', model: 'm' }) }, h.normalizeState({ provider: 'removed', model: 'm' }))), { provider: 'fallback', model: 'm' });
});
test('HTTP request contract: empty, malformed JSON, error and oversized payload', async () => {
  let req = new EventEmitter(), promise = h.readJsonBody(req); req.emit('end'); assert.deepEqual(plain(await promise), {});
  req = new EventEmitter(); promise = h.readJsonBody(req); req.emit('data', Buffer.from('{')); req.emit('end'); await assert.rejects(promise);
  req = new EventEmitter(); promise = h.readBody(req); req.emit('error', Error('stream broken')); await assert.rejects(promise, /stream broken/);
  req = new EventEmitter(); let destroyed = false; req.destroy = () => { destroyed = true; }; promise = h.readBody(req);
  req.emit('data', Buffer.alloc(512 * 1024 + 1)); await assert.rejects(promise, /exceeds/); assert.ok(destroyed);
});
test('settings persistence: missing/corrupt document, atomic save and write failure', async () => {
  const home = await mkdtemp(join(tmpdir(), 'pf-test-'));
  try {
    const scope = await hostScope({ process: { env: { DSH_HOME: home } } });
    assert.equal((await scope.readState()).skillMode, 'balanced');
    await writeFile(join(home, 'prompt-forge.json'), '{broken'); assert.equal((await scope.readState()).referenceFiles, true);
    await scope.saveState(scope.normalizeState({ model: 'm' })); assert.equal(JSON.parse(await readFile(join(home, 'prompt-forge.json'))).model, 'm');
    await rm(join(home, 'prompt-forge.json')); await mkdir(join(home, 'prompt-forge.json'));
    await assert.rejects(scope.saveState(scope.normalizeState({})));
  } finally { await rm(home, { recursive: true, force: true }); }
});
test('cancellation contract: pre-abort and async rejection', async () => {
  await assert.rejects(h.withSignal(() => new Promise(() => {}), AbortSignal.abort(Error('cancelled'))), /cancelled/);
  await assert.rejects(h.withSignal(() => Promise.reject(Error('lookup failed')), new AbortController().signal), /lookup failed/);
});
test('reference services: missing agent, missing index/catalog and denied skill policies', async () => {
  const signal = new AbortController().signal;
  await assert.rejects(h.resolveFileReferences({ get: () => undefined }, undefined, ['src/a'], signal), /agent|session|index/);
  await assert.rejects(h.resolveSkillReferences({ get: () => undefined }, undefined, '.', ['skill'], signal), /agent/);
  await assert.rejects(h.resolveSkillReferences({ get: () => undefined }, {}, '.', ['skill'], signal), /catalog/);
  assert.deepEqual(plain(await h.listAvailableSkills({ get: () => undefined }, {}, '.', signal)), []);
  assert.deepEqual(plain(await h.listAvailableSkills({ get: () => ({ list: async () => { throw Error('catalog offline'); } }) }, {}, '.', signal)), []);
  const service = { list: async () => [{ name: 'allowed', invocation: { modelInvocable: true, userInvocable: true } }, { name: 'denied', invocation: { modelInvocable: true, userInvocable: false } }] };
  assert.deepEqual(plain(await h.resolveSkillReferences({ get: () => service }, {}, '.', ['allowed','denied'], signal)).map(s => s.name), ['allowed']);
});

async function call(route, method, raw) {
  const req = new EventEmitter(); req.method = method; req.destroy = () => {};
  return new Promise((resolve, reject) => {
    const res = { writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body) { resolve({ status: this.status, headers: this.headers, body, json: body ? JSON.parse(body) : null }); } };
    route.handler(req,res);
    setImmediate(() => { if (raw !== undefined) req.emit('data', Buffer.from(raw)); req.emit('end'); });
  });
}
test('webServer route contract: methods, malformed requests, unavailable LLM and report sink', async () => {
  const home = await mkdtemp(join(tmpdir(),'pf-routes-'));
  try {
    const logs = [], scope = await hostScope({ process: { env: { DSH_HOME: home }, stderr: { write: text => logs.push(text) } } });
    const routes = new Map(), disposes = [];
    const services = {};
    scope.apply({ get: name => services[name], inject(names, callback) {
      assert.deepEqual(plain(names), ['webServer']);
      callback({ effect(fn) { disposes.push(fn()); }, webServer: { register(route) { routes.set(route.path,route); return () => routes.delete(route.path); } } });
    } });
    const state = routes.get('/prompt-forge/state'), optimize = routes.get('/prompt-forge/optimize'), report = routes.get('/prompt-forge/report');
    assert.equal((await call(state,'HEAD')).body, undefined);
    for (const route of [state,optimize,report]) { const r = await call(route,'DELETE'); assert.equal(r.status,405); assert.ok(r.headers.allow); }
    assert.equal((await call(state,'POST','{')).status,400);
    assert.equal((await call(optimize,'POST','{')).status,400);
    assert.equal((await call(optimize,'POST','{}')).status,400);
    const fail = await call(optimize,'POST','{"text":"draft"}'); assert.match(fail.json.error,/LLM service/);
    assert.equal((await call(report,'POST','{')).status,204);
    assert.equal((await call(report,'POST','{"message":"client failure"}')).status,200); assert.match(logs[0],/client failure/);
    services.llm = { listProviders: () => [{ id: 'p' }], async *stream() { yield { type: 'text-delta', index: 0, text: 'rewritten' }; yield { type: 'finish', reason: { kind: 'stop' } }; } };
    services.agentDefaultModel = { currentSelection: () => ({ provider: 'p', model: 'm' }) };
    assert.equal((await call(state,'POST','{"referenceFiles":false,"skillMode":"off"}')).status,200);
    assert.equal((await call(optimize,'POST',JSON.stringify({ text: 'x'.repeat(60001) }))).status,400);
    assert.equal((await call(optimize,'POST','{"text":"draft"}')).json.prompt,'rewritten');
    await rm(join(home,'prompt-forge.json')); await mkdir(join(home,'prompt-forge.json'));
    const save = await call(state,'POST','{"model":"m"}'); assert.equal(save.status,500); assert.match(save.json.error,/could not write/);
    for (const dispose of disposes) dispose(); assert.equal(routes.size,0);
  } finally { await rm(home,{recursive:true,force:true}); }
});

test('request bodies must be objects; arrays, null and primitives are rejected', async () => {
  for (const value of ['null','[]','1','"text"']) {
    const req=new EventEmitter(), promise=h.readJsonBody(req); req.emit('data',Buffer.from(value));req.emit('end'); await assert.rejects(promise,/JSON object/);
  }
});
test('late catalog failure is contained and skills without descriptions are usable', async () => {
  const signal=new AbortController().signal;
  const skills=await h.listAvailableSkills({get:()=>({list:async()=>[{name:'allowed',invocation:{modelInvocable:true,userInvocable:true}}]})},{},'.',signal);
  assert.deepEqual(plain(skills),['allowed']);
});

test('managed existing file groups merge without duplicate additions', () => {
  const prompt='Review these files.\n\nFiles this task needs:\n@src/a.js\n@src/a.js\n';
  const result=h.appendReferences(prompt,[{path:'src/a.js',token:'@src/a.js'},{path:'src/b.js',token:'@src/b.js'}],[]);
  assert.equal((result.prompt.match(/@src\/a.js/g)??[]).length,1);
  assert.equal(result.files.length,1); assert.equal(result.files[0].path,'src/b.js');
});
