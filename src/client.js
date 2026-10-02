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

import {
  IconCheckOutlineRegular,
  IconChevronDownOutlineRegular,
  IconLoadingOutlineRegular,
  MenuGroup,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives';

/**
 * The React runtime the loader exposes as a module-global. The `require`
 * fallback keeps the bundle usable in a wrapper that only ships the module
 * factory (the offline self-check does exactly that).
 */
const ReactRuntime = typeof React === 'undefined' ? require('react') : React;
const { useEffect, useRef, useState } = ReactRuntime;

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
  'action.appended': '已追加{parts}。',
  'action.appendedJoin': '、',
  'action.appendedFiles': ' {count} 个文件引用',
  'action.appendedSkills': ' {count} 个技能引用',
  'reference.statusHeading': '最近一次引用处理',
  'reference.complete': '引用已确认；本次新增 {files} 个文件引用、{skills} 个技能引用。',
  'reference.none': '未发现相关引用。',
  'reference.partial': '引用处理未全部完成；本次新增 {files} 个文件引用、{skills} 个技能引用。',
  'reference.preserved': '改写丢失了原始路径或引用，已保留原稿。',
  'reference.disabled': '自动引用已关闭。',
  'reference.heading': '自动引用',
  'reference.hint': '优化完成后，把这次改写真正依赖的文件与技能追加到提示词末尾。',
  'reference.files': '引用文件',
  'reference.filesHint': '由模型提名、再经当前工作区的文件索引校验；只保留真实存在的路径。',
  'reference.skills': '引用技能',
  'reference.skillsHint': '由模型提名、再经技能目录校验；命中的技能会以名称列出。',
  'toggle.on': '开',
  'toggle.off': '关',
  'nav': '提示词优化',
  'intro': '在输入框旁点击优化按钮，当前草稿就会被重写成更清晰的提示词。优化结果只替换输入框内容，不会自动发送。',
  'model.heading': '模型',
  'model.hint': '使用 DSH 已配置的模型；此处列出的就是当前可路由的全部模型。',
  'model.default': '跟随默认模型（{name}）',
  'model.followingGroup': '默认',
  'model.search': '搜索模型…',
  'model.empty': '没有匹配的模型。',
  'model.aria': '选择模型，当前 {name}',
  'model.listAria': '模型列表',
  'model.statusLoading': '正在读取模型目录…',
  'model.statusError': '模型目录读取失败：{message}',
  'model.statusFailed': '不可用的提供方：{message}',
  'model.statusEmpty': '当前 DSH 没有可用的模型。',
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
  'action.appended': 'Appended{parts}.',
  'action.appendedJoin': ' and',
  'action.appendedFiles': ' {count} file reference(s)',
  'action.appendedSkills': ' {count} skill reference(s)',
  'reference.statusHeading': 'Last reference processing result',
  'reference.complete': 'References confirmed; added {files} file and {skills} skill reference(s).',
  'reference.none': 'No relevant references found.',
  'reference.partial': 'Reference processing was incomplete; added {files} file and {skills} skill reference(s).',
  'reference.preserved': 'The rewrite lost original paths or mentions; your original draft was preserved.',
  'reference.disabled': 'Automatic references are off.',
  'reference.heading': 'Automatic references',
  'reference.hint': 'After a rewrite, append the files and skills that rewrite actually depends on.',
  'reference.files': 'Reference files',
  'reference.filesHint': 'The model nominates paths and the workspace file index confirms them; only paths that really exist survive.',
  'reference.skills': 'Reference skills',
  'reference.skillsHint': 'The model nominates names and the skill catalog confirms them; matches are listed by name.',
  'toggle.on': 'On',
  'toggle.off': 'Off',
  'nav': 'Prompt Forge',
  'intro': 'Click the text-and-spark button beside the composer and the current draft is rewritten into a clearer prompt. The result only replaces the composer text — it is never sent for you.',
  'model.heading': 'Model',
  'model.hint': 'Uses the models DSH already has configured; this list is exactly what can be routed right now.',
  'model.default': 'Follow the default model ({name})',
  'model.followingGroup': 'Default',
  'model.search': 'Search models…',
  'model.empty': 'No matching model.',
  'model.aria': 'Select model, current {name}',
  'model.listAria': 'Model list',
  'model.statusLoading': 'Loading the model catalog…',
  'model.statusError': 'The model catalog could not be loaded: {message}',
  'model.statusFailed': 'Unavailable provider: {message}',
  'model.statusEmpty': 'This DSH composition exposes no model.',
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
.PF-head{display:flex;align-items:center;justify-content:space-between;gap:12px}
.PF-textarea{box-sizing:border-box;width:100%;min-height:180px;padding:10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xs-13);line-height:1.6;resize:vertical;outline:none}
.PF-textarea:focus-visible{border-color:var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));color:var(--dsw-alias-label-primary)}
.PF-ghost{height:28px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}
.PF-ghost:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.PF-picker{min-width:0;position:relative}
.PF-pickerTrigger{box-sizing:border-box;width:100%;height:36px;padding:0 8px 0 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;text-align:left;cursor:pointer;outline:none;display:flex;align-items:center;gap:6px}
.PF-pickerTrigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.PF-pickerTrigger:focus-visible{border-color:var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary)) 18%,transparent)}
.PF-pickerTrigger:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}
.PF-pickerValue{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.PF-pickerChevron{flex:none;color:var(--dsw-alias-label-caption);transition:transform .12s var(--ds-ease-in-out, ease)}
.PF-pickerChevron[data-open=true]{transform:rotate(180deg)}
.PF-menu{z-index:1200;box-sizing:border-box;position:absolute;top:calc(100% + 4px);left:0;right:0;padding:4px;display:flex;flex-direction:column;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu,var(--dsw-alias-bg-layer-3));backdrop-filter:var(--dsw-menu-backdrop-filter,none);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);box-shadow:var(--dsw-elevation-prominent,var(--dsw-elevation-panel,0 8px 28px rgba(0,0,0,.18)));color:var(--dsw-alias-label-primary);max-height:min(340px,60vh);overflow-y:auto}
.PF-menuSearch{box-sizing:border-box;flex:none;width:100%;height:32px;margin-bottom:4px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;outline:none}
.PF-menuSearch::placeholder{color:var(--dsw-alias-label-tertiary)}
.PF-menuSearch:focus-visible{border-color:var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}
.PF-menuRow{display:flex;flex-direction:column;gap:1px}
.PF-menuEmpty{padding:8px 10px;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}
.PF-option{box-sizing:border-box;display:flex;align-items:center;gap:8px;width:100%;min-height:34px;padding:6px 8px 6px 10px;border:0;border-radius:var(--dsw-radius-md,10px);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;text-align:left;cursor:pointer}
.PF-option:hover:not(:disabled),.PF-option[data-active=true]{background:var(--dsw-alias-interactive-bg-hover)}
.PF-option:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}
.PF-option:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}
.PF-optionCopy{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.PF-optionCheck{flex:none;width:16px;height:16px;display:inline-flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-secondary)}
.PF-menuHint{padding:6px 10px 2px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.PF-toggle{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}
.PF-toggleCopy{display:flex;flex-direction:column;gap:2px;min-width:0}
.PF-toggleLabel{color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}
.PF-switch{display:inline-flex;align-items:center;gap:8px;flex:none;padding:2px 0;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}
.PF-switch:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}
.PF-switch:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px;border-radius:var(--dsw-radius-sm)}
.PF-switchTrack{box-sizing:border-box;display:inline-block;position:relative;width:34px;height:20px;flex:none;border-radius:10px;background:var(--dsw-alias-border-l2);transition:background-color .12s var(--ds-ease-in-out, ease)}
.PF-switch[data-on=true] .PF-switchTrack{background:var(--dsw-alias-state-business-primary)}
.PF-switchThumb{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--dsw-static-neutral-00);transition:transform .12s var(--ds-ease-in-out, ease)}
.PF-switch[data-on=true] .PF-switchThumb{transform:translateX(14px)}
.PF-switchState{min-width:1.5em;text-align:right}
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

