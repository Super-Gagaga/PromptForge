/**
 * dsh-prompt-forge — offline self-check.
 *
 * Loads the two built artifacts the way their real hosts do — the browser half
 * through the module-loader envelope with stub globals, the Host half as an ES
 * module — then drives one end-to-end optimization with a fake context. This
 * catches the failures that a plain syntax check cannot: a missing global in the
 * browser bundle, a slot registration missing its required key, a handler that
 * never answers, and a component that renders nothing or the wrong state.
 *
 *   node tools/selfcheck.mjs
 */

import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/* The Host half stores its document under DSH_HOME, so the check runs against
   throwaway homes: it must never read or write the real profile's settings, and
   one scenario must not inherit the previous scenario's stored selection. */
const sandboxHomes = [];
async function freshHome() {
  const home = await mkdtemp(join(tmpdir(), 'prompt-forge-selfcheck-'));
  sandboxHomes.push(home);
  process.env.DSH_HOME = home;
  return home;
}
await freshHome();
process.on('exit', () => {
  for (const home of sandboxHomes) rm(home, { recursive: true, force: true }).catch(() => {});
});

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFile(join(root, relative), 'utf8');

let checks = 0;
const check = (label, fn) => {
  fn();
  checks += 1;
  process.stdout.write(`  ok  ${label}\n`);
};

/* ------------------------------------------------------------- React stub */

/** Minimal hook runtime: enough to render one pass of each component. */
function installReact() {
  const states = [];
  let cursor = 0;
  const effects = [];
  const refs = [];
  const cleanups = [];

  const React = {
    createElement(type, props, ...children) {
      /* Mirror the real runtime: extra arguments become `children`, otherwise a
         `children` already present in props is kept. */
      const flat = children.length === 0
        ? undefined
        : (children.length === 1 ? children[0] : children);
      const merged = { ...(props ?? {}) };
      if (flat !== undefined) merged.children = flat;
      return { type, props: merged };
    },
    useState(initial) {
      const index = cursor;
      cursor += 1;
      if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial;
      return [states[index], (next) => {
        states[index] = typeof next === 'function' ? next(states[index]) : next;
      }];
    },
    useEffect(effect) {
      effects.push(effect);
    },
    useRef(initial) {
      const index = cursor;
      cursor += 1;
      if (!(index in refs)) refs[index] = { current: initial };
      return refs[index];
    },
    useId() {
      return 'pf-test-id';
    },
    useSyncExternalStore(subscribe, getSnapshot) {
      subscribe(() => {});
      const snapshot = getSnapshot();
      assert.equal(getSnapshot(), snapshot, 'external-store snapshots must be stable between updates');
      return snapshot;
    },
    cloneElement(element, extra) {
      return { type: element.type, props: { ...element.props, ...extra } };
    },
    Fragment: Symbol('Fragment'),
  };

  /** Reset the hook cursor between renders, as a fresh mount would. */
  const reset = () => {
    cursor = 0;
    states.length = 0;
    refs.length = 0;
    effects.length = 0;
    cleanups.length = 0;
  };

  /** Run the effects a render registered — React's post-commit phase. */
  const flushEffects = () => {
    for (const effect of effects.splice(0, effects.length)) {
      const cleanup = effect();
      if (typeof cleanup === 'function') cleanups.push(cleanup);
    }
  };

  return { React, reset, effects, flushEffects,
    rerender: () => { cursor = 0; effects.length = 0; },
    unmount: () => { for (const cleanup of cleanups.splice(0)) cleanup(); },
  };
}

/** The few primitives this plugin imports. */
function installPrimitives() {
  const icon = (iconName) => {
    const Icon = (props) => ({ type: `icon:${iconName}`, props: props ?? {} });
    Icon.__iconName = iconName;
    return Icon;
  };
  return {
    IconLoadingOutlineRegular: icon('loading'),
    IconSparkleRegular: icon('sparkle'),
    Tooltip: function Tooltip(props) {
      return props.children;
    },
  };
}

