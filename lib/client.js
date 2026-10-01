/* dsh-prompt-forge v1.0.0 — generated browser half. Edit src/ and run "node build.mjs". */
window.__ModuleLoader__.load({
	id: "dsh-prompt-forge",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
const PLUGIN_VERSION = "1.0.0";
/* ------------------------------------------------------------------ identity */

/**
 * Plugin identity. This is the Cordis row id in `cordis.patch.yml` and the
 * module id the browser loader registers under, so the two halves and the
 * profile entry agree on one string.
 */
const PACKAGE_NAME = 'dsh-prompt-forge';

/** Browser route carrying the durable settings document (GET read, POST patch). */
const STATE_ROUTE = '/prompt-forge/state';

/** Browser route performing one optimization call (POST). */
const OPTIMIZE_ROUTE = '/prompt-forge/optimize';

/** Browser route recording one client-side failure in the Host log (POST). */
const REPORT_ROUTE = '/prompt-forge/report';

/* ------------------------------------------------------------------ defaults */

/** Longest draft accepted for one optimization, in characters. */
const MAX_INPUT_CHARS = 60000;

/** Upper bound on generated prompt length, in tokens. */
const MAX_OUTPUT_TOKENS = 4096;

/** One optimization call must settle within this many milliseconds. */
const REQUEST_TIMEOUT_MS = 120000;

/** Appended to the composer output when the model produced nothing usable. */
const EMPTY_OUTPUT_MESSAGE = 'prompt-forge: the model returned no usable prompt text';

/**
 * The rewrite instruction. Placeholders keep the two variable parts (the text
 * and the plugin's standing rules) visible to anyone reading this constant.
 */
const DEFAULT_SYSTEM_PROMPT = `You are PromptForge, a prompt-engineering assistant embedded in a coding agent's composer.

The user hands you the text currently sitting in their message box. Rewrite it into a clear, high-signal prompt that the agent can act on immediately.

Rules:
- Preserve the author's intent, language, and every concrete detail, constraint, path, command, identifier, and code block. Never invent requirements, and never answer the request yourself.
- Keep the text in the same natural language the user wrote in (Chinese stays Chinese, English stays English).
- When the text is vague, make the goal, the relevant context, the expected deliverable, and any real acceptance criteria explicit — without adding scope the author did not imply.
- When the text already reads well, make only light corrections instead of padding it.
- Structure only as much as the content earns: plain prose for short asks, a short labelled list when there are several distinct requirements. Do not force a template onto a simple request.
- Keep any leading slash command, file reference, or mention marker exactly where the author put it, and keep it on the first line.

Output contract:
- Reply with the rewritten prompt only.
- No preamble, no explanation, no commentary, no surrounding quotes or code fences, and no trailing notes about what you changed.
- If the input is already an excellent prompt, reply with it unchanged rather than describing it.`;

/* ------------------------------------------------------------------ settings */

/**
 * Coerce one stored document onto the defaults.
 *
 * A stored file may be truncated, hand-edited, or written by an older build, so
 * every field is validated instead of trusted. An empty model or provider means
 * "unset": the Host then falls back to the deployment default model.
 *
 * @param input - unknown stored value.
 * @returns a complete, safe settings document.
 */
function normalizeState(input) {
  const source = input !== null && typeof input === 'object' ? input : {};
  const text = (value) => (typeof value === 'string' ? value : '');
  const systemPrompt = text(source.systemPrompt).trim();
  return {
    provider: text(source.provider).trim(),
    model: text(source.model).trim(),
    reasoningEffort: text(source.reasoningEffort).trim(),
    systemPrompt: systemPrompt === '' ? DEFAULT_SYSTEM_PROMPT : systemPrompt,
  };
}

/** The defaults, built through the same validator so the shapes cannot drift. */
const DEFAULT_STATE = normalizeState({});
		const { IconLoadingOutlineRegular, Tooltip } = require("@deepseek-ai/dsh-client-ui-primitives");
/**
 * dsh-prompt-forge — browser half.
 *
 * Two surfaces, both additive:
 *
 *   1. `conversation.input.right` — a text-and-spark control beside the composer's
 *      submit action. It exists only while the draft has text; clicking it
 *      replaces the whole draft with a model-optimized prompt and never sends.
 *      While the call is in flight it becomes a spinner.
 *   2. `settings.section` — the PromptForge page, where the model, the
 *      reasoning effort, and the rewrite instruction are chosen. The model list
 *      is the live Host catalog, so it is exactly the set of models the rest of
 *      DSH can route to.
 *
 * The durable settings document and the model call live in the Host half; this
 * half only reads and writes them over same-origin routes.
 *
 * @module dsh-prompt-forge/client
 */



/**
 * The React runtime the loader exposes as a module-global. The `require`
 * fallback keeps the bundle usable in a wrapper that only ships the module
 * factory (the offline self-check does exactly that).
 */
const ReactRuntime = typeof React === 'undefined' ? require('react') : React;

/** A text-and-spark mark that follows the button's theme and state colors. */
function PromptForgeTextSparkIcon({ size = 20, ...props }) {
  return ReactRuntime.createElement('svg', {
    ...props, width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
    stroke: 'currentColor', strokeWidth: 2.2, strokeLinecap: 'round', strokeLinejoin: 'round',
    focusable: 'false',
  }, [
    ReactRuntime.createElement('path', { key: 'text', d: 'M4 7h9M4 12h12M4 17h8' }),
    ReactRuntime.createElement('path', { key: 'spark', stroke: 'none', fill: 'currentColor', d: 'm18 2 1.35 3.65L23 7l-3.65 1.35L18 12l-1.35-3.65L13 7l3.65-1.35Z' }),
  ]);
}

/* Locale namespace every visible string of this plugin lives under. */
const NS = PACKAGE_NAME;

/* Simplified Chinese keys are the source of truth; English is checked complete. */
const zh = {
  'action.title': '优化提示词',
  'action.aria': '优化提示词（不发送）',
  'action.busy': '正在优化提示词…',
  'action.failed': '优化失败：{message}',
  'nav': '提示词优化',
  'intro': '在输入框旁点击优化按钮，当前草稿就会被重写成更清晰的提示词。优化结果只替换输入框内容，不会自动发送。',
  'model.heading': '模型',
  'model.hint': '使用 DSH 已配置的模型；此处列出的就是当前可路由的全部模型。',
  'model.default': '跟随默认模型（{name}）',
  'effort.heading': '思考强度',
  'effort.hint': '选“默认”时由模型自己决定强度。',
  'effort.default': '默认',
  'effort.unsupported': '当前模型未提供思考强度等级。',
  'effort.followUp': '仅用于提示词优化，不会改变聊天会话的模型或思考强度。',
  'prompt.heading': '优化指令',
  'prompt.hint': '发送给模型的系统提示词，决定重写风格。',
  'prompt.reset': '恢复默认',
  'status.loading': '正在读取模型目录…',
  'status.saved': '已保存',
  'status.saving': '正在保存…',
  'status.failed': '保存失败：{message}',
  'failures.heading': '不可用的提供方',
  'lastError.heading': '最近一次优化失败',
  'about.heading': '关于',
  'about.body': '当前版本 {version}。优化走的是一次独立的模型请求，不会写入会话记录；输入框内容何时发送由你决定。',
};

/* English dictionary, keyed identically to the Chinese one. */
const en = {
  'action.title': 'Optimize prompt',
  'action.aria': 'Optimize prompt (does not send)',
  'action.busy': 'Optimizing prompt…',
  'action.failed': 'Optimization failed: {message}',
  'nav': 'Prompt Forge',
  'intro': 'Click the text-and-spark button beside the composer and the current draft is rewritten into a clearer prompt. The result only replaces the composer text — it is never sent for you.',
  'model.heading': 'Model',
  'model.hint': 'Uses the models DSH already has configured; this list is exactly what can be routed right now.',
  'model.default': 'Follow the default model ({name})',
  'effort.heading': 'Reasoning effort',
  'effort.hint': '"Default" lets the model decide its own effort.',
  'effort.default': 'Default',
  'effort.unsupported': 'This model exposes no reasoning effort levels.',
  'effort.followUp': 'Applies only to prompt optimization. Your conversation model and reasoning effort stay unchanged.',
  'prompt.heading': 'Rewrite instruction',
  'prompt.hint': 'The system prompt sent to the model; it decides the rewriting style.',
  'prompt.reset': 'Restore default',
  'status.loading': 'Loading the model catalog…',
  'status.saved': 'Saved',
  'status.saving': 'Saving…',
  'status.failed': 'Save failed: {message}',
  'failures.heading': 'Unavailable providers',
  'lastError.heading': 'Last optimization failure',
  'about.heading': 'About',
  'about.body': 'Version {version}. The optimization is one standalone model request and is never written to the session log; you decide when the composer text is sent.',
};

/** Services this half needs before apply runs. */
const inject = ['slots', 'locale', 'sessions', 'remote', 'remote.session'];

/* ------------------------------------------------------------------- shared */

/** `t('key', { name: value })` with `{name}` interpolation. */
function translate(dict) {
  return (key, params) => {
    const template = dict[key] ?? key;
    if (params === undefined) return template;
    return template.replace(/\{(\w+)\}/g, (match, name) => (
      Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
    ));
  };
}

/** One stylesheet tag for this plugin, created on first use. */
const STYLE_TAG_ID = `${PACKAGE_NAME}-style`;

const NAV_ICON_MASK = `url("data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"><path d="M4 7h9M4 12h12M4 17h8" stroke="black" stroke-width="2.2" stroke-linecap="round"/><path d="m18 2 1.35 3.65L23 7l-3.65 1.35L18 12l-1.35-3.65L13 7l3.65-1.35Z" fill="black"/></svg>')}")`;

/** The rules every surface of this plugin reads. */
const CSS = `
[data-shortcut-modal="settings"] button[data-pf-nav-icon] > svg{display:none}
[data-shortcut-modal="settings"] button[data-pf-nav-icon]::before{content:"";display:block;flex:none;width:16px;height:16px;background:currentColor;mask:${NAV_ICON_MASK} center/contain no-repeat;-webkit-mask:${NAV_ICON_MASK} center/contain no-repeat}
[data-plugin-detail="dsh-prompt-forge"] [class$="_detailDesc"],
[data-plugin-detail="dsh-prompt-forge"] [data-plugin-row] [class$="_rowModule"]{white-space:pre-line}
.PF-btn{display:inline-flex;align-items:center;justify-content:center;flex:none;width:28px;height:28px;padding:0;border:0;border-radius:999px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;transition:background-color .12s,color .12s,opacity .12s}
.PF-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.PF-btn:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.PF-btn:disabled{cursor:default;color:var(--dsw-alias-label-dimmed);opacity:1}
.PF-btn[data-busy=true]{color:var(--dsw-alias-state-business-primary)}
.PF-btn[data-failed=true]{color:var(--dsw-alias-state-error-primary)}
.PF-spin{animation:PF-spin .9s linear infinite;transform-origin:50% 50%}
@keyframes PF-spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.PF-spin{animation-duration:2.4s}}
.PF-page{display:flex;flex-direction:column;gap:16px;max-width:720px;padding:4px 0 24px;color:var(--dsw-alias-label-primary)}
.PF-page h3{margin:0;font-size:14px;font-weight:500;line-height:22px}
.PF-intro{margin:0;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}
.PF-card{display:flex;flex-direction:column;gap:8px;padding:12px 14px;border:.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-settings-card-fill)}
.PF-hint{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.PF-select{box-sizing:border-box;width:100%;height:36px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;outline:none}
.PF-select:focus-visible{border-color:var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}
.PF-select:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}
.PF-head{display:flex;align-items:center;justify-content:space-between;gap:12px}
.PF-textarea{box-sizing:border-box;width:100%;min-height:180px;padding:10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xs-13);line-height:1.6;resize:vertical;outline:none}
.PF-textarea:focus-visible{border-color:var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));color:var(--dsw-alias-label-primary)}
.PF-ghost{height:28px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}
.PF-ghost:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.PF-status{font-size:12px;line-height:18px;color:var(--dsw-alias-label-caption)}
.PF-status[data-tone=error]{color:var(--dsw-alias-state-error-primary)}
.PF-status[data-tone=ok]{color:var(--dsw-alias-state-success-primary)}
.PF-error{margin:0;padding:8px 10px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;overflow-wrap:anywhere}
`;

/** Insert the plugin stylesheet once; the disposer removes it. */
function ensureStyleTag() {
  if (typeof document === 'undefined') return () => {};
  const existing = document.getElementById(STYLE_TAG_ID);
  if (existing !== null) return () => {};
  const tag = document.createElement('style');
  tag.id = STYLE_TAG_ID;
  tag.setAttribute('data-plugin', PACKAGE_NAME);
  tag.textContent = CSS;
  document.head.appendChild(tag);
  return () => {
    tag.remove();
  };
}

/** DSH currently gives custom settings sections a fixed gear, with no icon slot. */
function installSettingsNavIcon() {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return () => {};
  const labels = new Set([zh.nav, en.nav]);
  const selector = '[data-shortcut-modal="settings"] button > span[class$="_navLabel"]';
  const update = () => {
    for (const label of document.querySelectorAll(selector)) {
      const button = label.parentElement;
      if (labels.has(label.textContent.trim())) button.setAttribute('data-pf-nav-icon', '');
      else button.removeAttribute('data-pf-nav-icon');
    }
  };
  const observer = new MutationObserver(update);
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  update();
  return () => {
    observer.disconnect();
    for (const button of document.querySelectorAll('[data-pf-nav-icon]')) button.removeAttribute('data-pf-nav-icon');
  };
}

/* -------------------------------------------------------- settings document */

/**
 * The durable settings, held in one module-level store.
 *
 * The Host copy is authoritative, but writes apply locally first so the page
 * answers a click immediately; a failure is surfaced instead of silently
 * diverging.
 */
const settingsStore = (() => {
  let value = undefined;
  const listeners = new Set();
  let inflight = null;
  let lastError = null;
  let pendingSave = null;
  let saving = false;
  let snapshot = { value, error: lastError, saving };

  const emit = () => {
    snapshot = { value, error: lastError, saving };
    for (const listener of [...listeners]) listener();
  };

  const load = () => {
    if (inflight !== null) return inflight;
    inflight = fetch(STATE_ROUTE, { headers: { accept: 'application/json' } }).then(
      async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      },
    ).then(
      (data) => {
        if (data === null || typeof data !== 'object') throw new Error('invalid settings response');
        value = data;
        lastError = null;
        emit();
        return value;
      },
    ).catch((error) => {
      lastError = String(error?.message ?? error);
      emit();
      return value;
    }).finally(() => {
      inflight = null;
    });
    return inflight;
  };

  const save = async () => {
    pendingSave = value;
    if (saving || pendingSave === undefined) return;
    saving = true;
    emit();
    try {
      while (pendingSave !== null) {
        const patch = pendingSave;
        pendingSave = null;
        try {
          const response = await fetch(STATE_ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(patch),
          });
          if (!response.ok) {
            const body = await response.json().catch(() => null);
            throw new Error(body?.error ?? `HTTP ${response.status}`);
          }
          const saved = await response.json();
          if (pendingSave === null) value = saved;
          lastError = null;
        } catch (error) {
          lastError = String(error?.message ?? error);
        }
        emit();
      }
    } finally {
      saving = false;
      emit();
    }
  };

  return {
    /** Read the current document (undefined until the first load settles). */
    get: () => snapshot,
    /** The most recent read/write failure, if any. */
    error: () => lastError,
    saving: () => saving,
    /** Subscribe to document changes. */
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** Load once; repeated calls share the in-flight request. */
    ensure: () => {
      if (value === undefined) load().catch(() => {});
    },
    /** Merge a patch locally and persist it. */
    patch: (next) => {
      value = { ...(value ?? {}), ...next };
      lastError = null;
      emit();
      save();
    },
  };
})();