let lastReferenceResult = null;
const referenceResultListeners = new Set();
function setLastReferenceResult(result) {
  lastReferenceResult = result;
  for (const listener of [...referenceResultListeners]) listener();
}
function useLastReferenceResult() {
  return ReactRuntime.useSyncExternalStore(
    (listener) => { referenceResultListeners.add(listener); return () => referenceResultListeners.delete(listener); },
    () => lastReferenceResult,
    () => lastReferenceResult,
  );
}
function referenceResultTip(t, result) {
  if (!result) return undefined;
  const known = ['complete', 'none', 'partial', 'preserved', 'disabled'];
  return known.includes(result.status) ? t(`reference.${result.status}`, result) : undefined;
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
function modelName(catalog, selection) {
  const group = findGroup(catalog, selection.provider);
  const model = findModel(group, selection.model);
  return `${group?.name ?? selection.provider} / ${model?.name ?? selection.model}`;
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
  /* What the last successful rewrite appended, or null when there is nothing to
     report. The button shows it briefly instead of changing the draft again. */
  const [appended, setAppended] = ReactRuntime.useState(null);
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

  ReactRuntime.useEffect(() => {
    if (appended === null) return undefined;
    const timer = setTimeout(() => setAppended(null), 4000);
    return () => clearTimeout(timer);
  }, [appended]);

  const run = async () => {
    if (running.current || busy || locked || !hasText) return;
    const text = draft;
    const revision = draftRev;
    running.current = true;
    setBusy(true);
    setFailed(false);
    setAppended(null);
    try {
      const response = await fetch(OPTIMIZE_ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, sessionId }),
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
      /* Report what was appended so an added reference is never a surprise. */
      const referenceResult = {
        status: body.referenceStatus ?? (body.notes?.length > 0 ? 'partial' : undefined),
        files: Array.isArray(body.files) ? body.files.length : 0,
        skills: Array.isArray(body.skills) ? body.skills.length : 0,
      };
      setAppended(referenceResult);
      setLastReferenceResult(referenceResult);
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
    : failed ? t('action.failed', { message: lastFailure ?? '' }) : referenceResultTip(t, appended) ?? appendedTip(t, appended) ?? t('action.title');
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
    'aria-description': referenceResultTip(t, appended),
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

/** The label one reasoning effort shows in the picker. */
function effortName(reasoning, effort, t) {
  if (effort === '') return t('effort.default');
  const level = reasoning?.efforts?.find((candidate) => candidate.id === effort);
  return level?.name ?? effort;
}

/**
 * Render what the last rewrite appended, in the user's own language.
 *
 * @param t - namespace translator.
 * @param appended - `{files, skills}` counts, or null when there is nothing.
 * @returns the tooltip sentence, or undefined when the plain title should stand.
 */
function appendedTip(t, appended) {
  if (appended === null) return undefined;
  const files = appended.files > 0 ? t('action.appendedFiles', { count: appended.files }) : '';
  const skills = appended.skills > 0 ? t('action.appendedSkills', { count: appended.skills }) : '';
  const parts = [files, skills].filter((part) => part !== '');
  if (parts.length === 0) return undefined;
  return t('action.appended', { parts: parts.join(t('action.appendedJoin')) });
}

/* -------------------------------------------------------------- pickers */

/**
 * One dropdown in the shipped menu idiom: a bordered value trigger and an
 * anchored panel of grouped rows.
 *
 * The panel is plain markup rather than the shell's floating `Menu`, because a
 * settings page scrolls and a fixed-position surface would detach from its
 * trigger. Visual language (row rhythm, hover fill, group headings, check mark)
 * follows the composer's model menu so the two read as one design.
 *
 * The panel's query lives here, so `children(choose, query)` re-renders its
 * filtered rows on every keystroke instead of filtering against a stale value.
 */
function Picker(props) {
  const { label, ariaLabel, disabled, menuAriaLabel, searchPlaceholder, onSelect, children } = props;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const root = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event) => {
      if (root.current !== null && !root.current.contains(event.target)) setOpen(false);
    };
    const onKeyDown = (event) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open]);

  const choose = (key) => {
    setOpen(false);
    setQuery('');
    onSelect(key);
  };

  return ReactRuntime.createElement('div', { className: 'PF-picker', ref: root }, [
    ReactRuntime.createElement('button', {
      key: 'trigger',
      type: 'button',
      className: 'PF-pickerTrigger',
      disabled: disabled === true,
      'aria-label': ariaLabel,
      'aria-expanded': open,
      'aria-haspopup': 'listbox',
      onClick: () => setOpen((current) => !current),
    }, [
      ReactRuntime.createElement('span', { key: 'value', className: 'PF-pickerValue' }, label),
      ReactRuntime.createElement(IconChevronDownOutlineRegular, {
        key: 'chevron',
        size: 16,
        className: 'PF-pickerChevron',
        'data-open': open ? 'true' : 'false',
        'aria-hidden': true,
      }),
    ]),
    open ? ReactRuntime.createElement('div', {
      key: 'menu',
      className: 'PF-menu scrollable',
      role: 'listbox',
      'aria-label': menuAriaLabel ?? ariaLabel,
    }, [
      searchPlaceholder === undefined ? null : ReactRuntime.createElement('input', {
        key: 'search',
        type: 'search',
        className: 'PF-menuSearch',
        value: query,
        placeholder: searchPlaceholder,
        spellCheck: false,
        autoFocus: true,
        'aria-label': searchPlaceholder,
        onChange: (event) => setQuery(event.target.value),
      }),
      children(choose, query),
    ]) : null,
  ]);
}