/** Walk a rendered tree for the first node whose type matches. */
function find(node, predicate) {
  if (node === null || node === undefined) return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find(child, predicate);
      if (hit !== null) return hit;
    }
    return null;
  }
  if (typeof node !== 'object') return null;
  if (predicate(node)) return node;
  return find(node.props?.children, predicate);
}

/* -------------------------------------------------------- browser-half load */

/**
 * Evaluate the browser artifact and return its module exports.
 *
 * @param react - the React stub the envelope's `require('react')` resolves to.
 * @param fetchImpl - `fetch` implementation the plugin sees.
 */
async function loadClientHalf(react, fetchImpl) {
  const source = await read('lib/client.js');
  const primitives = installPrimitives();

  /* 1. Evaluate the artifact exactly as written, capturing the factory it
        registers. The artifact must be valid classic-script JavaScript, which is
        what the browser loads: an `import`/`export` statement here would be a
        syntax error and the bundle would never register. */
  const shell = { load: () => {} };
  let definition = null;
  shell.load = (registered) => {
    definition = registered;
  };
  const evaluate = new Function('window', `return (function(){ ${source} })();`);
  evaluate({ __ModuleLoader__: shell });
  assert.equal(definition?.id, 'dsh-prompt-forge', 'the bundle must register under its package name');
  assert.equal(typeof definition.factory, 'function', 'the bundle must register a factory');

  /* 2. Materialize the factory the way the loader does: `factory(require)`
        returns the module's exports. */
  const require_ = (name) => {
    if (name === 'react') return react.React;
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitives;
    throw new Error(`unexpected require("${name}")`);
  };
  const exported = definition.factory(require_);
  assert.equal(typeof exported.apply, 'function', `the browser half must export apply() (saw ${JSON.stringify(Object.keys(exported ?? {}))})`);
  assert.equal(typeof exported.inject, 'object', 'the browser half must export its inject list');
  return exported;
}

/** A recording Cordis client context. */
function makeClientContext() {
  const registrations = [];
  const effects = [];
  const slots = {
    inject(key, callback) {
      callback();
      return () => {};
    },
    register(options, component) {
      registrations.push({ options, component });
      return () => {};
    },
  };
  const dictionaries = [];
  const selections = [];
  const ctx = {
    slots,
    effect(callback) {
      effects.push(callback());
      return () => {};
    },
    locale: {
      bind: (ns) => (key, params) => {
        const template = ns === 'dsh-prompt-forge' && key === 'model.default'
          ? 'Follow the default model ({name})'
          : key;
        if (params === undefined) return template;
        return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
      },
      register: (ns, locale, dict) => {
        dictionaries.push({ ns, locale, dict });
        return () => {};
      },
    },
    sessions: { binding: () => undefined },
    remote: { session: { modelCatalog: () => Promise.resolve({ ok: true, value: CATALOG }), selectModel: (selection) => { selections.push(selection); return Promise.resolve({}); } } },
    get: () => undefined,
  };
  return { ctx, registrations, effects, dictionaries, selections };
}

/** The catalog shape the Host Remote returns. */
const CATALOG = {
  default: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'max' },
  routableProviders: ['deepseek-account'],
  groups: [{
    id: 'deepseek-account',
    name: 'DeepSeek',
    models: [{
      id: 'deepseek-flash',
      name: 'DeepSeek Flash',
      reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'max', name: 'Max' }], defaultEffort: 'max' },
    }],
  }],
  failures: [],
};

