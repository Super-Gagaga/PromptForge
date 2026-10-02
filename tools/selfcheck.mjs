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

/** Minimal hook runtime: enough to render, re-render, and commit effects. */
function installReact() {
  const states = [];
  let cursor = 0;
  const effects = [];
  const refs = [];
  const cleanups = [];
  let current = null;
  let effectSeq = 0;

  /**
   * Expand one element into its rendered tree, as React would.
   *
   * Function components are invoked here so a walker can reach the markup they
   * return — the plugin's pickers and rows are all plain components. A resolved
   * node keeps its own identity under `rendered`, so a predicate can match
   * either the component or its output.
   */
  const resolve = (element) => {
    if (element === null || element === undefined || typeof element !== 'object') return element;
    if (Array.isArray(element)) return element.map(resolve);
    if (typeof element.type !== 'function') return element;
    return { ...element, rendered: resolve(element.type(element.props)) };
  };

  const render = () => {
    cursor = 0;
    effectSeq = 0;
    return resolve(current.component(current.props));
  };

  /** A state setter that re-renders the mounted component, as React would. */
  const setter = (index) => (next) => {
    const value = typeof next === 'function' ? next(states[index]) : next;
    if (Object.is(value, states[index])) return;
    states[index] = value;
    if (current !== null) render();
  };

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
      return [states[index], setter(index)];
    },
    useEffect(effect) {
      const index = effectSeq;
      effectSeq += 1;
      effects.push({ index, effect });
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
    current = null;
  };

  /** Mount one component; state changes re-render it with the same props. */
  const mount = (component, props) => {
    current = { component, props };
    return render();
  };

  /** Run the effects a render registered — React's post-commit phase. */
  const flushEffects = () => {
    for (const entry of effects.splice(0, effects.length)) {
      while (cleanups.length > entry.index) {
        const cleanup = cleanups.pop();
        if (typeof cleanup === 'function') cleanup();
      }
      while (cleanups.length < entry.index) cleanups.push(undefined);
      const cleanup = entry.effect();
      cleanups.push(typeof cleanup === 'function' ? cleanup : undefined);
    }
  };

  return { React, reset, mount, effects, flushEffects,
    /** Re-render the mounted instance in place; effects stay to the caller. */
    rerender: () => {
      cursor = 0;
      effectSeq = 0;
      if (current !== null) return render();
      return null;
    },
    unmount: () => {
      current = null;
      for (const cleanup of cleanups.splice(0)) if (typeof cleanup === 'function') cleanup();
    },
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
    IconCheckOutlineRegular: icon('check'),
    IconChevronDownOutlineRegular: icon('chevron-down'),
    StateDot: (props) => ({ type: 'state-dot', props: props ?? {} }),
    MenuGroup: (props) => ({ type: 'menu-group', props: props ?? {} }),
    Tooltip: function Tooltip(props) {
      return props.children;
    },
  };
}

/**
 * Visit every node of a rendered tree.
 *
 * A node carries its own children under `props.children`; a function component
 * is expanded on visit, so a walker reaches the markup the plugin's pickers and
 * rows return instead of stopping at the component element. The expansion is
 * cached on the element itself, because invoking a component twice would run its
 * hooks twice — and a fresh element from an earlier render must not be reused
 * once a re-render has replaced it.
 */
const EXPANDED = Symbol('pf.expanded');
function walkTree(node, visit) {
  if (node === null || node === undefined || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) walkTree(child, visit);
    return;
  }
  visit(node);
  walkTree(node.props?.children, visit);
  if (typeof node.type !== 'function') return;
  if (!Object.prototype.hasOwnProperty.call(node, EXPANDED)) {
    node[EXPANDED] = node.type(node.props);
  }
  walkTree(node[EXPANDED], visit);
}

