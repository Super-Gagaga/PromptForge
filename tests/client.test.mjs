import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clientScope, documentFixture, find, tick, plain } from './runtime.mjs';

test('settings HTTP contract: invalid JSON, null, HTTP failure, retry and stable snapshots', async () => {
  for (const response of [{ ok: false, status: 503 }, { ok: true, json: async () => null }, { ok: true, json: async () => { throw Error('invalid JSON'); } }]) {
    let calls = 0;
    const c = await clientScope({ fetch: async () => { calls++; return calls === 1 ? response : { ok: true, json: async () => ({ model: 'recovered' }) }; } });
    const before = c.settingsStore.get(); assert.equal(c.settingsStore.get(), before);
    c.settingsStore.ensure(); c.settingsStore.ensure(); await tick();
    assert.equal(calls, 1); assert.ok(c.settingsStore.error());
    c.settingsStore.ensure(); await tick(); assert.equal(c.settingsStore.get().value.model, 'recovered'); assert.equal(c.settingsStore.error(), null);
    let changes = 0; const off = c.settingsStore.subscribe(() => changes++); off();
    c.settingsStore.patch({ model: 'new' }); await tick(); assert.equal(changes, 0);
  }
});
test('modelCatalog Remote contract: rejection, invalid envelope, caching and no accidental selection', async () => {
  for (const reply of [null, {}, { ok: false, error: { message: 'catalog changed' } }]) {
    const c = await clientScope(); c.catalogStore.ensure({ remote: { session: { modelCatalog: async () => reply } } }); await tick();
    assert.equal(c.catalogStore.get().status, 'error'); assert.ok(c.catalogStore.get().error);
  }
  const c = await clientScope(); c.catalogStore.ensure(null); assert.equal(c.catalogStore.get().status, 'idle');
  let calls = 0; c.catalogStore.ensure({ remote: { session: { modelCatalog: async () => { calls++; throw Error('offline'); } } } }); await tick();
  assert.match(c.catalogStore.get().error, /offline/); c.catalogStore.ensure({}); assert.equal(calls, 1);
});
for (const phase of ['submitting', 'adjudicating']) test('composer contract: locked '+phase+' never requests optimization', async () => {
  let requests = 0;
  const c = await clientScope({ fetch: async () => { requests++; } });
  const node = c.harness.mount(c.PromptForgeButton, { sessionId: 's', useInput: fn => fn({ draft: 'original', draftRev: 1, phase }), inputActions: { setDraft() { assert.fail('must not change draft'); } }, t: k => k });
  const button = find(node, n => n.type === 'button'); assert.ok(button.props.disabled); button.props.onClick(); await tick(); assert.equal(requests, 0);
});
for (const reply of [null, {}, { prompt: '' }, { prompt: 1 }, { prompt: '   ' }]) test('optimize response contract rejects '+JSON.stringify(reply), async () => {
  let changes = 0, reports = 0;
  const c = await clientScope({ fetch: async url => { if (url.endsWith('/report')) { reports++; throw Error('report offline'); } return { ok: true, status: 200, json: async () => reply }; } });
  const node = c.harness.mount(c.PromptForgeButton, { sessionId: 's', useInput: fn => fn({ draft: 'original', draftRev: 1, phase: 'idle' }), inputActions: { setDraft() { changes++; } }, t: k => k });
  find(node, n => n.type === 'button').props.onClick(); await tick(); assert.equal(changes, 0); assert.equal(reports, 1);
  assert.equal(find(c.harness.render(), n => n.type === 'button').props['data-failed'], 'true');
});
test('picker lifecycle: search, selection, Escape, outside click and listener cleanup', async () => {
  const dom = documentFixture(), c = await clientScope(dom), chosen = [];
  const props = { label: 'Model', searchPlaceholder: 'Search', onSelect: key => chosen.push(key), children: (choose, query) => ({ type: 'choice', props: { choose, query } }) };
  let node = c.harness.mount(c.Picker, props); find(node, n => n.type === 'button').props.onClick(); node = c.harness.render(); c.harness.flush();
  assert.equal(dom.listeners.size, 2); find(node, n => n.type === 'input').props.onChange({ target: { value: 'flash' } });
  node = c.harness.render(); assert.equal(find(node, n => n.type === 'choice').props.query, 'flash');
  dom.listeners.get('keydown')({ key: 'Enter' }); assert.equal(find(c.harness.render(), n => n.type === 'button').props['aria-expanded'], true);
  dom.listeners.get('keydown')({ key: 'Escape' }); assert.equal(find(c.harness.render(), n => n.type === 'button').props['aria-expanded'], false);
  find(c.harness.render(), n => n.type === 'button').props.onClick(); node = c.harness.render();
  node.props.ref.current = { contains: target => target === 'inside' };
  dom.listeners.get('pointerdown')({ target: 'inside' }); assert.equal(find(c.harness.render(), n => n.type === 'button').props['aria-expanded'], true);
  dom.listeners.get('pointerdown')({ target: 'outside' }); assert.equal(find(c.harness.render(), n => n.type === 'button').props['aria-expanded'], false);
  find(c.harness.render(), n => n.type === 'button').props.onClick(); node = c.harness.render();
  find(node, n => n.type === 'choice').props.choose('selected'); assert.deepEqual(chosen, ['selected']);
  c.harness.unmount(); assert.equal(dom.listeners.size, 0);
});
test('locale contract: complete dictionaries, interpolation and unknown-key fallback', async () => {
  const c = await clientScope(); assert.deepEqual(Object.keys(c.zh).sort(), Object.keys(c.en).sort());
  assert.equal(c.translate({ greeting: 'Hello {name} {missing}' })('greeting', { name: 'DSH' }), 'Hello DSH {missing}');
  assert.equal(c.translate({})('unknown'), 'unknown');
  assert.equal(c.referenceResultTip(k => k, { status: 'future' }), undefined);
});

