/* dsh-prompt-forge v1.0.0 — generated Host half. Edit src/ and run "node build.mjs". */
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

/**
 * dsh-prompt-forge — Host half.
 *
 * Owns three things and nothing else:
 *
 *   1. the durable settings document (which model, which reasoning effort, and
 *      the rewrite instruction) beside the other DSH user-level state;
 *   2. the browser routes the client half talks to (read/patch settings, run one
 *      optimization, report a client-side failure);
 *   3. the model call itself, through the live `llm` service, so the plugin uses
 *      exactly the providers, credentials, and adapters the rest of DSH uses.
 *
 * `llm` and `webServer` are resolved lazily: a composition without either
 * still loads, and the routes simply report "unavailable" instead of failing
 * the whole row. No shipped behavior is patched.
 *
 * @module dsh-prompt-forge
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/* Plugin identity; also the Loader row id in cordis.patch.yml. */
const name = PACKAGE_NAME;

/* DSH Cordis treats every inject key as a required service. Register web routes
   through ctx.inject below and read llm at call time, without blocking this row. */
const inject = [];

/** Upper bound for one request body, so a broken client cannot buffer forever. */
const MAX_BODY_BYTES = 512 * 1024;

/** One JSON document per DSH home, beside the other user-level state. */
function statePath() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  return join(home, 'prompt-forge.json');
}

/* ------------------------------------------------------------------- storage */

/** Read the durable settings, falling back to defaults for a missing/broken file. */
async function readState() {
  try {
    const raw = await readFile(statePath(), 'utf8');
    return normalizeState(JSON.parse(raw));
  } catch {
    /* A missing, empty, or corrupt document simply means "still at defaults". */
    return normalizeState({});
  }
}

/** Persist the settings atomically; a failure is reported, never swallowed. */
async function saveState(state) {
  const target = statePath();
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await rename(temporary, target);
  return state;
}

/* -------------------------------------------------------------- HTTP helpers */

/** Write one JSON response. */
function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

/** Read a raw request body with a hard size cap. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Read and parse a JSON request body. */
async function readJsonBody(req) {
  const raw = await readBody(req);
  if (raw.trim() === '') return {};
  const parsed = JSON.parse(raw);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('request body must be a JSON object');
  }
  return parsed;
}

/* ---------------------------------------------------------------- model call */

/**
 * Resolve the model route for one optimization.
 *
 * A configured provider/model pair wins, but only while both still exist in the
 * live adapter registry — a model removed from the deployment must not strand
 * the feature. Otherwise the deployment default selection applies, and its
 * reasoning effort is deliberately left unset so the adapter's own default is
 * materialized by the LLM runtime.
 *
 * @param llm - the live LLM service.
 * @param defaults - the `agentDefaultModel` service, when this composition has one.
 * @param state - current settings document.
 * @returns the provider, model, and optional reasoning effort to request.
 * @throws when no routable model can be determined.
 */
function resolveRoute(llm, defaults, state) {
  const providers = llm.listProviders().map((provider) => provider.id);
  if (state.provider !== '' && state.model !== '' && providers.includes(state.provider)) {
    return {
      provider: state.provider,
      model: state.model,
      ...(state.reasoningEffort === '' ? {} : { reasoningEffort: state.reasoningEffort }),
    };
  }
  const fallback = defaults?.currentSelection();
  if (fallback === undefined || fallback === null) {
    throw new Error('no model is configured: set the deployment default model, or pick a model in PromptForge settings');
  }
  const effort = state.reasoningEffort;
  return {
    provider: fallback.provider,
    model: fallback.model,
    ...(effort === undefined || effort === '' ? {} : { reasoningEffort: effort }),
  };
}

/** Map one stream finish outcome onto a human-readable failure, if any. */
function finishFailure(finish) {
  if (finish === undefined || finish === null) return 'the model stream ended without a finish event';
  switch (finish.kind) {
    case 'stop':
      return null;
    case 'length':
    case 'max-tokens':
      return 'the model hit the output token limit before finishing the prompt';
    case 'tool-calls':
      return 'the model attempted a tool call instead of returning prompt text';
    case 'content-filter':
      return 'the provider refused the request';
    case 'aborted':
      return 'the optimization was aborted';
    case 'error':
      return finish.failure?.message ?? 'the provider call failed';
    default:
      return `unsupported finish reason "${String(finish.kind)}"`;
  }
}

/**
 * Accumulate the visible text of one chunk stream.
 *
 * The plugin owns this instead of importing the LLM package's assembler: an
 * out-of-tree bundle may only talk to the `llm` *service*, never to the
 * package's module graph. Reasoning blocks are deliberately excluded — only
 * the answer text ends up in the composer.
 */
function accumulateText() {
  const fragments = new Map();
  let finish;
  let toolCall = false;
  return {
    push(chunk) {
      if (chunk.type === 'text-delta') {
        fragments.set(chunk.index, (fragments.get(chunk.index) ?? '') + chunk.text);
        return;
      }
      if (chunk.type === 'block-start' && chunk.blockType === 'tool-call') {
        toolCall = true;
        return;
      }
      if (chunk.type === 'finish') finish = chunk.reason;
    },
    /** Joined text of every text block, in stream order. */
    text() {
      return [...fragments.entries()]
        .sort((left, right) => left[0] - right[0])
        .map(([, text]) => text)
        .join('\n')
        .trim();
    },
    /** The terminal reason, once the stream has ended. */
    reason() {
      return finish;
    },
    /** Whether the model opened a tool-call block, which is never a valid answer. */
    openedToolCall() {
      return toolCall;
    },
  };
}

