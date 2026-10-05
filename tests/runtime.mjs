import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { recordSource } from '../tools/coverage-source.mjs';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const read = (path) => readFile(join(root, path), 'utf8');
export const tick = () => new Promise(resolve => setImmediate(resolve));
export const plain = value => JSON.parse(JSON.stringify(value));
export function reactHarness() {
  let cells = [], cursor = 0, effects = [], cleanups = [], component, props;
  const render = () => { cursor = 0; return component(props); };
  const React = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, ...(children.length ? { children: children.length === 1 ? children[0] : children } : {}) } }),
    useState(initial) { const i = cursor++; if (!(i in cells)) cells[i] = typeof initial === 'function' ? initial() : initial; return [cells[i], v => { cells[i] = typeof v === 'function' ? v(cells[i]) : v; }]; },
    useRef(initial) { const i = cursor++; return cells[i] ??= { current: initial }; },
    useEffect(fn) { effects.push(fn); },
    useSyncExternalStore: (subscribe, snapshot) => { cleanups.push(subscribe(() => {})); return snapshot(); },
    useId: () => 'test-id',
    cloneElement: (node, props) => ({ ...node, props: { ...node.props, ...props } }),
  };
  return { React, mount(fn, p) { component = fn; props = p; return render(); }, render,
    flush() { for (const fn of effects.splice(0)) { const c = fn(); if (c) cleanups.push(c); } },
    unmount() { for (const c of cleanups.splice(0)) c(); },
  };
}
export function find(node, predicate) {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) { for (const n of node) { const hit = find(n, predicate); if (hit) return hit; } return null; }
  if (predicate(node)) return node;
  return find(node.props?.children, predicate);
}
// Test-only private access; production artifacts and exports stay unchanged.
export async function hostScope(extra = {}) {
  const code = (await read('lib/index.js')).replace(/^import .*;\r?$/gm, '').replace(/^export .*;\r?$/gm, '');
  const names = ['apply','readState','saveState','readBody','readJsonBody','resolveRoute','finishFailure','accumulateText','callModel','parseWholeObject','readRewriteAnswer','nominateReferences','withSignal','resolveFileReferences','listAvailableSkills','resolveSkillReferences','appendReferences','normalizeState','formatFileMention','formatSkillGesture','normalizeSkillMode','composeSystemPrompt','skillCandidateRule','lostOriginalPaths','nominationMatches'];
  const evaluated = code + '\n;({'+names.join(',')+'})';
  return runInNewContext(evaluated, { ...fs, homedir, dirname, join, process, Buffer, AbortSignal, setTimeout, clearTimeout, ...extra }, { filename: recordSource(join(root, 'lib/index.js'), evaluated) });
}
export async function clientScope(extra = {}) {
  const harness = reactHarness();
  const names = ['apply','inject','zh','en','CSS','ensureStyleTag','installSettingsNavIcon','settingsStore','catalogStore','PromptForgeButton','PromptForgeSettings','Picker','PickerOption','ModelPicker','ReferenceToggle','SkillModePicker','translate','effectiveSelection','modelName','effortName','appendedTip','referenceResultTip','useLastFailure','useLastReferenceResult','setLastFailure','setLastReferenceResult'];
  const code = (await read('lib/client.js')).replace('return module.exports;', 'return {...module.exports,'+names.join(',')+'};');
  const primitives = Object.fromEntries(['IconCheckOutlineRegular','IconChevronDownOutlineRegular','IconLoadingOutlineRegular','MenuGroup','Tooltip'].map(n => [n, n]));
  let api;
  runInNewContext(code, { window: { __ModuleLoader__: { load(registration) { api = registration.factory(n => { if (n === 'react') return harness.React; if (n === '@deepseek-ai/dsh-client-ui-primitives') return primitives; throw Error('unexpected DSH import: '+n); }); } } }, setTimeout, clearTimeout, fetch: async () => ({ ok: true, json: async () => ({}) }), ...extra }, { filename: recordSource(join(root, 'lib/client.js'), code) });
  return { ...api, harness };
}
export function documentFixture() {
  const tags = new Map(), listeners = new Map(), labels = [], observers = [];
  const document = {
    body: {}, getElementById: id => tags.get(id) ?? null,
    createElement: () => ({ setAttribute() {}, remove() { tags.delete(this.id); } }),
    head: { appendChild(node) { tags.set(node.id, node); } },
    querySelectorAll: selector => selector === '[data-pf-nav-icon]' ? labels.map(l => l.parentElement).filter(b => b.marked) : labels,
    addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: (name, fn) => { if (listeners.get(name) === fn) listeners.delete(name); },
  };
  class MutationObserver { constructor(fn) { this.fn = fn; observers.push(this); } observe(target, opts) { this.target = target; this.opts = opts; } disconnect() { this.disconnected = true; } }
  const addLabel = text => { const button = { marked: false, setAttribute() { this.marked = true; }, removeAttribute() { this.marked = false; } }; const label = { textContent: text, parentElement: button }; labels.push(label); return label; };
  return { document, MutationObserver, tags, listeners, labels, observers, addLabel };
}