test('model selection helpers and search cover removed/default/unavailable models', async () => {
  const c = await clientScope({ fetch: async (_, init) => ({ ok: true, json: async () => JSON.parse(init.body) }) }), t = c.translate(c.en);
  const catalog = { default: { provider: 'p', model: 'm' }, groups: [{ id: 'p', models: [{ id: 'm' }] }] };
  assert.equal(c.effectiveSelection(null,{}),null); assert.equal(c.effectiveSelection(catalog,undefined),null);
  assert.equal(c.effectiveSelection({},{}),null);
  assert.deepEqual(plain(c.effectiveSelection(catalog,{provider:'gone',model:'m'})),{provider:'p',model:'m'});
  assert.equal(c.modelName(catalog,{provider:'gone',model:'m'}),'gone / m');
  assert.equal(c.effortName(undefined,'',t),'Default'); assert.equal(c.effortName(undefined,'custom',t),'custom');
  assert.equal(c.appendedTip(t,null),undefined); assert.equal(c.appendedTip(t,{files:0,skills:0}),undefined);
  assert.match(c.appendedTip(t,{files:1,skills:1}),/1/);
  const many = { ...catalog, groups:[{ id:'p', models:Array.from({length:9},(_,i)=>({id:'m'+i,name:'Model '+i})) }] };
  const picker = c.ModelPicker({catalog:{value:many},settings:{provider:'',model:''},t});
  assert.ok(picker.props.searchPlaceholder);
  assert.ok(find(picker.props.children(()=>{},'no match'),n=>n.props?.className==='PF-menuEmpty'));
  assert.ok(find(picker.props.children(()=>{},'Model 3'),n=>n.props?.name==='Model 3'));
  picker.props.onSelect(''); await tick(); assert.equal(c.settingsStore.get().value.provider,'');
});
test('settings controls persist custom instruction/reset, file switch and effort independently', async () => {
  const saved = [], dom = documentFixture();
  const c = await clientScope({ ...dom, fetch: async (_,init) => { if(init?.method==='POST') {const data=JSON.parse(init.body); saved.push(data); return {ok:true,json:async()=>data};} return {ok:true,json:async()=>({provider:'',model:'',systemPrompt:'default',skillMode:'balanced',referenceFiles:true})}; } });
  c.settingsStore.ensure(); await tick();
  c.catalogStore.ensure({remote:{session:{modelCatalog:async()=>({ok:true,value:{groups:[],failures:[{id:'broken',message:'offline'}]}})}}}); await tick();
  let node = c.harness.mount(c.PromptForgeSettings,{t:k=>k}); c.harness.flush();
  const textarea = find(node,n=>n.type==='textarea'); textarea.props.onBlur();
  textarea.props.onChange({target:{value:'custom instruction'}}); node=c.harness.render();
  find(node,n=>n.type==='textarea').props.onBlur(); await tick(); assert.equal(saved.at(-1).systemPrompt,'custom instruction');
  find(c.harness.render(),n=>n.props?.className==='PF-ghost').props.onClick(); await tick(); assert.equal(saved.at(-1).systemPrompt,'');
  const reference = find(c.harness.render(),n=>n.type===c.ReferenceToggle); reference.props.onChange(false); await tick(); assert.equal(saved.at(-1).referenceFiles,false);
  const effort = find(c.harness.render(),n=>n.type===c.Picker && n.props.ariaLabel==='effort.heading'); effort.props.onSelect('high'); await tick(); assert.equal(saved.at(-1).reasoningEffort,'high');
  c.harness.render(); c.harness.flush(); c.harness.unmount();
});
test('catalog success publishes changes and unsubscribe removes listener', async () => {
  const c=await clientScope(); let changes=0; const off=c.catalogStore.subscribe(()=>changes++);
  c.catalogStore.ensure({remote:{session:{modelCatalog:async()=>({ok:true,value:{groups:[],failures:[]}})}}}); await tick(); assert.equal(changes,2); off(); assert.equal(c.catalogStore.get().status,'ready');
});
test('success timers and failure timer are cleaned on unmount', async () => {
  const timers = new Map(); let id=0;
  for (const success of [true,false]) {
    const c=await clientScope({setTimeout(fn,ms){timers.set(++id,{fn,ms});return id;},clearTimeout(key){timers.delete(key);},fetch:async()=>({ok:success,status:500,json:async()=>success?{prompt:'rewrite',files:['a'],skills:['s']}:{error:'failed'}})});
    const node=c.harness.mount(c.PromptForgeButton,{sessionId:'s',useInput:fn=>fn({draft:'original',draftRev:1,phase:'idle'}),inputActions:{setDraft(){}},t:k=>k}); c.harness.flush();
    find(node,n=>n.type==='button').props.onClick(); await tick(); c.harness.render(); c.harness.flush();
    const timer=[...timers.values()].find(t=>t.ms===(success?4000:2600)); assert.ok(timer); timer.fn(); c.harness.unmount(); assert.equal(timers.size,0);
  }
});

test('failure/reference subscriptions can mount, update and unsubscribe', async () => {
  const c=await clientScope(); c.harness.mount(()=>({failure:c.useLastFailure(),reference:c.useLastReferenceResult()}),{});
  c.setLastFailure('offline'); c.setLastReferenceResult({status:'partial'});
  assert.equal(c.harness.render().failure,'offline'); assert.equal(c.harness.render().reference.status,'partial');
  c.harness.unmount(); assert.doesNotThrow(()=>c.setLastFailure(null));
});
test('settings page exposes loading and catalog errors, with disabled empty choices', async () => {
  const c=await clientScope(); let settle;
  c.catalogStore.ensure({remote:{session:{modelCatalog:()=>new Promise(resolve=>{settle=resolve;})}}});
  let node=c.harness.mount(c.PromptForgeSettings,{t:k=>k}); assert.ok(find(node,n=>n.props?.children==='status.loading'));
  settle({ok:false,error:{message:'DSH catalog changed'}}); await tick(); node=c.harness.render(); assert.ok(find(node,n=>n.props?.children==='DSH catalog changed'));
  c.harness.unmount();
});