/** A composer input store shaped like the conversation shell's. */
function makeInput(initialDraft) {
  let state = { draft: initialDraft, draftRev: 1, phase: 'idle', attachmentIds: [] };
  const listeners = new Set();
  return {
    store: {
      getSnapshot: () => state,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    actions: {
      setPhase: (phase) => { state = { ...state, phase }; },
      setDraft: (text) => {
        state = { ...state, draft: text, draftRev: state.draftRev + 1 };
        for (const listener of [...listeners]) listener();
      },
    },
    read: () => state,
  };
}

/* ------------------------------------------------------------ host-half load */

/** Load the Host artifact and return its exports. */
async function loadHostHalf() {
  const url = pathToFileURL(join(root, 'lib/index.js')).href;
  return import(url);
}

/** A recording Cordis host context with a swappable `llm`. */
function makeHostContext(services) {
  const routes = new Map();
  const disposes = [];
  const webCtx = {
    effect: (callback) => {
      const dispose = callback();
      if (typeof dispose === 'function') disposes.push(dispose);
      return () => {};
    },
    get: (service) => services[service],
    webServer: {
      register: (route) => {
        routes.set(route.path, route);
        return () => routes.delete(route.path);
      },
    },
  };
  const ctx = {
    inject: (names, callback) => {
      callback(webCtx);
      return () => {};
    },
    get: (service) => services[service],
  };
  return { ctx, routes, disposes };
}

/** Invoke one registered route with a fake request/response pair. */
async function callRoute(route, { method = 'POST', body } = {}) {
  const listeners = new Map();
  const req = {
    method,
    on(event, handler) {
      listeners.set(event, handler);
      return req;
    },
    destroy: () => {},
  };
  return await new Promise((resolve, reject) => {
    const res = {
      statusCode: null,
      headers: null,
      body: '',
      writeHead(status, headers) {
        this.statusCode = status;
        this.headers = headers ?? null;
      },
      end(text) {
        this.body = text ?? '';
        resolve({ status: this.statusCode, headers: this.headers, body: this.body, json: this.body === '' ? null : JSON.parse(this.body) });
      },
    };
    /* A handler attaches its request listeners synchronously, so the body can be
       emitted right after it returns; GET routes simply ignore it. */
    route.handler(req, res);
    setTimeout(() => {
      if (listeners.has('end')) {
        if (body !== undefined) listeners.get('data')?.(Buffer.from(JSON.stringify(body)));
        listeners.get('end')();
      } else if (body !== undefined) {
        reject(new Error(`route ${route.path} read no request body`));
      }
    }, 0);
  });
}

/** A fake streaming LLM that assembles into the given text. */
function makeLlm(text, { emit } = {}) {
  const calls = [];
  return {
    calls,
    listProviders: () => [{ id: 'deepseek-account', name: 'DeepSeek' }],
    listModels: async () => [{ id: 'deepseek-flash', name: 'DeepSeek Flash' }],
    resolveModelInfo: async () => ({ id: 'deepseek-flash', name: 'DeepSeek Flash' }),
    stream(options) {
      calls.push(options);
      return (async function* chunks() {
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text };
        yield { type: 'block-end', index: 0 };
        if (emit !== undefined) yield emit;
        yield { type: 'finish', reason: { kind: 'stop' } };
      })();
    },
  };
}

/* -------------------------------------------------------------------- checks */

process.stdout.write('dsh-prompt-forge self-check\n');

/* --- 1. the Host half loads and registers three routes ------------------- */
const host = await loadHostHalf();
check('Host half exports apply/inject/name', () => {
  assert.equal(typeof host.apply, 'function');
  assert.equal(host.name, 'dsh-prompt-forge');
  assert.ok(Array.isArray(host.inject), 'DSH Cordis expects a service array or service-name map');
  assert.deepEqual(host.inject, [], 'lazy services must not block plugin activation');
});