/**
 * Rewrite one draft into an optimized prompt with an existing DSH model.
 *
 * @param ctx - host context, read for the deployment default model.
 * @param state - current settings document.
 * @param text - exact composer draft to rewrite.
 * @param llm - the live LLM service to call.
 * @returns the rewritten prompt plus the route that produced it.
 * @throws when the model is unroutable, the call fails, or the output is unusable.
 */
async function forgePrompt(ctx, state, text, llm) {
  const trimmed = text.trim();
  if (trimmed === '') throw new Error('there is nothing to optimize');
  if (text.length > MAX_INPUT_CHARS) {
    throw new Error(`the draft is ${text.length} characters; the limit is ${MAX_INPUT_CHARS}`);
  }
  const route = resolveRoute(llm, ctx.get('agentDefaultModel'), state);
  /* A request-only user input: no id/source is needed because this call never
     enters a Session log. */
  const messages = [{
    role: 'user',
    content: [{
      type: 'text',
      text: `Rewrite the following composer text.\n\n<composer_text>\n${text}\n</composer_text>`,
    }],
  }];
  const options = {
    provider: route.provider,
    model: route.model,
    messages,
    system: state.systemPrompt,
    maxTokens: MAX_OUTPUT_TOKENS,
    purpose: 'prompt-forge',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
  };

  const assembler = accumulateText();
  for await (const chunk of llm.stream(options)) assembler.push(chunk);

  const failure = finishFailure(assembler.reason());
  if (failure !== null) throw new Error(failure);
  if (assembler.openedToolCall()) {
    throw new Error('the model returned a tool call instead of prompt text');
  }
  const prompt = assembler.text();
  if (prompt === '') throw new Error(EMPTY_OUTPUT_MESSAGE);
  if (prompt.length > MAX_INPUT_CHARS) {
    throw new Error('the optimized prompt came back longer than the composer limit');
  }
  return { prompt, route };
}

/* -------------------------------------------------------------- plugin body */

/**
 * Host plugin body.
 *
 * @param ctx - the plugin context.
 */
function apply(ctx) {
  /** The in-memory copy every reader shares; the file is the durable copy. */
  const live = { state: normalizeState({}) };
  const ready = readState().then((state) => {
    live.state = state;
    return state;
  });

  ctx.inject(['webServer'], (webCtx) => {
    /** Read the LLM service at call time: the carrier may arrive after this row. */
    const llmCtx = () => {
      const service = ctx.get('llm');
      if (service === undefined) throw new Error('the LLM service is not available in this composition');
      return service;
    };

    webCtx.effect(
      () => webCtx.webServer.register({
        kind: 'exact',
        path: STATE_ROUTE,
        handler: (req, res) => {
          const method = req.method || 'GET';
          if (method === 'GET' || method === 'HEAD') {
            ready.then(
              () => {
                if (method === 'HEAD') {
                  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
                  res.end();
                  return;
                }
                sendJson(res, 200, live.state);
              },
              (error) => sendJson(res, 500, { error: String(error?.message ?? error) }),
            );
            return;
          }
          if (method !== 'POST') {
            res.writeHead(405, { allow: 'GET, HEAD, POST' });
            res.end();
            return;
          }
          readJsonBody(req).then(
            async (patch) => {
              await ready;
              const next = normalizeState({ ...live.state, ...patch });
              try {
                await saveState(next);
              } catch (error) {
                sendJson(res, 500, { error: `could not write ${statePath()}: ${error?.message ?? error}` });
                return;
              }
              live.state = next;
              sendJson(res, 200, next);
            },
            (error) => sendJson(res, 400, { error: String(error?.message ?? error) }),
          );
        },
      }),
      'prompt-forge: settings route',
    );

    webCtx.effect(
      () => webCtx.webServer.register({
        kind: 'exact',
        path: OPTIMIZE_ROUTE,
        handler: (req, res) => {
          if ((req.method || 'GET') !== 'POST') {
            res.writeHead(405, { allow: 'POST' });
            res.end();
            return;
          }
          readJsonBody(req).then(
            async (body) => {
              const text = typeof body.text === 'string' ? body.text : '';
              try {
                const llm = llmCtx();
                const result = await forgePrompt(ctx, live.state, text, llm);
                sendJson(res, 200, result);
              } catch (error) {
                sendJson(res, 400, { error: String(error?.message ?? error) });
              }
            },
            (error) => sendJson(res, 400, { error: String(error?.message ?? error) }),
          );
        },
      }),
      'prompt-forge: optimize route',
    );

    webCtx.effect(
      () => webCtx.webServer.register({
        kind: 'exact',
        path: REPORT_ROUTE,
        handler: (req, res) => {
          if ((req.method || 'GET') !== 'POST') {
            res.writeHead(405, { allow: 'POST' });
            res.end();
            return;
          }
          readJsonBody(req).then(
            (body) => {
              /* Client-side failures have no other sink on the Host side. */
              process.stderr.write(`[prompt-forge] client report: ${String(body.message ?? body)}\n`);
              sendJson(res, 200, { ok: true });
            },
            () => {
              res.writeHead(204);
              res.end();
            },
          );
        },
      }),
      'prompt-forge: client report route',
    );
  });
}

export { apply, inject, name };