/** Subscribe one component to the settings document. */
function useSettings() {
  return ReactRuntime.useSyncExternalStore(settingsStore.subscribe, settingsStore.get, settingsStore.get).value;
}

/* ----------------------------------------------------------- model catalog */

/**
 * The live Host model catalog, fetched once per page load.
 *
 * Entries mirror `ctx.remote.session.modelCatalog()`: provider groups with
 * their models, plus per-model reasoning metadata and isolated provider
 * failures.
 */
const catalogStore = (() => {
  let value = null;
  let status = 'idle';
  let error = null;
  let snapshot = { value, status, error };
  const listeners = new Set();

  const emit = () => {
    snapshot = { value, status, error };
    for (const listener of [...listeners]) listener();
  };

  return {
    get: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    ensure: (ctx) => {
      if (status !== 'idle' || ctx === null) return;
      status = 'loading';
      emit();
      ctx.remote.session.modelCatalog().then(
        (response) => {
          if (response === null || typeof response !== 'object' || !response.ok) {
            throw new Error(response?.error?.message ?? 'the model catalog could not be loaded');
          }
          value = response.value;
          status = 'ready';
          error = null;
          emit();
        },
      ).catch((failure) => {
          status = 'error';
          error = String(failure?.message ?? failure);
          emit();
      });
    },
  };
})();