{
  const llm = makeLlm('optimized prompt text');
  const services = { llm, webServer: {}, agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'max' }) } };
  const { ctx, routes } = makeHostContext(services);
  host.apply(ctx);

  check('Host half registers its three routes', () => {
    assert.deepEqual([...routes.keys()].sort(), [
      '/prompt-forge/optimize',
      '/prompt-forge/report',
      '/prompt-forge/state',
    ]);
  });

  const state = await callRoute(routes.get('/prompt-forge/state'), { method: 'GET' });
  check('GET /state answers the durable settings document', () => {
    assert.equal(state.status, 200);
    assert.equal(typeof state.json.systemPrompt, 'string');
    assert.equal(state.json.provider, '');
    assert.equal(state.json.model, '');
  });

  const saved = await callRoute(routes.get('/prompt-forge/state'), {
    body: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'max' },
  });
  check('POST /state persists a patch and answers the merged document', () => {
    assert.equal(saved.status, 200);
    assert.equal(saved.json.provider, 'deepseek-account');
    assert.equal(saved.json.reasoningEffort, 'max');
    assert.equal(typeof saved.json.systemPrompt, 'string');
    assert.notEqual(saved.json.systemPrompt, '', 'the default instruction must survive a partial patch');
  });

  const optimized = await callRoute(routes.get('/prompt-forge/optimize'), { body: { text: 'fix the bug' } });
  check('POST /optimize returns the rewritten prompt and its route', () => {
    assert.equal(optimized.status, 200, `unexpected body: ${optimized.body}`);
    assert.equal(optimized.json.prompt, 'optimized prompt text');
    assert.equal(optimized.json.route.provider, 'deepseek-account');
    assert.equal(optimized.json.route.model, 'deepseek-flash');
    assert.equal(optimized.json.route.reasoningEffort, 'max');
  });

  check('the model call carries the configured route, effort, and rewrite instruction', () => {
    const call = llm.calls.at(-1);
    assert.equal(call.provider, 'deepseek-account');
    assert.equal(call.model, 'deepseek-flash');
    assert.equal(call.reasoningEffort, 'max');
    assert.equal(call.purpose, 'prompt-forge');
    assert.ok(call.maxTokens > 0);
    assert.ok(call.signal instanceof AbortSignal);
    assert.match(call.system, /PromptForge/);
    assert.match(call.messages[0].content[0].text, /fix the bug/);
    assert.equal(call.messages[0].role, 'user');
  });

  const empty = await callRoute(routes.get('/prompt-forge/optimize'), { body: { text: '   ' } });
  check('POST /optimize rejects an empty draft with 400', () => {
    assert.equal(empty.status, 400);
    assert.match(empty.json.error, /nothing to optimize/);
  });
}

/* --- 2. a configured model wins over the deployment default -------------- */
{
  await freshHome();
  const llm = makeLlm('rewritten');
  const { ctx, routes } = makeHostContext({ llm, webServer: {} });
  host.apply(ctx);
  await callRoute(routes.get('/prompt-forge/state'), {
    body: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'low' },
  });
  await callRoute(routes.get('/prompt-forge/optimize'), { body: { text: 'hello' } });
  check('a configured provider/model/effort is the route actually used', () => {
    const call = llm.calls.at(-1);
    assert.equal(call.model, 'deepseek-flash');
    assert.equal(call.reasoningEffort, 'low');
  });
}

/* --- 3. no model anywhere is a clean 400 --------------------------------- */
{
  await freshHome();
  const llm = makeLlm('unused');
  const { ctx, routes } = makeHostContext({ llm, webServer: {} });
  host.apply(ctx);
  const failed = await callRoute(routes.get('/prompt-forge/optimize'), { body: { text: 'hi' } });
  check('an unroutable model answers 400 instead of throwing', () => {
    assert.equal(failed.status, 400);
    assert.match(failed.json.error, /no model is configured/);
    assert.equal(llm.calls.length, 0, 'no call may be attempted without a route');
  });
}

/* --- 4. the LLM service missing is reported, not crashed ----------------- */
{
  await freshHome();
  const { ctx, routes } = makeHostContext({ webServer: {} });
  host.apply(ctx);
  const failed = await callRoute(routes.get('/prompt-forge/optimize'), { body: { text: 'hi' } });
  check('a composition without the llm service answers 400', () => {
    assert.equal(failed.status, 400);
    assert.match(failed.json.error, /LLM service is not available/);
  });
}

