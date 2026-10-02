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
 * Read the model's rewrite answer, tolerating both envelope shapes.
 *
 * A model that was asked for the JSON envelope usually returns it, but a
 * provider may wrap it in a code fence or ignore the instruction entirely. A
 * plain-text answer is still a usable rewrite, so it degrades to one instead of
 * failing the request.
 *
 * @param text - the assistant text exactly as streamed.
 * @returns the rewrite plus any nominated paths and skill names.
 */
function readRewriteAnswer(text) {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/u.exec(trimmed);
  const body = fenced === null ? trimmed : fenced[1];
  const start = body.indexOf('{');
  if (start !== -1) {
    const end = body.lastIndexOf('}');
    if (end > start) {
      try {
        const parsed = JSON.parse(body.slice(start, end + 1));
        if (parsed !== null && typeof parsed === 'object' && typeof parsed.prompt === 'string') {
          return {
            prompt: parsed.prompt,
            files: Array.isArray(parsed.files) ? parsed.files.filter((item) => typeof item === 'string') : [],
            skills: Array.isArray(parsed.skills) ? parsed.skills.filter((item) => typeof item === 'string') : [],
          };
        }
      } catch {
        /* Not JSON after all: the whole answer is the rewrite. */
      }
    }
  }
  return { prompt: trimmed, files: [], skills: [] };
}

/** Normalize one model-nominated path into the shape the file index speaks. */
function normalizeQuery(value) {
  return value
    .trim()
    .replaceAll('\\', '/')
    .replace(/^\.\/+/u, '')
    .replace(/^@/u, '')
    .replace(/^"+|"+$/gu, '');
}

/**
 * Decide whether one index candidate answers a nomination.
 *
 * The model names a fragment, not a resolved path, so equality cannot be the
 * test. A fragment must still land on a segment boundary: `host` matches
 * `src/host.js`, while `ost` matches nothing. Mid-segment matches are refused on
 * purpose, because they are how one nomination would silently resolve to an
 * unrelated file in a deep tree.
 *
 * @param path - candidate path from the index.
 * @param query - normalized nomination.
 * @returns whether the candidate answers it.
 */
function nominationMatches(path, query) {
  if (query === '') return false;
  return path.startsWith(query)
    || path.includes(`/${query}`)
    || path.includes(`${query}/`);
}

/**
 * Resolve model-nominated paths against the live file index.
 *
 * The model's own token never reaches the composer: a nomination survives only
 * when the index answers it, and an exact path beats a partial one. That check
 * is what makes a hallucinated path impossible, and it also produces the
 * canonical path the reference token must use.
 *
 * @param hostCtx - host context carrying the optional file-reference service.
 * @param agent - live agent whose working directory bounds discovery.
 * @param nominations - model-proposed paths or path fragments.
 * @param signal - cancellation for the lookups.
 * @returns validated `{ path, kind, token }` entries, most relevant first.
 */
async function resolveFileReferences(hostCtx, agent, nominations, signal) {
  const service = hostCtx.get('fileReferences');
  if (service === undefined || agent === undefined) {
    throw new Error('file references are unavailable: this composition has no file-reference index for the session');
  }
  const resolved = [];
  const seen = new Set();
  for (const nomination of nominations.slice(0, MAX_FILE_NOMINATIONS)) {
    const query = normalizeQuery(nomination);
    if (query === '') continue;
    let candidates;
    try {
      candidates = await service.list(agent, query, signal);
    } catch {
      /* One failed lookup drops its own nomination only. */
      continue;
    }
    const stem = query.replace(/\/+$/u, '');
    const matches = candidates.filter((candidate) => nominationMatches(candidate.path, stem));
    /* An exact hit is canonical; otherwise the index's own ranking decides, so
       the first match wins rather than a guess across the whole answer. */
    const chosen = matches.find((candidate) => candidate.path === stem) ?? matches[0];
    if (chosen === undefined) continue;
    const token = formatFileMention(chosen.path, chosen.kind);
    if (token === undefined || seen.has(token)) continue;
    seen.add(token);
    resolved.push({ path: chosen.path, kind: chosen.kind, token });
  }
  return resolved;
}

/**
 * Resolve model-nominated skill names against the live skill catalog.
 *
 * Names are matched exactly against the layers this exact agent sees, and only
 * model-invocable skills survive: the block tells the agent to load the skill
 * through its `skill` tool, so advertising a human-only skill would be a dead
 * end. This mirrors how the shipped Session skill catalog builds its own view.
 *
 * @param hostCtx - host context carrying the optional skills service.
 * @param agent - live agent whose scope and working directory select the layers.
 * @param cwd - the Session's working directory, when known.
 * @param nominations - model-proposed skill names.
 * @param signal - cancellation for discovery.
 * @returns validated `{ name, description }` entries, catalog order.
 */