/** Subscribe one component to the model catalog. */
function useCatalog() {
  return ReactRuntime.useSyncExternalStore(catalogStore.subscribe, catalogStore.get, catalogStore.get);
}

/** Read the last optimization failure, shared by the button and the settings page. */
let lastFailure = null;
const failureListeners = new Set();
function setLastFailure(message) {
  lastFailure = message;
  for (const listener of [...failureListeners]) listener();
}
function useLastFailure() {
  return ReactRuntime.useSyncExternalStore(
    (listener) => {
      failureListeners.add(listener);
      return () => {
        failureListeners.delete(listener);
      };
    },
    () => lastFailure,
    () => lastFailure,
  );
}

/* --------------------------------------------------------------- utilities */

/** Find one provider group by id. */
function findGroup(catalog, providerId) {
  return catalog?.groups?.find((group) => group.id === providerId);
}

/** Find one model entry inside a provider group. */
function findModel(group, modelId) {
  return group?.models?.find((model) => model.id === modelId);
}

/** Render a selection as `provider / model`. */
function selectionLabel(catalog, selection) {
  const group = findGroup(catalog, selection.provider);
  const model = findModel(group, selection.model);
  if (model === undefined) return `${selection.provider} / ${selection.model}`;
  return `${group?.name ?? selection.provider} / ${model.name ?? model.id}`;
}