/* --- 5. the browser half loads and registers its two seats --------------- */
for (const [label, chunks] of [
  ['empty output', [{ type: 'finish', reason: { kind: 'stop' } }]],
  ['truncated output', [{ type: 'text-delta', index: 0, text: 'partial' }, { type: 'finish', reason: { kind: 'length' } }]],
  ['tool call output', [{ type: 'block-start', index: 0, blockType: 'tool-call' }, { type: 'finish', reason: { kind: 'stop' } }]],
  ['missing finish event', [{ type: 'text-delta', index: 0, text: 'partial' }]],
]) {
  await freshHome();
  const llm = makeLlm('');
  llm.stream = async function* () { yield* chunks; };
  const { ctx, routes } = makeHostContext({ llm, webServer: {}, agentDefaultModel: { currentSelection: () => CATALOG.default } });
  host.apply(ctx);
  const result = await callRoute(routes.get('/prompt-forge/optimize'), { body: { text: 'hello' } });
  check(`the Host rejects ${label} instead of replacing the draft`, () => {
    assert.equal(result.status, 400);
    assert.equal(typeof result.json.error, 'string');
  });
}

const react = installReact();
const fetches = [];
let answers = [];
/** The page `fetch` the bundle reaches its Host through. */
const realFetch = globalThis.fetch;
globalThis.fetch = (url, init) => {
  fetches.push({ url, init });
  const answer = answers.shift() ?? {
    status: 200,
    body: { prompt: 'OPTIMIZED', route: { provider: 'deepseek-account', model: 'deepseek-flash' } },
  };
  return Promise.resolve({
    ok: answer.status >= 200 && answer.status < 300,
    status: answer.status,
    json: () => Promise.resolve(answer.body),
  });
};
const client = await loadClientHalf(react);
const clientRun = makeClientContext();
client.apply(clientRun.ctx);

check('browser half registers conversation.input.right and settings.section', () => {
  const seats = clientRun.registrations.map((entry) => entry.options.name);
  assert.deepEqual(seats.sort(), ['conversation.input.right', 'settings.section']);
  const button = clientRun.registrations.find((entry) => entry.options.name === 'conversation.input.right');
  assert.equal(button.options.id, 'dsh-prompt-forge', 'list slots require an id');
  assert.equal(typeof button.options.inject, 'function', 'the button needs the Session id');
  const section = clientRun.registrations.find((entry) => entry.options.name === 'settings.section');
  assert.equal(section.options.id, 'dsh-prompt-forge');
  assert.equal(typeof section.options.label, 'function');
});

check('the plugin stylesheet is injected under one owned id', () => {
  assert.equal(clientRun.effects.length >= 1, true);
});

check('the locale namespace registers complete zh and en dictionaries', () => {
  const namespaces = clientRun.dictionaries.map((entry) => entry.locale).sort();
  assert.deepEqual(namespaces, ['en', 'zh']);
  const [zh, en] = clientRun.dictionaries;
  assert.deepEqual(Object.keys(zh.dict).sort(), Object.keys(en.dict).sort(), 'the two dictionaries must have identical key sets');
  for (const value of Object.values(en.dict)) assert.equal(typeof value, 'string');
});

/* --- 6. the button renders nothing while the composer is empty ---------- */
const button = clientRun.registrations.find((entry) => entry.options.name === 'conversation.input.right');
const section = clientRun.registrations.find((entry) => entry.options.name === 'settings.section');

const renderButton = (input, sessionId = 'session-1') => {
  react.reset();
  const props = {
    ...button.options.inject(sessionId),
    t: clientRun.ctx.locale.bind('dsh-prompt-forge'),
    useInput: (selector) => selector(input.store.getSnapshot()),
    inputActions: input.actions,
  };
  return { tree: button.component(props), props };
};

{
  const input = makeInput('');
  const { tree } = renderButton(input);
  check('the button renders nothing while the draft is empty', () => {
    assert.equal(tree, null);
  });
}