async function resolveSkillReferences(hostCtx, agent, cwd, nominations, signal) {
  if (agent === undefined) {
    throw new Error('skill references are unavailable: this composition has no live agent for the session');
  }
  const service = hostCtx.get('skills');
  if (service === undefined) {
    throw new Error('skill references are unavailable: this composition has no skill catalog');
  }
  const catalog = await service.list({ scope: agent, ...(cwd === undefined ? {} : { cwd }), signal });
  const wanted = new Set(nominations.slice(0, MAX_SKILL_NOMINATIONS).map((name) => name.trim()));
  return catalog
    .filter((skill) => wanted.has(skill.name) && skill.invocation?.modelInvocable === true)
    .map((skill) => ({ name: skill.name, description: skill.description }));
}

/**
 * Append the validated references to a rewrite.
 *
 * References land on their own lines at the very end. The composer's mention
 * grammar needs `@` at a line start or after whitespace, and appending keeps a
 * leading slash command or mention exactly where the author had it — the rewrite
 * contract already forbids moving it.
 *
 * @param prompt - the rewritten prompt.
 * @param files - validated file references.
 * @param skills - validated skill references.
 * @returns the prompt with its reference block, or unchanged when there is none.
 */
function appendReferences(prompt, files, skills) {
  const blocks = [prompt];
  if (files.length > 0) {
    blocks.push(files.map((file) => file.token).join('\n'));
  }
  if (skills.length > 0) {
    blocks.push(`${SKILL_REFERENCE_MARKER}\n${skills.map((skill) => skill.name).join('\n')}`);
  }
  return blocks.join('\n\n');
}

/**
 * Rewrite one draft into an optimized prompt with an existing DSH model.
 *
 * @param ctx - host context, read for the deployment default model.
 * @param state - current settings document.
 * @param text - exact composer draft to rewrite.
 * @param llm - the live LLM service to call.
 * @param sessionId - Session whose working directory bounds reference discovery.
 * @returns the rewritten prompt, the route, and the appended reference counts.
 * @throws when the model is unroutable, the call fails, or the output is unusable.
 */
async function forgePrompt(ctx, state, text, llm, sessionId) {
  const trimmed = text.trim();
  if (trimmed === '') throw new Error('there is nothing to optimize');
  if (text.length > MAX_INPUT_CHARS) {
    throw new Error(`the draft is ${text.length} characters; the limit is ${MAX_INPUT_CHARS}`);
  }
  const route = resolveRoute(llm, ctx.get('agentDefaultModel'), state);
  const wantFiles = state.referenceFiles;
  const wantSkills = state.referenceSkills;
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
    system: `${state.systemPrompt}${buildEnvelopeInstruction(wantFiles, wantSkills)}`,
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
  const answer = readRewriteAnswer(assembler.text());
  if (answer.prompt === '') throw new Error(EMPTY_OUTPUT_MESSAGE);
  if (answer.prompt.length > MAX_INPUT_CHARS) {
    throw new Error('the optimized prompt came back longer than the composer limit');
  }

  /* Reference resolution is best-effort: a composition without the index, a
     session with no live agent, or a failing lookup must never cost the user the
     rewrite they asked for.
     It gets its own deadline rather than the model call's signal: that one is
     already consumed by the finished stream, and a post-request lookup must not
     inherit the model's remaining budget. */
  const agent = ctx.get('agents')?.get(sessionId);
  const cwd = agent?.ctx?.get('session')?.cwd;
  const referenceSignal = AbortSignal.timeout(REFERENCE_TIMEOUT_MS);
  const notes = [];
  let files = [];
  let skills = [];
  if (wantFiles && answer.files.length > 0) {
    try {
      files = await resolveFileReferences(ctx, agent, answer.files, referenceSignal);
    } catch (error) {
      notes.push(String(error?.message ?? error));
    }
  }
  if (wantSkills && answer.skills.length > 0) {
    try {
      skills = await resolveSkillReferences(ctx, agent, cwd, answer.skills, referenceSignal);
    } catch (error) {
      notes.push(String(error?.message ?? error));
    }
  }
  return {
    prompt: appendReferences(answer.prompt, files, skills),
    route,
    files: files.map((file) => file.path),
    skills: skills.map((skill) => skill.name),
    ...(notes.length === 0 ? {} : { notes }),
  };
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
              const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
              try {
                const llm = llmCtx();
                const result = await forgePrompt(ctx, live.state, text, llm, sessionId);
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