/**
 * Read the selection whose effort levels the settings page offers.
 *
 * A stored selection that is no longer routable falls back to the deployment
 * default, so setting the effort never writes a model the Host cannot run.
 */
function effectiveSelection(catalog, settings) {
  if (settings === undefined || catalog === null) return null;
  const stored = settings.provider !== '' && settings.model !== ''
    ? { provider: settings.provider, model: settings.model }
    : null;
  if (stored !== null && findModel(findGroup(catalog, stored.provider), stored.model) !== undefined) {
    return stored;
  }
  const fallback = catalog.default;
  if (fallback?.provider === undefined || fallback?.model === undefined) return null;
  return { provider: fallback.provider, model: fallback.model };
}

/* ------------------------------------------------------------ composer seat */

/**
 * The text-and-spark control beside the composer submit action.
 *
 * It renders nothing while the draft is empty, which is what makes it "appear
 * when there is text". While a call is in flight it renders a spinner and takes
 * no further clicks; on success it replaces the whole draft through the
 * conversation input actions and never submits.
 */
function PromptForgeButton(props) {
  const { ref, sessionId, useInput, inputActions, t } = props;
  const draft = useInput((state) => state.draft);
  const phase = useInput((state) => state.phase);
  const draftRev = useInput((state) => state.draftRev);
  const [busy, setBusy] = ReactRuntime.useState(false);
  const [failed, setFailed] = ReactRuntime.useState(false);
  /* The draft this component last rendered: the async callback compares against
     it so a reply can never overwrite text the user changed or sent mid-flight. */
  const latest = ReactRuntime.useRef(null);
  latest.current = { draft, draftRev, phase, sessionId };
  const running = ReactRuntime.useRef(false);
  const mounted = ReactRuntime.useRef(true);
  ReactRuntime.useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const hasText = typeof draft === 'string' && draft.trim() !== '';
  /* A composer that is already committing a send must not have its draft replaced. */
  const locked = phase === 'adjudicating' || phase === 'submitting';

  ReactRuntime.useEffect(() => {
    if (!failed) return undefined;
    const timer = setTimeout(() => setFailed(false), 2600);
    return () => clearTimeout(timer);
  }, [failed]);

  const run = async () => {
    if (running.current || busy || locked || !hasText) return;
    const text = draft;
    const revision = draftRev;
    running.current = true;
    setBusy(true);
    setFailed(false);
    try {
      const response = await fetch(OPTIMIZE_ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || body === null || typeof body.prompt !== 'string' || body.prompt.trim() === '') {
        throw new Error(body?.error ?? `HTTP ${response.status}`);
      }
      /* Never clobber a draft the user replaced or submitted mid-flight. */
      const current = latest.current;
      if (!mounted.current || current.draft !== text || current.draftRev !== revision
        || current.sessionId !== sessionId || current.phase === 'adjudicating' || current.phase === 'submitting') {
        setBusy(false);
        return;
      }
      inputActions.setDraft(body.prompt);
      setLastFailure(null);
      setBusy(false);
    } catch (error) {
      const message = String(error?.message ?? error);
      setLastFailure(message);
      setFailed(true);
      setBusy(false);
      /* Surface the failure in the Host log too: the button has no room for it. */
      fetch(REPORT_ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message }),
      }).catch(() => {});
    } finally {
      running.current = false;
    }
  };

  if (!hasText && !busy) return null;

  const tip = busy
    ? t('action.busy')
    : failed ? t('action.failed', { message: lastFailure ?? '' }) : t('action.title');
  return ReactRuntime.createElement(Tooltip, {
    label: tip,
    side: 'top',
    delayMs: 400,
  }, ReactRuntime.createElement('button', {
    ref,
    type: 'button',
    className: 'PF-btn',
    'data-busy': busy ? 'true' : 'false',
    'data-failed': failed ? 'true' : 'false',
    'aria-label': busy ? t('action.busy') : t('action.aria'),
    'aria-busy': busy ? 'true' : 'false',
    disabled: busy || locked,
    onMouseDown: (event) => event.preventDefault(),
    onClick: () => {
      run().catch(() => {});
    },
  }, ReactRuntime.createElement(busy ? IconLoadingOutlineRegular : PromptForgeTextSparkIcon, {
    size: busy ? 16 : 20,
    className: busy ? 'PF-spin' : undefined,
    'aria-hidden': true,
  })));
}