/* --- 7. the button appears with text, as a sparkle --------------------- */
{
  const input = makeInput('fix the login bug');
  const { tree } = renderButton(input);
  const rendered = find(tree, (node) => node.type === 'button');
  check('the button appears once the draft has text, as a sparkle', () => {
    assert.notEqual(rendered, null, 'a draft with text must render the control');
    assert.equal(rendered.props['aria-busy'], 'false');
    assert.equal(rendered.props.disabled, false);
    const glyph = find(rendered, (node) => typeof node.type === 'function' && node.type.__iconName !== undefined);
    assert.notEqual(glyph, null, 'the button must draw an icon');
    assert.equal(glyph.type.__iconName, 'sparkle');
    assert.equal(glyph.props.className, undefined, 'the idle glyph must not spin');
  });
}

/* --- 8. clicking it posts the draft, then replaces it without sending --- */
{
  const input = makeInput('fix the login bug');
  answers = [{ status: 200, body: { prompt: 'OPTIMIZED PROMPT', route: { provider: 'deepseek-account', model: 'deepseek-flash' } } }];
  fetches.length = 0;
  const { tree } = renderButton(input);
  const rendered = find(tree, (node) => node.type === 'button');
  rendered.props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 10));
  check('clicking posts the exact draft to the optimize route', () => {
    const call = fetches.find((entry) => entry.url.endsWith('/optimize'));
    assert.notEqual(call, undefined, `the click must reach the optimize route; saw ${JSON.stringify(fetches.map((entry) => entry.url))}`);
    assert.equal(JSON.parse(call.init.body).text, 'fix the login bug');
    assert.equal(call.init.method, 'POST');
  });
  check('the optimized prompt replaces the whole draft and is never sent', () => {
    assert.equal(input.read().draft, 'OPTIMIZED PROMPT');
    assert.equal(input.read().phase, 'idle', 'the composer must stay unsent');
    const submits = fetches.filter((entry) => entry.url.includes('submit'));
    assert.equal(submits.length, 0);
    assert.equal(clientRun.selections.length, 0, 'optimization must not change the conversation model');
  });
}

/* Delayed replies must respect edits, sends, unmounts, and duplicate clicks. */
for (const scenario of ['edit', 'edit-back', 'submitting', 'unmount']) {
  const input = makeInput('original');
  let complete;
  let calls = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => {
    if (!url.endsWith('/optimize')) return previousFetch(url, init);
    calls += 1;
    return new Promise((resolve) => { complete = resolve; });
  };
  try {
    const { tree, props } = renderButton(input);
    react.flushEffects();
    const rendered = find(tree, (node) => node.type === 'button');
    rendered.props.onClick();
    rendered.props.onClick();
    react.rerender();
    const busyTree = button.component(props);
    const busyButton = find(busyTree, (node) => node.type === 'button');
    check(`pending optimization shows a spinner and prevents duplicate calls (${scenario})`, () => {
      assert.equal(calls, 1);
      assert.equal(busyButton.props.disabled, true);
      assert.equal(busyButton.props['aria-busy'], 'true');
      assert.ok(find(busyTree, (node) => node.type?.__iconName === 'loading'));
    });
    if (scenario === 'edit' || scenario === 'edit-back') input.actions.setDraft('changed');
    if (scenario === 'edit-back') input.actions.setDraft('original');
    if (scenario === 'submitting') input.actions.setPhase('submitting');
    if (scenario === 'unmount') react.unmount();
    else { react.rerender(); button.component(props); }
    const expected = input.read().draft;
    complete({ ok: true, status: 200, json: async () => ({ prompt: 'late result' }) });
    await new Promise((resolve) => setTimeout(resolve, 0));
    check(`a delayed reply does not overwrite the composer after ${scenario}`, () => {
      assert.equal(input.read().draft, expected);
    });
  } finally {
    globalThis.fetch = previousFetch;
    react.unmount();
  }
}