/** One selectable row inside a picker panel. */
function PickerOption(props) {
  const { optionKey, selected, name, onSelect, disabled, hint } = props;
  return ReactRuntime.createElement('button', {
    type: 'button',
    role: 'option',
    className: 'PF-option',
    'data-key': optionKey,
    'aria-selected': selected === true,
    disabled: disabled === true,
    onClick: () => onSelect(),
  }, [
    ReactRuntime.createElement('span', { key: 'copy', className: 'PF-optionCopy' }, [
      ReactRuntime.createElement('span', { key: 'name' }, name),
      hint === undefined ? null : ReactRuntime.createElement('span', { key: 'hint', className: 'PF-menuHint' }, hint),
    ]),
    ReactRuntime.createElement('span', { key: 'check', className: 'PF-optionCheck' }, selected === true
      ? ReactRuntime.createElement(IconCheckOutlineRegular, { 'aria-hidden': true })
      : null),
  ]);
}

/** The composer's model menu, reused for the optimization model. */
function ModelPicker(props) {
  const { catalog, settings, t } = props;
  const groups = catalog.value?.groups ?? [];
  const storedModel = settings !== undefined && settings.provider !== '' && settings.model !== ''
    ? { provider: settings.provider, model: settings.model }
    : null;
  const used = effectiveSelection(catalog.value, settings);
  const currentName = used === null ? t('model.statusEmpty') : modelName(catalog.value, used);
  const defaultName = catalog.value?.default === undefined
    ? '—'
    : modelName(catalog.value, catalog.value.default);
  const showSearch = groups.reduce((total, group) => total + group.models.length, 0) > 8;

  return ReactRuntime.createElement(Picker, {
    label: storedModel === null ? t('model.default', { name: defaultName }) : currentName,
    ariaLabel: t('model.aria', { name: currentName }),
    menuAriaLabel: t('model.listAria'),
    searchPlaceholder: showSearch ? t('model.search') : undefined,
    disabled: groups.length === 0 || settings === undefined,
    onSelect: (key) => {
      if (key === '') {
        settingsStore.patch({ provider: '', model: '', reasoningEffort: '' });
        return;
      }
      const separator = key.indexOf('\u0000');
      settingsStore.patch({
        provider: key.slice(0, separator),
        model: key.slice(separator + 1),
        reasoningEffort: '',
      });
    },
  }, (choose, query) => {
    const needle = query.trim().toLowerCase();
    const matches = (text) => needle === '' || String(text).toLowerCase().includes(needle);
    const visibleGroups = groups
      .map((group) => ({
        group,
        models: group.models.filter((model) => matches(model.name ?? model.id)
          || matches(model.id)
          || matches(group.name ?? group.id)),
      }))
      .filter((entry) => entry.models.length > 0);
    return [
      ReactRuntime.createElement(MenuGroup, { key: 'default-group', label: t('model.followingGroup') }, [
        ReactRuntime.createElement('div', { key: 'rows', className: 'PF-menuRow' }, [
          ReactRuntime.createElement(PickerOption, {
            key: 'default',
            optionKey: '',
            selected: storedModel === null,
            name: t('model.default', { name: defaultName }),
            onSelect: () => choose(''),
          }),
        ]),
      ]),
      ...visibleGroups.map(({ group, models }) => ReactRuntime.createElement(MenuGroup, {
        key: group.id,
        label: group.name ?? group.id,
      }, ReactRuntime.createElement('div', { className: 'PF-menuRow' }, models.map((model) => ReactRuntime.createElement(PickerOption, {
        key: `${group.id}\u0000${model.id}`,
        optionKey: `${group.id}\u0000${model.id}`,
        selected: storedModel !== null && storedModel.provider === group.id && storedModel.model === model.id,
        name: model.name ?? model.id,
        hint: model.description,
        onSelect: () => choose(`${group.id}\u0000${model.id}`),
      }))))),
      needle !== '' && visibleGroups.length === 0
        ? ReactRuntime.createElement('div', { key: 'empty', className: 'PF-menuEmpty' }, t('model.empty'))
        : null,
    ];
  });
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

/**
 * One on/off preference row in the settings page.
 *
 * The control is a real `role="switch"` button with `aria-checked`, so it is
 * reachable and legible to assistive technology without shipping a second
 * checkbox style.
 */
function ReferenceToggle(props) {
  const { label, hint, checked, disabled, onLabel, offLabel, onChange } = props;
  return ReactRuntime.createElement('div', { className: 'PF-toggle' }, [
    ReactRuntime.createElement('div', { key: 'copy', className: 'PF-toggleCopy' }, [
      ReactRuntime.createElement('span', { key: 'label', className: 'PF-toggleLabel' }, label),
      hint === undefined ? null : ReactRuntime.createElement('span', { key: 'hint', className: 'PF-hint' }, hint),
    ]),
    ReactRuntime.createElement('button', {
      key: 'switch',
      type: 'button',
      role: 'switch',
      className: 'PF-switch',
      'aria-checked': checked === true,
      'aria-label': label,
      disabled: disabled === true,
      'data-on': checked === true ? 'true' : 'false',
      onClick: () => onChange(checked !== true),
    }, [
      ReactRuntime.createElement('span', { key: 'track', className: 'PF-switchTrack' }, [
        ReactRuntime.createElement('span', { key: 'thumb', className: 'PF-switchThumb' }),
      ]),
      ReactRuntime.createElement('span', { key: 'state', className: 'PF-switchState' },
        checked === true ? onLabel : offLabel),
    ]),
  ]);
}

/** The PromptForge settings page. */
function PromptForgeSettings(props) {
  const t = props.t;
  const settings = useSettings();
  const catalog = useCatalog();
  const used = effectiveSelection(catalog.value, settings);
  const failure = useLastFailure();
  const referenceResult = useLastReferenceResult();
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
  const prompt = promptDraft ?? settings?.systemPrompt ?? '';
  const error = settingsStore.error();

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
      ReactRuntime.createElement(ModelPicker, {
        key: 'picker',
        catalog,
        settings,
        t,
      }),
    ]),

    ReactRuntime.createElement(Section, {
      key: 'effort',
      title: t('effort.heading'),
      hint: reasoning === undefined ? t('effort.unsupported') : t('effort.hint'),
    }, [
      ReactRuntime.createElement(Picker, {
        key: 'picker',
        label: effortName(reasoning, settings?.reasoningEffort ?? '', t),
        ariaLabel: t('effort.heading'),
        menuAriaLabel: t('effort.heading'),
        disabled: reasoning === undefined || settings === undefined,
        onSelect: (key) => settingsStore.patch({ reasoningEffort: key }),
      }, (choose) => ReactRuntime.createElement('div', { className: 'PF-menuRow' }, [
        ReactRuntime.createElement(PickerOption, {
          key: 'default',
          optionKey: '',
          selected: (settings?.reasoningEffort ?? '') === '',
          name: t('effort.default'),
          onSelect: () => choose(''),
        }),
        ...(reasoning?.efforts ?? []).map((level) => ReactRuntime.createElement(PickerOption, {
          key: level.id,
          optionKey: level.id,
          selected: settings?.reasoningEffort === level.id,
          name: level.name,
          hint: level.description,
          onSelect: () => choose(level.id),
        })),
      ])),
      ReactRuntime.createElement('p', { key: 'note', className: 'PF-hint' }, t('effort.followUp')),
    ]),

    ReactRuntime.createElement(Section, {
      key: 'reference',
      title: t('reference.heading'),
      hint: t('reference.hint'),
    }, [
      ReactRuntime.createElement(ReferenceToggle, {
        key: 'files',
        label: t('reference.files'),
        hint: t('reference.filesHint'),
        checked: settings?.referenceFiles !== false,
        disabled: settings === undefined,
        onLabel: t('toggle.on'),
        offLabel: t('toggle.off'),
        onChange: (next) => settingsStore.patch({ referenceFiles: next }),
      }),
      ReactRuntime.createElement(ReferenceToggle, {
        key: 'skills',
        label: t('reference.skills'),
        hint: t('reference.skillsHint'),
        checked: settings?.referenceSkills !== false,
        disabled: settings === undefined,
        onLabel: t('toggle.on'),
        offLabel: t('toggle.off'),
        onChange: (next) => settingsStore.patch({ referenceSkills: next }),
      }),
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

    referenceResultTip(t, referenceResult) === undefined ? null : ReactRuntime.createElement(Section, {
      key: 'last-reference-result',
      title: t('reference.statusHeading'),
    }, ReactRuntime.createElement('p', { className: 'PF-hint', role: 'status' }, referenceResultTip(t, referenceResult))),

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

export { apply, inject };