/* ------------------------------------------------------------ settings page */

/** One labelled card with an explanatory hint. */
function Section(props) {
  return ReactRuntime.createElement('section', { className: 'PF-card' }, [
    ReactRuntime.createElement('h3', { key: 'h' }, props.title),
    props.children,
    props.hint === undefined ? null : ReactRuntime.createElement('p', { key: 'p', className: 'PF-hint' }, props.hint),
  ]);
}

/** The PromptForge settings page. */
function PromptForgeSettings(props) {
  const t = props.t;
  const settings = useSettings();
  const catalog = useCatalog();
  const used = effectiveSelection(catalog.value, settings);
  const failure = useLastFailure();
  const [promptDraft, setPromptDraft] = ReactRuntime.useState(null);
  const [saved, setSaved] = ReactRuntime.useState(false);
  const settled = ReactRuntime.useRef(false);
  const saving = settingsStore.saving();

  ReactRuntime.useEffect(() => {
    settingsStore.ensure();
    catalogStore.ensure(clientCtx);
  }, []);

  ReactRuntime.useEffect(() => {
    if (settings === undefined) return undefined;
    if (saving || settingsStore.error() !== null) {
      setSaved(false);
      return undefined;
    }
    /* The first settle is the initial load, not a save. */
    if (!settled.current) {
      settled.current = true;
      return undefined;
    }
    setSaved(true);
    const timer = setTimeout(() => setSaved(false), 1400);
    return () => clearTimeout(timer);
  }, [settings, saving]);

  const groups = catalog.value?.groups ?? [];
  const failures = catalog.value?.failures ?? [];
  const reasoning = used === null
    ? undefined
    : findModel(findGroup(catalog.value, used.provider), used.model)?.reasoning;
  const storedModel = settings !== undefined && settings.provider !== '' && settings.model !== ''
    ? { provider: settings.provider, model: settings.model }
    : null;
  const prompt = promptDraft ?? settings?.systemPrompt ?? '';
  const error = settingsStore.error();

  const chooseModel = (event) => {
    const raw = event.target.value;
    if (raw === '') {
      settingsStore.patch({ provider: '', model: '', reasoningEffort: '' });
      return;
    }
    const separator = raw.indexOf('\u0000');
    settingsStore.patch({
      provider: raw.slice(0, separator),
      model: raw.slice(separator + 1),
      reasoningEffort: '',
    });
  };

  return ReactRuntime.createElement('div', { className: 'PF-page' }, [
    ReactRuntime.createElement('p', { key: 'intro', className: 'PF-intro' }, t('intro')),

    ReactRuntime.createElement(Section, {
      key: 'model',
      title: t('model.heading'),
      hint: t('model.hint'),
    }, [
      catalog.status === 'loading'
        ? ReactRuntime.createElement('p', { key: 'loading', className: 'PF-hint' }, t('status.loading'))
        : null,
      catalog.status === 'error'
        ? ReactRuntime.createElement('p', { key: 'error', className: 'PF-error' }, catalog.error)
        : null,
      ReactRuntime.createElement('select', {
        key: 'select',
        className: 'PF-select',
        value: storedModel === null ? '' : `${storedModel.provider}\u0000${storedModel.model}`,
        disabled: groups.length === 0 || settings === undefined,
        onChange: chooseModel,
        'aria-label': t('model.heading'),
      }, [
        ReactRuntime.createElement('option', { key: 'default', value: '' },
          t('model.default', {
            name: catalog.value?.default === undefined
              ? '—'
              : selectionLabel(catalog.value, catalog.value.default),
          })),
        ...groups.flatMap((group) => group.models.map((model) => ReactRuntime.createElement('option', {
          key: `${group.id}\u0000${model.id}`,
          value: `${group.id}\u0000${model.id}`,
        }, `${group.name ?? group.id} / ${model.name ?? model.id}`))),
      ]),
    ]),

    ReactRuntime.createElement(Section, {
      key: 'effort',
      title: t('effort.heading'),
      hint: reasoning === undefined ? t('effort.unsupported') : t('effort.hint'),
    }, [
      ReactRuntime.createElement('select', {
        key: 'select',
        className: 'PF-select',
        value: settings?.reasoningEffort ?? '',
        disabled: reasoning === undefined || settings === undefined,
        onChange: (event) => settingsStore.patch({ reasoningEffort: event.target.value }),
        'aria-label': t('effort.heading'),
      }, [
        ReactRuntime.createElement('option', { key: 'default', value: '' }, t('effort.default')),
        ...(reasoning?.efforts ?? []).map((level) => ReactRuntime.createElement('option', {
          key: level.id,
          value: level.id,
        }, level.description === undefined ? level.name : `${level.name} — ${level.description}`)),
      ]),
      ReactRuntime.createElement('p', { key: 'note', className: 'PF-hint' }, t('effort.followUp')),
    ]),

    ReactRuntime.createElement(Section, {
      key: 'prompt',
      title: t('prompt.heading'),
      hint: t('prompt.hint'),
    }, [
      ReactRuntime.createElement('div', { key: 'head', className: 'PF-head' }, [
        ReactRuntime.createElement('span', {
          key: 'status',
          className: 'PF-status',
          'data-tone': error === null ? 'ok' : 'error',
        }, error === null ? (saving ? t('status.saving') : saved ? t('status.saved') : '') : t('status.failed', { message: error })),
        ReactRuntime.createElement('button', {
          key: 'reset',
          type: 'button',
          className: 'PF-ghost',
          disabled: settings === undefined,
          onClick: () => {
            setPromptDraft(null);
            settingsStore.patch({ systemPrompt: '' });
          },
        }, t('prompt.reset')),
      ]),
      ReactRuntime.createElement('textarea', {
        key: 'textarea',
        className: 'PF-textarea',
        value: prompt,
        spellCheck: false,
        disabled: settings === undefined,
        'aria-label': t('prompt.heading'),
        onChange: (event) => setPromptDraft(event.target.value),
        onBlur: () => {
          if (promptDraft === null) return;
          setPromptDraft(null);
          settingsStore.patch({ systemPrompt: promptDraft });
        },
      }),
    ]),

    failures.length === 0 ? null : ReactRuntime.createElement(Section, {
      key: 'failures',
      title: t('failures.heading'),
    }, failures.map((item) => ReactRuntime.createElement('p', {
      key: item.id,
      className: 'PF-error',
    }, `${item.name ?? item.id}: ${item.message ?? ''}`))),

    failure === null ? null : ReactRuntime.createElement(Section, {
      key: 'last-error',
      title: t('lastError.heading'),
    }, ReactRuntime.createElement('p', { className: 'PF-error' }, failure)),

    ReactRuntime.createElement(Section, {
      key: 'about',
      title: t('about.heading'),
    }, ReactRuntime.createElement('p', { className: 'PF-hint' }, t('about.body', { version: PLUGIN_VERSION }))),
  ]);
}

/* ------------------------------------------------------------------- apply */

/**
 * The context `apply` ran with. Slot components cannot import it, so the
 * settings page reads the Remote namespace from here.
 */
let clientCtx = null;

/**
 * Client plugin body.
 *
 * @param ctx - the plugin context.
 */
function apply(ctx) {
  clientCtx = ctx;
  ctx.effect(() => ensureStyleTag(), `${PACKAGE_NAME}: stylesheet`);
  ctx.effect(() => installSettingsNavIcon(), `${PACKAGE_NAME}: settings navigation icon`);

  const t = ctx.locale.bind(NS);
  ctx.locale.register(NS, 'zh', zh);
  ctx.locale.register(NS, 'en', en);

  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right',
    id: PACKAGE_NAME,
    order: 40,
    locale: NS,
    /* The seat hands the Session id to the entry's business props; composer
       state arrives through the framework's `useInput`/`inputActions` channel. */
    inject: (sessionId) => ({ sessionId }),
  }, PromptForgeButton));

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: PACKAGE_NAME,
    order: 40,
    label: () => t('nav'),
    locale: NS,
  }, PromptForgeSettings));
}

exports.apply = apply;
exports.inject = inject;

		return module.exports;
	}
});