/* --- 9. a failure is reported and leaves the draft alone --------------- */
{
  const input = makeInput('keep me');
  answers = [{ status: 400, body: { error: 'the model hit the output token limit' } }];
  fetches.length = 0;
  const { tree } = renderButton(input);
  const rendered = find(tree, (node) => node.type === 'button');
  rendered.props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 10));
  check('a rejected optimization keeps the draft and reports the failure', () => {
    assert.equal(input.read().draft, 'keep me');
    const report = fetches.find((entry) => entry.url.endsWith('/report'));
    assert.notEqual(report, undefined, 'the failure must reach the Host log');
    assert.match(JSON.parse(report.init.body).message, /output token limit/);
  });
}

/* --- 10. the settings page renders the live catalog -------------------- */
{
  /* The catalog arrives over the Remote namespace, so commit once to run the
     page's effects, let the load settle, then render the populated page. */
  react.reset();
  section.component({ t: clientRun.ctx.locale.bind('dsh-prompt-forge') });
  react.flushEffects();
  await new Promise((resolve) => setTimeout(resolve, 10));
  react.reset();
  const tree = section.component({
    t: clientRun.ctx.locale.bind('dsh-prompt-forge'),
  });
  const selects = [];
  const walk = (node) => {
    if (node === null || node === undefined || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (node.type === 'select') selects.push(node);
    walk(node.props?.children);
  };
  walk(tree);
  check('the settings page renders a model select and an effort select', () => {
    assert.equal(selects.length, 2, `expected two selects, saw ${selects.length}`);
    const modelOptions = selects[0].props.children.length;
    assert.ok(modelOptions >= 2, 'the model select needs a default option plus catalog entries');
    assert.equal(selects[0].props.disabled, false, 'the catalog is populated in this harness');
  });
  check('the effort select offers the live levels of the selected model', () => {
    const options = selects[1].props.children.map((option) => option.props.value);
    assert.deepEqual(options, ['', 'low', 'max'], 'the effort options must come from the catalog');
    assert.equal(selects[1].props.disabled, false);
  });
  check('the model select names the deployment default', () => {
    const label = selects[0].props.children[0].props.children;
    assert.match(label, /DeepSeek \/ DeepSeek Flash/);
  });
}

/* Settings writes must settle in order and failures must be visible. */
{
  const previousFetch = globalThis.fetch;
  const requests = [];
  const renderSettings = () => {
    react.reset();
    return section.component({ t: clientRun.ctx.locale.bind('dsh-prompt-forge') });
  };
  globalThis.fetch = (url, init) => {
    if (url !== '/prompt-forge/state' || init?.method !== 'POST') return previousFetch(url, init);
    return new Promise((resolve) => requests.push({ body: JSON.parse(init.body), resolve }));
  };
  try {
    let tree = renderSettings();
    const effort = find(tree, (node) => node.type === 'select' && node.props['aria-label'] === 'effort.heading');
    effort.props.onChange({ target: { value: 'low' } });
    effort.props.onChange({ target: { value: 'max' } });
    check('rapid settings changes serialize writes', () => { assert.equal(requests.length, 1); });
    requests[0].resolve({ ok: true, status: 200, json: async () => requests[0].body });
    await new Promise((resolve) => setTimeout(resolve, 0));
    check('the newest settings are persisted after the earlier write', () => {
      assert.equal(requests.length, 2);
      assert.equal(requests[1].body.reasoningEffort, 'max');
    });
    requests[1].resolve({ ok: false, status: 500, json: async () => ({ error: 'write failed' }) });
    await new Promise((resolve) => setTimeout(resolve, 0));
    tree = renderSettings();
    check('HTTP save failures are rendered without an unhandled rejection', () => {
      assert.ok(find(tree, (node) => node.props?.['data-tone'] === 'error'));
    });
  } finally { globalThis.fetch = previousFetch; }
}

process.stdout.write(`\ndsh-prompt-forge: ${checks} checks passed\n`);

/* Leave the harness's process as it was found. */
globalThis.fetch = realFetch;
react.unmount();
await Promise.all(sandboxHomes.map((home) => rm(home, { recursive: true, force: true })));