/** Walk a rendered tree for the first node whose type matches. */
function find(node, predicate) {
  let hit = null;
  walkTree(node, (candidate) => {
    if (hit === null && predicate(candidate)) hit = candidate;
  });
  return hit;
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

/** The workspace paths the fake file index knows about. */
const INDEX_PATHS = [
  { path: 'src/host.js', kind: 'file' },
  { path: 'src/my module.js', kind: 'file' },
  { path: 'src/pages', kind: 'directory' },
];

/**
 * A fake file-reference index: it answers a query with every known path that
 * contains it, exactly as the fuzzy workspace search ranks candidates.
 */
function makeFileIndex() {
  const queries = [];
  return {
    queries,
    list: async (agent, query) => {
      queries.push({ agent, query });
      if (agent === undefined) throw new Error('no agent');
      return INDEX_PATHS.filter((candidate) => candidate.path.includes(query));
    },
  };
}

/** A fake skill catalog. */
function makeSkillCatalog() {
  const queried = [];
  const skills = [
    { name: 'office-docx', description: 'Word documents', invocation: { modelInvocable: true, userInvocable: true }, source: 'bundled', provider: 'skill-filesystem' },
    { name: 'office-xlsx', description: 'Spreadsheets', invocation: { modelInvocable: true, userInvocable: true }, source: 'bundled', provider: 'skill-filesystem' },
    /* Human-only: the model cannot load it, so it must never be advertised. */
    { name: 'human-only', description: 'Command only', invocation: { modelInvocable: false, userInvocable: true }, source: 'bundled', provider: 'skill-filesystem' },
  ];
  return {
    queried,
    list: async (options) => {
      queried.push(options);
      return skills;
    },
  };
}

/** One live agent stand-in, with the session its skill lookup reads. */
function makeAgent() {
  const session = { cwd: 'C:/work' };
  return { id: 'session-1', ctx: { get: (service) => (service === 'session' ? session : undefined) } };
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
    const call = llm.calls[0];
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
    const call = llm.calls[0];
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

/* --- 5. the reference pass validates before it appends ------------------- */
for (const [label, answer, expectations] of [
  [
    'appends a confirmed file, quotes a spaced path, drops a hallucination, and lists a confirmed skill',
    {
      prompt: 'Fix the login flow.',
      files: ['src/host', 'my module', 'src/does-not-exist'],
      skills: ['office-docx', 'human-only', 'invented-skill'],
    },
    {
      prompt: 'Fix the login flow.\n\n@src/host.js\n@"src/my module.js"\n\nSkills this task may need (load one with the skill tool by name):\noffice-docx',
      files: ['src/host.js', 'src/my module.js'],
      skills: ['office-docx'],
      queried: ['src/host', 'my module', 'src/does-not-exist'],
    },
  ],
  [
    'keeps the rewrite when the model nominates nothing',
    { prompt: 'Fix the login flow.', files: [], skills: [] },
    { prompt: 'Fix the login flow.', files: [], skills: [], queried: [] },
  ],
  [
    'accepts a plain-text answer when the model ignores the envelope',
    'Fix the login flow.',
    { prompt: 'Fix the login flow.', files: [], skills: [], queried: [] },
  ],
  [
    'accepts a fenced JSON answer',
    '```json\n{"prompt":"Fix the login flow.","files":["src/host"],"skills":[]}\n```',
    { prompt: 'Fix the login flow.\n\n@src/host.js', files: ['src/host.js'], skills: [], queried: ['src/host'] },
  ],
]) {
  await freshHome();
  const llm = makeLlm(typeof answer === 'string' ? answer : JSON.stringify(answer));
  const index = makeFileIndex();
  const catalog = makeSkillCatalog();
  const agent = makeAgent();
  const services = {
    llm,
    webServer: {},
    fileReferences: index,
    skills: catalog,
    agents: { get: (id) => (id === 'session-1' ? agent : undefined) },
    agentDefaultModel: { currentSelection: () => CATALOG.default },
  };
  const { ctx, routes } = makeHostContext(services);
  host.apply(ctx);
  const result = await callRoute(routes.get('/prompt-forge/optimize'), {
    body: { text: 'fix the login flow', sessionId: 'session-1' },
  });
  check(`the reference pass ${label}`, () => {
    assert.equal(result.status, 200, `unexpected body: ${result.body}`);
    assert.equal(result.json.prompt, expectations.prompt);
    assert.deepEqual(result.json.files, expectations.files);
    assert.deepEqual(result.json.skills, expectations.skills);
    assert.deepEqual(index.queries.map((query) => query.query), expectations.queried);
    assert.equal(result.json.notes, undefined, 'a healthy pass records no note');
    if (expectations.queried.length > 0) {
      assert.equal(index.queries[0].agent, agent, 'discovery must be scoped to the live agent');
    }
    if (result.json.skills.length > 0) {
      assert.equal(catalog.queried.at(-1).scope, agent, 'the catalog view must be scoped to the live agent');
      assert.equal(catalog.queried.at(-1).cwd, 'C:/work', 'the catalog view must use the Session working directory');
    }
  });
}

/* --- 6. the envelope instruction follows the two toggles ----------------- */
{
  await freshHome();
  const llm = makeLlm(JSON.stringify({ prompt: 'Rewritten.', files: [], skills: [] }));
  const { ctx, routes } = makeHostContext({
    llm,
    webServer: {},
    fileReferences: makeFileIndex(),
    skills: makeSkillCatalog(),
    agents: { get: () => makeAgent() },
    agentDefaultModel: { currentSelection: () => CATALOG.default },
  });
  host.apply(ctx);
  const off = await callRoute(routes.get('/prompt-forge/state'), {
    body: { referenceFiles: false, referenceSkills: false },
  });
  check('both reference toggles default to on and persist when switched off', () => {
    assert.equal(off.status, 200);
    assert.equal(off.json.referenceFiles, false);
    assert.equal(off.json.referenceSkills, false);
  });

  const withFiles = await callRoute(routes.get('/prompt-forge/state'), { body: { referenceFiles: true } });
  await callRoute(routes.get('/prompt-forge/optimize'), { body: { text: 'hi', sessionId: 'session-1' } });
  const instruction = llm.calls[0].system;
  check('the envelope instruction asks only for what the toggles enabled', () => {
    assert.equal(withFiles.json.referenceFiles, true);
    assert.equal(withFiles.json.referenceSkills, false);
    assert.match(instruction, /"files"/);
    assert.doesNotMatch(instruction, /"skills"/, 'a disabled feature must not be requested');
    assert.doesNotMatch(instruction, /Reply with the rewritten prompt only/,
      'the JSON contract must replace the plain-text contract, not compete with it');
  });
}

/* --- 7. a prose rewrite still gets its references ------------------------ */
{
  await freshHome();
  /* The first call ignores the envelope; the follow-up answers the JSON question. */
  const replies = [
    'Fix the login flow.',
    JSON.stringify({ files: ['src/host'], skills: [] }),
  ];
  const llm = makeLlm('');
  const recorded = llm.stream.bind(llm);
  llm.stream = function stream(options) {
    /* Keep recording the calls while answering with the scripted replies. */
    recorded(options);
    return (async function* chunks() {
      yield { type: 'text-delta', index: 0, text: replies.shift() ?? '' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    })();
  };
  const index = makeFileIndex();
  const { ctx, routes } = makeHostContext({
    llm,
    webServer: {},
    fileReferences: index,
    skills: makeSkillCatalog(),
    agents: { get: () => makeAgent() },
    agentDefaultModel: { currentSelection: () => CATALOG.default },
  });
  host.apply(ctx);
  const result = await callRoute(routes.get('/prompt-forge/optimize'), {
    body: { text: 'fix the login flow', sessionId: 'session-1' },
  });
  check('a prose rewrite triggers one follow-up nomination call and keeps its references', () => {
    assert.equal(result.status, 200, `unexpected body: ${result.body}`);
    assert.equal(llm.calls.length, 2, 'the rewrite plus exactly one nomination call');
    assert.match(llm.calls[1].system, /"files"/, 'the follow-up asks the narrow JSON question');
    assert.equal(llm.calls[1].messages[0].content[0].text, 'Fix the login flow.',
      'the follow-up receives the finished prompt, not the raw draft');
    assert.equal(result.json.prompt, 'Fix the login flow.\n\n@src/host.js');
    assert.deepEqual(result.json.files, ['src/host.js']);
  });
}

/* --- 8. an envelope answer costs no second call ------------------------- */
{
  await freshHome();
  const llm = makeLlm(JSON.stringify({ prompt: 'Fix it.', files: [], skills: [] }));
  const { ctx, routes } = makeHostContext({
    llm,
    webServer: {},
    fileReferences: makeFileIndex(),
    skills: makeSkillCatalog(),
    agents: { get: () => makeAgent() },
    agentDefaultModel: { currentSelection: () => CATALOG.default },
  });
  host.apply(ctx);
  const result = await callRoute(routes.get('/prompt-forge/optimize'), {
    body: { text: 'fix it', sessionId: 'session-1' },
  });
  check('an envelope answer stands alone without a nomination call', () => {
    assert.equal(result.status, 200);
    assert.equal(llm.calls.length, 1, 'an obeyed envelope needs no follow-up');
    assert.equal(result.json.prompt, 'Fix it.');
  });
}

/* --- 9. the browser half loads and registers its two seats --------------- */
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
/** The durable settings document the state route answers with. */
const STATE_DOCUMENT = {
  provider: '',
  model: '',
  reasoningEffort: '',
  systemPrompt: 'Rewrite the draft.',
  referenceFiles: true,
  referenceSkills: true,
};
globalThis.fetch = (url, init) => {
  fetches.push({ url, init });
  const isState = url === '/prompt-forge/state';
  const isWrite = init?.method === 'POST';
  const answer = answers.shift() ?? (isState && !isWrite
    ? { status: 200, body: STATE_DOCUMENT }
    : isState
      ? { status: 200, body: { ...STATE_DOCUMENT, ...JSON.parse(init.body) } }
      : {
        status: 200,
        body: { prompt: 'OPTIMIZED', route: { provider: 'deepseek-account', model: 'deepseek-flash' } },
      });
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

check('settings navigation icon handles mounting, language changes and disposal without altering other sections', () => {
  const savedDocument = globalThis.document;
  const savedObserver = globalThis.MutationObserver;
  const attributes = new Map();
  const button = {
    setAttribute: (key, value) => attributes.set(key, value),
    removeAttribute: (key) => attributes.delete(key),
  };
  const label = { textContent: '', parentElement: button };
  let mounted = false;
  let notify;
  let disconnected = false;
  globalThis.document = {
    body: {},
    getElementById: () => ({}),
    querySelectorAll: (selector) => selector === '[data-pf-nav-icon]'
      ? (attributes.has('data-pf-nav-icon') ? [button] : [])
      : (mounted ? [label] : []),
  };
  globalThis.MutationObserver = class {
    constructor(callback) { notify = callback; }
    observe() {}
    disconnect() { disconnected = true; }
  };
  const run = makeClientContext();
  try {
    client.apply(run.ctx);
    assert.equal(attributes.has('data-pf-nav-icon'), false);
    mounted = true;
    for (const { dict } of run.dictionaries) {
      label.textContent = dict.nav;
      notify();
      assert.equal(attributes.has('data-pf-nav-icon'), true);
    }
    label.textContent = 'Models';
    notify();
    assert.equal(attributes.has('data-pf-nav-icon'), false);
    label.textContent = run.dictionaries[0].dict.nav;
    notify();
    for (const dispose of run.effects) dispose();
    assert.equal(disconnected, true);
    assert.equal(attributes.has('data-pf-nav-icon'), false);
  } finally {
    if (savedDocument === undefined) delete globalThis.document;
    else globalThis.document = savedDocument;
    if (savedObserver === undefined) delete globalThis.MutationObserver;
    else globalThis.MutationObserver = savedObserver;
  }
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
  check('the button appears once the draft has text, with a theme-aware text-and-spark icon', () => {
    assert.notEqual(rendered, null, 'a draft with text must render the control');
    assert.equal(rendered.props['aria-busy'], 'false');
    assert.equal(rendered.props.disabled, false);
    const glyph = find(rendered, (node) => node.type?.name === 'PromptForgeTextSparkIcon');
    assert.notEqual(glyph, null, 'the button must draw an icon');
    const svg = glyph.type(glyph.props);
    assert.equal(svg.type, 'svg');
    assert.equal(svg.props.stroke, 'currentColor');
    assert.equal(svg.props.width, 20);
    assert.equal(glyph.props.className, undefined, 'the idle glyph must not spin');
  });
}

/* --- 8. clicking it posts the draft, then replaces it without sending --- */
{
  const input = makeInput('fix the login bug');
  answers = [{
    status: 200,
    body: {
      prompt: 'OPTIMIZED PROMPT\n\n@src/host.js',
      route: { provider: 'deepseek-account', model: 'deepseek-flash' },
      files: ['src/host.js'],
      skills: [],
    },
  }];
  fetches.length = 0;
  const { tree } = renderButton(input);
  const rendered = find(tree, (node) => node.type === 'button');
  rendered.props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 10));
  check('clicking posts the exact draft and the Session id to the optimize route', () => {
    const call = fetches.find((entry) => entry.url.endsWith('/optimize'));
    assert.notEqual(call, undefined, `the click must reach the optimize route; saw ${JSON.stringify(fetches.map((entry) => entry.url))}`);
    const body = JSON.parse(call.init.body);
    assert.equal(body.text, 'fix the login bug');
    assert.equal(body.sessionId, 'session-1', 'reference discovery needs the Session working directory');
    assert.equal(call.init.method, 'POST');
  });
  check('the optimized prompt replaces the whole draft and is never sent', () => {
    assert.equal(input.read().draft, 'OPTIMIZED PROMPT\n\n@src/host.js');
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

/* --- 10. the settings page renders the live catalog in dropdowns ------- */
{
  /* The catalog arrives over the Remote namespace, so commit once to run the
     page's effects, let the load settle, then re-render the populated page. */
  react.reset();
  const props = { t: clientRun.ctx.locale.bind('dsh-prompt-forge') };
  const remount = () => react.mount(section.component, props);
  /** The trigger button of the one dropdown whose label matches. */
  const triggerFor = (tree, ariaLabel) => find(tree, (node) => node.type === 'button'
    && node.props['aria-haspopup'] === 'listbox'
    && node.props['aria-label'] === ariaLabel);
  /** The rows of whichever panel is currently open, deduplicated by row key. */
  const optionsOf = (tree) => {
    const options = [];
    walkTree(tree, (node) => {
      if (node.type === 'button' && node.props.role === 'option') options.push(node);
    });
    const unique = [];
    const seen = new Set();
    for (const option of options) {
      const key = option.props['data-key'];
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(option);
    }
    return unique;
  };
  /** The group headings of the open panel, in order and deduplicated. */
  const groupLabelsOf = (tree) => {
    const labels = [];
    walkTree(tree, (node) => {
      if (node.type === 'menu-group' && !labels.includes(node.props.label)) labels.push(node.props.label);
    });
    return labels;
  };
  /** The row key one option was built from: `''` is the follow-default row. */
  const optionKey = (option) => option.props['data-key'];

  /* The catalog arrives over the Remote namespace, so mount once to commit the
     page's effects, let the settings and catalog loads settle, then re-render. */
  react.reset();
  react.mount(section.component, props);
  react.flushEffects();
  await new Promise((resolve) => setTimeout(resolve, 20));
  react.reset();
  const tree = remount();
  const modelTrigger = triggerFor(tree, 'model.aria');
  const effortTrigger = triggerFor(tree, 'effort.heading');

  check('the settings page renders a model dropdown and an effort dropdown', () => {
    assert.notEqual(modelTrigger, null, 'the model dropdown must render');
    assert.notEqual(effortTrigger, null, 'the effort dropdown must render');
    assert.equal(modelTrigger.props.disabled, false, 'the catalog is populated in this harness');
    assert.equal(modelTrigger.props['aria-expanded'], false, 'the panel starts closed');
  });

  check('the model trigger names the deployment default while following it', () => {
    const label = find(modelTrigger, (node) => node.props?.className === 'PF-pickerValue');
    assert.match(String(label.props.children), /DeepSeek \/ DeepSeek Flash/);
  });

  /* Open the model panel: rows come from the live catalog, grouped by provider. */
  modelTrigger.props.onClick();
  const opened = remount();
  const options = optionsOf(opened);

  check('the open model panel groups the follow-default row apart from the providers', () => {
    assert.equal(triggerFor(opened, 'model.aria').props['aria-expanded'], true, 'the panel opened');
    assert.deepEqual(groupLabelsOf(opened), ['model.followingGroup', 'DeepSeek']);
    assert.deepEqual(options.map(optionKey), ['', 'deepseek-account\u0000deepseek-flash'],
      'the panel must list the follow-default row plus every catalog model');
  });

  check('the panel marks the follow-default row as current, and only that row', () => {
    if (options.filter((option) => option.props['aria-selected'] === true).length !== 1) {
      process.stderr.write(`DEBUG rows=${JSON.stringify(options.map((o) => [o.props['data-key'], o.props['aria-selected']]))}\n`);
    }
    const selected = options.filter((option) => option.props['aria-selected'] === true);
    assert.equal(selected.length, 1, 'exactly one row may be current');
    assert.equal(optionKey(selected[0]), '');
  });

  check('the panel paints the shipped check mark on the current row', () => {
    const current = options.find((option) => option.props['aria-selected'] === true);
    const glyph = find(current, (node) => typeof node.type === 'function' && node.type.__iconName !== undefined);
    assert.notEqual(glyph, null, 'the current row must draw its check');
    assert.equal(glyph.type.__iconName, 'check');
  });

  /* Picking a concrete model clears the stale effort and names itself. */
  const concrete = options.find((option) => optionKey(option) !== '');
  concrete.props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 5));
  check('choosing a model writes the pair and clears the previous effort', () => {
    const write = fetches.filter((entry) => entry.url === '/prompt-forge/state' && entry.init?.method === 'POST').at(-1);
    assert.notEqual(write, undefined, 'the choice must persist');
    const body = JSON.parse(write.init.body);
    assert.equal(body.provider, 'deepseek-account');
    assert.equal(body.model, 'deepseek-flash');
    assert.equal(body.reasoningEffort, '');
  });

  check('the trigger now names the chosen model instead of the default', () => {
    const label = find(triggerFor(remount(), 'model.aria'), (node) => node.props?.className === 'PF-pickerValue');
    assert.equal(String(label.props.children), 'DeepSeek / DeepSeek Flash');
  });

  check('the effort dropdown offers the live levels of the selected model', () => {
    const picker = triggerFor(remount(), 'effort.heading');
    assert.equal(picker.props.disabled, false, 'the selected model exposes effort levels');
    picker.props.onClick();
    const effortOptions = optionsOf(remount());
    assert.deepEqual(effortOptions.map(optionKey), ['', 'low', 'max'],
      'the effort rows must come from the catalog of the selected model');
  });

  /* The two reference switches: present, on by default, and writable. The page
     is walked through both the component and its output, so rows are deduped. */
  const switchesOf = (tree) => {
    const found = [];
    walkTree(tree, (node) => {
      if (node.type === 'button' && node.props.role === 'switch'
        && !found.some((seen) => seen.props['aria-label'] === node.props['aria-label'])) {
        found.push(node);
      }
    });
    return found;
  };
  const switches = switchesOf(remount());
  check('the settings page offers a reference-file switch and a reference-skill switch', () => {
    assert.deepEqual(switches.map((node) => node.props['aria-label']),
      ['reference.files', 'reference.skills']);
    assert.deepEqual(switches.map((node) => node.props['aria-checked']), [true, true],
      'both reference features default to on');
  });

  switches[1].props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 5));
  check('flipping a switch persists exactly that preference', () => {
    const write = fetches.filter((entry) => entry.url === '/prompt-forge/state' && entry.init?.method === 'POST').at(-1);
    assert.notEqual(write, undefined, 'the flip must persist');
    const body = JSON.parse(write.init.body);
    assert.equal(body.referenceSkills, false, 'the flipped switch must be persisted');
    assert.equal(body.referenceFiles, true, 'the untouched switch must keep its value');
  });
  check('the flipped switch reads back as off', () => {
    const after = switchesOf(remount());
    assert.deepEqual(after.map((node) => node.props['aria-checked']), [true, false]);
  });
}

/* Settings writes must settle in order and failures must be visible. */
{
  const previousFetch = globalThis.fetch;
  const requests = [];
  const props = { t: clientRun.ctx.locale.bind('dsh-prompt-forge') };
  const mountSettings = () => {
    react.reset();
    return react.mount(section.component, props);
  };
  const trigger = (tree, label) => find(tree, (node) => node.type === 'button'
    && node.props['aria-haspopup'] === 'listbox'
    && node.props['aria-label'] === label);
  const row = (tree, key) => find(tree, (node) => node.type === 'button'
    && node.props.role === 'option'
    && node.props['data-key'] === key);
  globalThis.fetch = (url, init) => {
    if (url !== '/prompt-forge/state' || init?.method !== 'POST') return previousFetch(url, init);
    return new Promise((resolve) => requests.push({ body: JSON.parse(init.body), resolve }));
  };
  try {
    /* Picking two effort levels back to back must not queue two writes. Each
       step remounts, because opening the panel re-renders the page. */
    /* Picking two effort levels back to back must not queue two writes. The
       opener is clicked on the mounted page and the same instance re-renders,
       so the panel that just opened is the one walked next. */
    const openEffort = () => {
      const tree = mountSettings();
      trigger(tree, 'effort.heading').props.onClick();
      return react.rerender();
    };
    const low = row(openEffort(), 'low');
    if (low === null) {
      process.stderr.write(`DEBUG requests=${requests.length}\n`);
      assert.fail('the effort panel did not open');
    }
    low.props.onClick();
    const max = row(openEffort(), 'max');
    if (max === null) assert.fail('the reopened effort panel has no max row');
    max.props.onClick();
    check('rapid settings changes serialize writes', () => { assert.equal(requests.length, 1); });
    requests[0].resolve({ ok: true, status: 200, json: async () => requests[0].body });
    await new Promise((resolve) => setTimeout(resolve, 0));
    check('the newest settings are persisted after the earlier write', () => {
      assert.equal(requests.length, 2);
      assert.equal(requests[1].body.reasoningEffort, 'max');
    });
    requests[1].resolve({ ok: false, status: 500, json: async () => ({ error: 'write failed' }) });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const failed = mountSettings();
    check('HTTP save failures are rendered without an unhandled rejection', () => {
      assert.ok(find(failed, (node) => node.props?.['data-tone'] === 'error'));
    });
  } finally { globalThis.fetch = previousFetch; }
}

process.stdout.write(`\ndsh-prompt-forge: ${checks} checks passed\n`);

/* Leave the harness's process as it was found. */
globalThis.fetch = realFetch;
react.unmount();
await Promise.all(sandboxHomes.map((home) => rm(home, { recursive: true, force: true })));
