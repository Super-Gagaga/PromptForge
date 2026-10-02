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

/** The post-request reference lookups get their own, much shorter deadline. */
const REFERENCE_TIMEOUT_MS = 15000;

/** Most workspace paths shown to the candidate question. */
const CANDIDATE_PATH_BUDGET = 160;

/** Most skills listed for the candidate question. */
const CANDIDATE_SKILL_BUDGET = 40;

/**
 * Directory names the candidate listing probes.
 *
 * Fallback names for providers that do not expose root directory entries.
 * Task paths and root discovery take precedence when available.
 */
const CANDIDATE_DIRECTORY_HINTS = [
  'web', 'src', 'app', 'apps', 'internal', 'pkg', 'cmd', 'lib', 'server', 'client',
  'api', 'packages', 'public', 'static', 'assets', 'components', 'pages', 'routes',
  'handlers', 'handler', 'controllers', 'models', 'services', 'views', 'templates',
  'docs', 'test', 'tests', 'scripts', 'config', 'configs', 'migrations', 'sql',
  'deploy', 'ui', 'dashboard', 'frontend', 'backend',
];

/** Upper bound on file paths the model may nominate for one rewrite. */
const MAX_FILE_NOMINATIONS = 5;

/** Upper bound on skill names the model may nominate for one rewrite. */
const MAX_SKILL_NOMINATIONS = 3;

/** Appended to the composer output when the model produced nothing usable. */
const EMPTY_OUTPUT_MESSAGE = 'prompt-forge: the model returned no usable prompt text';

/**
 * Marker opening the appended file-reference group.
 *
 * Kept to the heading alone: DSH already teaches the agent what an `@` token
 * means, and the agent reads a file before using it on its own. The longer
 * wording that spelled both out was removed to keep the appended block short.
 *
 * The line is recognized again on the next run, so repeated optimizations
 * rebuild this group instead of stacking a second heading.
 */
const FILE_REFERENCE_MARKER = 'Files this task needs:';

/**
 * Marker opening the appended skill-reference block.
 *
 * Each entry is written as the `/name` gesture, which is not decoration: DSH
 * scans the claimed user message for `/([a-z0-9]+(?:-[a-z0-9]+)*)` and injects
 * that skill's body before the step runs. A bare name would only work if the
 * agent chose to call the `skill` tool, so the gesture is what makes the
 * reference actionable the moment the user sends the prompt.
 */
const SKILL_REFERENCE_MARKER = 'Skills this task may need:';

/**
 * Render one skill name as the gesture DSH recognizes in a user message.
 *
 * The scanner's pattern is `/(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)`, so a
 * name that is not kebab-case could never be invoked and is refused here rather
 * than appended as a token that silently does nothing.
 *
 * @param name - catalog skill name.
 * @returns `/name`, or `undefined` when the gesture grammar cannot carry it.
 */
function formatSkillGesture(name) {
  if (typeof name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name)) return undefined;
  return `/${name}`;
}

/* ---------------------------------------------------------- reference syntax */

/**
 * Render one workspace path as the reference token DSH's composer grammar
 * recognizes, or `undefined` for a path that grammar cannot represent safely.
 *
 * This mirrors `formatFileMention` in `@deepseek-ai/dsh-file-reference/grammar`:
 * `@path` normally, `@"path"` when the path contains whitespace, `@"dir` for a
 * directory the user is meant to list, and no token at all when the path carries
 * a character the editor cannot quote.
 *
 * @param path - workspace-relative path, already normalized to `/`.
 * @param kind - file or directory, as the file-reference index reported it.
 * @returns the reference token, or `undefined` when it cannot be rendered.
 */
function formatFileMention(path, kind) {
  if (typeof path !== 'string' || path === '') return undefined;
  if (/[\u0000-\u001f\u007f-\u009f"]/u.test(path)) return undefined;
  const suffix = kind === 'directory' ? '/' : '';
  const target = `${path}${suffix}`;
  if (!/\s/u.test(target)) return `@${target}`;
  return kind === 'directory' ? `@"${target}` : `@"${target}"`;
}

/**
 * How eagerly the rewrite nominates skills.
 *
 * The catalog a workspace exposes is not always relevant to the request, and the
 * model's willingness to name an entry swings widely between "only if certain"
 * and "anything plausibly useful". One fixed wording cannot serve both, so the
 * tier the user picks is the wording the model receives.
 *
 * The values are the stored strings, so a hand-edited settings file stays
 * readable and an older boolean is migrated by `normalizeState`.
 */
const SKILL_MODES = ['off', 'strict', 'balanced', 'eager'];

/** The tier a workspace with no stored preference gets. */
const DEFAULT_SKILL_MODE = 'balanced';

/**
 * The skill half of the envelope request, worded for one tier.
 *
 * @param mode - one of `SKILL_MODES`.
 * @returns the instruction line.
 */
function skillNominationRule(mode) {
  switch (mode) {
    case 'strict':
      return 'For "skills": list a skill only when the request names the capability it provides or the task cannot be done without it; at most 2, empty otherwise.';
    case 'eager':
      return 'For "skills": list every skill that could plausibly improve this task, most useful first, up to 3. Include a skill when a reasonable colleague would consider using it, even if the request does not name it.';
    default:
      return 'For "skills": list only skills you are confident exist and that this task needs, at most 3. Use an empty array when none apply.';
  }
}

/**
 * The skill half of the candidate question, worded for one tier.
 *
 * The listing is the same either way; only the bar for choosing from it moves,
 * so the tier never widens what can be referenced — the catalog still has the
 * final say on whether the name exists.
 *
 * @param mode - one of `SKILL_MODES`.
 * @param hasCandidates - whether the real catalog was handed over.
 * @returns the instruction line.
 */
function skillCandidateRule(mode, hasCandidates) {
  if (!hasCandidates) {
    switch (mode) {
      case 'strict':
        return 'Do not nominate skills unless the request explicitly needs one; an empty array is the normal answer.';
      case 'eager':
        return 'Name any skill that would plausibly help, up to 3, even when the request does not name the capability.';
      default:
        return 'Nominate at most 3 skill names you are confident exist and this task needs.';
    }
  }
  switch (mode) {
    case 'strict':
      return 'For "skills": choose a name from <available_skills> only when the request names that capability or the task cannot be done without it, at most 2. An empty array is the normal answer.';
    case 'eager':
      return 'For "skills": choose up to 3 names from <available_skills> that would plausibly improve this task, most useful first — include one when a reasonable colleague would consider using it, even if the request does not name it.';
    default:
      return 'For "skills": choose at most 3 names from <available_skills> that this task would genuinely benefit from, exactly as listed. An empty array is correct only when none of them help.';
  }
}

/**
 * The output contract the default instruction states, and the marker that lets
 * the envelope request replace it.
 *
 * Appending a JSON request after a contract that says "reply with the rewritten
 * prompt only" loses: the model follows the instruction it read first. The
 * envelope therefore substitutes this exact paragraph instead of competing with
 * it, so one contract is in force at a time.
 */
const PLAIN_OUTPUT_CONTRACT = `Output contract:
- Reply with the rewritten prompt only.
- No preamble, no explanation, no commentary, no surrounding quotes or code fences, and no trailing notes about what you changed.
- If the input is already an excellent prompt, reply with it unchanged rather than describing it.`;

/**
 * The JSON envelope instruction appended when the rewrite must also nominate the
 * files and skills it depends on.
 *
 * The model never writes a reference token itself: it names paths and skill
 * names, and the Host validates every nomination against the live file index and
 * skill catalog before anything reaches the composer. That split is what keeps a
 * hallucinated path out of the prompt.
 *
 * @param files - whether file nominations are collected.
 * @param skillMode - the skill tier, or `'off'` to collect none.
 * @returns the instruction, or an empty string when neither is enabled.
 */
function buildEnvelopeInstruction(files, skillMode) {
  const skills = skillMode !== 'off';
  if (!files && !skills) return '';
  const fields = ['"prompt": string — the rewritten prompt'];
  if (files) fields.push('"files": string[] — workspace-relative paths, or distinctive path fragments');
  if (skills) fields.push('"skills": string[] — kebab-case names of skills this task needs');
  const rules = [
    'Output contract (overrides any other output instruction):',
    `- Reply with ONE JSON object and nothing else: { ${fields.join(', ')} }.`,
    '- No prose around it, no code fence, no trailing text.',
  ];
  if (files) {
    rules.push('- For "files": list only files this task genuinely depends on, most relevant first, at most 5. Give the most specific path you can justify from the request; when you cannot name a real path, use a distinctive fragment of one. Never invent a file you have no reason to believe exists, and never list a file the request does not need.');
    rules.push('- "files" is a separate index of what the agent should open. It is NEVER a substitute for the prompt text: keep every subject, noun, and path the author wrote exactly where it belongs in "prompt". Deleting a phrase from "prompt" because it also appears in "files" produces a broken sentence and is not allowed.');
  }
  if (skills) rules.push(`- ${skillNominationRule(skillMode)}`);
  rules.push('- Include every field even when it is empty, and prefer an empty list over a guess.');
  return `\n\n${rules.join('\n')}`;
}

/**
 * Compose the system instruction for one rewrite.
 *
 * @param systemPrompt - the user's configured instruction.
 * @param files - whether file nominations are collected.
 * @param skillMode - the skill tier, or `'off'` to collect none.
 * @returns the instruction the model receives.
 */
function composeSystemPrompt(systemPrompt, files, skillMode) {
  const envelope = buildEnvelopeInstruction(files, skillMode);
  if (envelope === '') return systemPrompt;
  return `${systemPrompt.replace(PLAIN_OUTPUT_CONTRACT, '').trimEnd()}${envelope}`;
}

/**
 * The follow-up instruction used when the rewrite came back without an envelope.
 *
 * A small model reliably answers a JSON question about one file list, and even
 * more reliably when the question is the only thing asked. This is the second
 * chance for a rewrite that ignored the envelope: the prompt text is already
 * final, and only the nominations are missing.
 */
const NOMINATION_SYSTEM_PROMPT = `You extract file and skill references for a coding agent.

You receive a task prompt. Name the files that prompt makes the agent read or change, and the skills it needs. You may name a path or a distinctive fragment of one; an index will confirm it, so a fragment is safer than a guess.

Reply with ONE JSON object and nothing else:
{ "files": string[], "skills": string[] }

Use empty arrays when nothing applies. At most 5 files and 3 skills.`;

/**
 * The rewrite instruction. Placeholders keep the two variable parts (the text
 * and the plugin's standing rules) visible to anyone reading this constant.
 */
const DEFAULT_SYSTEM_PROMPT = `You are PromptForge, a prompt-engineering assistant embedded in a coding agent's composer.

The user hands you the text currently sitting in their message box. Rewrite it into a clear, high-signal prompt that the agent can act on immediately.

Rules:
- Preserve the author's intent, language, and every concrete detail, constraint, path, command, identifier, and code block. Never invent requirements, and never answer the request yourself.
- Keep the text in the same natural language the user wrote in (Chinese stays Chinese, English stays English).
- For an explicit task, make vague actions concrete and expand relevant details that naturally belong to it. For analysis or design, identify useful dimensions and the expected result; do not turn optional ideas into mandatory requirements or choose an unspecified technical stack.
- For a scene, theme, or other content description, refine its wording and relevant descriptive focus while preserving the original subject and setting. Do not assume a writing, image, or video task, prescribe an output format, or invent a specific time, weather, or new event.
- When the text already reads well, make only light corrections instead of padding it.
- Structure only as much as the content earns: plain prose for short asks, a short labelled list when there are several distinct requirements. Do not force a template onto a simple request.
- Keep any leading slash command, file reference, or mention marker exactly where the author put it, and keep it on the first line.

${PLAIN_OUTPUT_CONTRACT}`;

/* ------------------------------------------------------------------ settings */

/**
 * Coerce one stored skill tier, including the boolean this setting replaced.
 *
 * @param value - stored `skillMode`, or the older `referenceSkills` boolean.
 * @returns one of `SKILL_MODES`.
 */
function normalizeSkillMode(value) {
  if (typeof value === 'string' && SKILL_MODES.includes(value)) return value;
  if (typeof value === 'boolean') return value ? 'balanced' : 'off';
  return DEFAULT_SKILL_MODE;
}

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
  const flag = (value, fallback) => (typeof value === 'boolean' ? value : fallback);
  const systemPrompt = text(source.systemPrompt).trim();
  return {
    provider: text(source.provider).trim(),
    model: text(source.model).trim(),
    reasoningEffort: text(source.reasoningEffort).trim(),
    systemPrompt: systemPrompt === '' ? DEFAULT_SYSTEM_PROMPT : systemPrompt,
    /* Both reference features are opt-out: an older document without the fields
       keeps them enabled, which is what a fresh install gets too. */
    referenceFiles: flag(source.referenceFiles, true),
    /* The skill tier replaces an earlier on/off boolean: `true` was the tier this
       build calls `balanced`, and `false` was no nominations at all. */
    skillMode: normalizeSkillMode(source.skillMode ?? source.referenceSkills),
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
 * Run one model call and return its assistant text.
 *
 * @param llm - the live LLM service.
 * @param route - provider, model, and optional reasoning effort.
 * @param system - the system instruction for this call.
 * @param userText - the user-role text for this call.
 * @param signal - cancellation deadline, shared with reference work for a follow-up.
 * @returns the streamed assistant text.
 * @throws when the call fails, is aborted, or ends without a usable finish.
 */
async function callModel(llm, route, system, userText, signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS)) {
  const messages = [{
    role: 'user',
    content: [{ type: 'text', text: userText }],
  }];
  const options = {
    provider: route.provider,
    model: route.model,
    messages,
    system,
    maxTokens: MAX_OUTPUT_TOKENS,
    purpose: 'prompt-forge',
    signal,
    ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
  };
  const assembler = accumulateText();
  for await (const chunk of llm.stream(options)) assembler.push(chunk);
  const failure = finishFailure(assembler.reason());
  if (failure !== null) throw new Error(failure);
  if (assembler.openedToolCall()) {
    throw new Error('the model returned a tool call instead of prompt text');
  }
  return assembler.text();
}

/** Parse a complete JSON object, optionally enclosed by a single JSON fence. */
function parseWholeObject(text) {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/u.exec(trimmed);
  try {
    const value = JSON.parse(fenced === null ? trimmed : fenced[1]);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

/**
 * Read the model's rewrite answer, tolerating both envelope shapes.
 *
 * A model that was asked for the JSON envelope usually returns it, but a
 * provider may wrap it in a code fence or ignore the instruction entirely. A
 * plain-text answer is still a usable rewrite, so it degrades to one instead of
 * failing the request — `enveloped` tells the caller that the nominations are
 * still missing and worth a follow-up question.
 *
 * @param text - the assistant text exactly as streamed.
 * @returns the rewrite, any nominations, and whether an envelope arrived.
 */
function readRewriteAnswer(text, files = true, skillMode = DEFAULT_SKILL_MODE) {
  const skills = skillMode !== 'off';
  const parsed = files || skills ? parseWholeObject(text) : null;
  const validList = (value) => Array.isArray(value) && value.every((item) => typeof item === 'string');
  if (parsed !== null && typeof parsed.prompt === 'string'
    && (!files || validList(parsed.files)) && (!skills || validList(parsed.skills))) {
    return { prompt: parsed.prompt, files: files ? parsed.files : [],
      skills: skills ? parsed.skills : [], enveloped: true };
  }
  // Preserve arbitrary prose and JSON examples; never extract an embedded object.
  return { prompt: text.trim(), files: [], skills: [], enveloped: false };
}

/**
 * Ask the model once more for the nominations its rewrite omitted.
 *
 * The prompt text is already final by now, so this call only names files and
 * skills. It is worth the extra round trip because the alternative is a silent
 * no-op: a model that ignored the envelope still knows which files the task
 * touches, and the narrow question is what surfaces it.
 *
 * @param llm - the live LLM service.
 * @param route - the route the rewrite used.
 * @param prompt - the finished rewrite.
 * @param candidatePaths - real workspace paths to choose from, when available.
 * @param candidateSkills - the skills this agent can load, when available.
 * @param files - whether missing file nominations should be requested.
 * @param skills - whether missing skill nominations should be requested.
 * @param signal - bounded nomination deadline within the reference stage.
 * @returns nominated paths and skill names, empty when the answer is unusable.
 */
async function nominateReferences(llm, route, prompt, candidatePaths = [], candidateSkills = [], skillMode = DEFAULT_SKILL_MODE, files = true, signal) {
  const skills = skillMode !== 'off';
  const supplied = [
    candidatePaths.length === 0 ? '' : `<workspace_paths>\n${candidatePaths.join('\n')}\n</workspace_paths>`,
    candidateSkills.length === 0 ? '' : `<available_skills>\n${candidateSkills.join('\n')}\n</available_skills>`,
  ].filter(Boolean);
  const userText = supplied.length === 0 ? prompt : `${prompt}\n\n${supplied.join('\n\n')}`;
  const fields = [files ? '"files": string[]' : '', skills ? '"skills": string[]' : ''].filter(Boolean);
  const fileRule = candidatePaths.length === 0
    ? 'Nominate at most 5 workspace-relative file paths or distinctive fragments, most relevant first.'
    : 'For "files": copy at most 5 paths from <workspace_paths>, most relevant first. Never invent a path and never copy an entry the task does not need.';
  const system = `You extract references required by a coding task.
Reply with ONE JSON object and nothing else: { ${fields.join(', ')} }.
${files ? fileRule : 'Do not nominate files.'}
${skills ? skillCandidateRule(skillMode, candidateSkills.length > 0) : 'Do not nominate skills.'}
Use empty arrays when nothing applies.`;
  const text = await withSignal(() => callModel(llm, route, system, userText, signal), signal);
  const parsed = parseWholeObject(text);
  const valid = (value) => Array.isArray(value) && value.every((item) => typeof item === 'string');
  if (parsed === null || (files && !valid(parsed.files)) || (skills && !valid(parsed.skills))) {
    throw new Error('the reference nomination response was not a valid JSON object');
  }
  return { files: files ? parsed.files : [], skills: skills ? parsed.skills : [] };
}

/**
 * Build the workspace path listing the candidate question shows.
 *
 * The reference index answers a bare query with one directory's entries, so the
 * overview is a breadth-first walk of its first levels: directories expand until
 * the budget runs out, which keeps a large tree from flooding the question while
 * prioritizing explicit task paths and sharing capacity across top-level areas.
 *
 * @param service - the file-reference service.
 * @param agent - live agent whose working directory bounds discovery.
 * @param signal - cancellation for the listings.
 * @returns workspace-relative paths, breadth-first, capped by the budget.
 */
async function listWorkspacePaths(service, agent, signal, prompt = '', notes = []) {
  const paths = [];
  const seen = new Set();
  const visited = new Set();
  const budget = CANDIDATE_PATH_BUDGET;
  const terms = prompt.toLowerCase().match(/[\p{L}\p{N}_.-]{3,}/gu) ?? [];
  const score = (path) => terms.reduce((sum, term) => sum + (path.toLowerCase().includes(term) ? term.length : 0), 0);
  let successfulQueries = 0;
  const list = async (query) => {
    try {
      const entries = await withSignal(() => service.list(agent, query, signal), signal);
      successfulQueries++;
      return [...entries];
    } catch { return []; }
  };
  const collect = (entry) => {
    if (seen.has(entry.path) || paths.length >= budget) return;
    seen.add(entry.path);
    paths.push(entry.kind === 'directory' ? `${entry.path.replace(/\/+$/u, '')}/` : entry.path);
  };
  // Task paths get first use of the budget, including nonconventional directories.
  const explicit = lostOriginalPaths('', prompt, []);
  for (const path of explicit.slice(0, 8)) {
    if (signal.aborted) break;
    const entries = await list(path.replace(/\/+$/u, ''));
    for (const entry of entries.filter((entry) => nominationMatches(entry.path, path.replace(/\/+$/u, '')))) collect(entry);
  }
  // Root listing is optional: older providers may reject it or return nothing.
  const rootEntries = signal.aborted ? [] : await list('');
  const roots = rootEntries.filter((entry) => entry.kind === 'directory').map((entry) => `${entry.path}/`);
  const taskRoots = explicit.filter((path) => path.includes('/')).map((path) => `${path.split('/')[0]}/`);
  let queue = [...new Set([...taskRoots, ...(roots.length > 0 ? roots : CANDIDATE_DIRECTORY_HINTS.map((name) => `${name}/`))])];
  let batches = [rootEntries];
  let calls = 0;
  // Round-robin collections prevent the first large directory consuming the budget.
  while (!signal.aborted && paths.length < budget) {
    if (queue.length > 0 && calls < 80) {
      const current = queue.splice(0, 6).filter((directory) => !visited.has(directory));
      current.forEach((directory) => visited.add(directory));
      calls += current.length;
      batches.push(...await Promise.all(current.map(list)));
    }
    batches = batches.map((entries) => entries.sort((a, b) => score(b.path) - score(a.path)));
    // Keep some capacity for later top-level areas and deeper files.
    for (let round = 0; round < 8 && paths.length < budget; round++) {
      for (const entries of batches) {
        const entry = entries.shift();
        if (!entry) continue;
        collect(entry);
        if (entry.kind === 'directory' && entry.path.split('/').filter(Boolean).length < 4) {
          const directory = `${entry.path.replace(/\/+$/u, '')}/`;
          if (!visited.has(directory) && !queue.includes(directory)) queue.push(directory);
        }
      }
    }
    batches = batches.filter((entries) => entries.length > 0);
    if ((queue.length === 0 || calls >= 80) && batches.length === 0) break;
  }
  if (signal.aborted) notes.push('workspace discovery timed out; only a partial candidate list was available');
  else if (successfulQueries === 0) notes.push('workspace discovery unavailable: all index queries failed');
  return paths;
}

/** Normalize one model-nominated path into the shape the file index speaks. */
function normalizeQuery(value) {
  return value
    .trim()
    .replaceAll('\\', '/')
    .replace(/^@/u, '')
    .replace(/^"+|"+$/gu, '')
    .replace(/^\.\/+/u, '');
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
  if (path === query) return true;
  // A filename with an extension is a complete name, never a prefix of a backup.
  const completeName = /\.[^/]+$/u.test(query);
  if (completeName && query.includes('/')) return false;
  let offset = path.indexOf(query);
  while (offset !== -1) {
    const next = path[offset + query.length];
    if ((offset === 0 || path[offset - 1] === '/')
      && (next === undefined || next === '/' || (!completeName && next === '.'))) return true;
    offset = path.indexOf(query, offset + 1);
  }
  return false;
}

/** Bound even providers that ignore cancellation, without leaving abort listeners. */
async function withSignal(operation, signal) {
  signal.throwIfAborted();
  let onAbort;
  const aborted = new Promise((resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([Promise.resolve().then(operation), aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/** Restore the original draft if a concrete path or an explicit mention vanished. */
function lostOriginalPaths(rewrite, original, nominations) {
  const paths = new Set();
  for (const match of original.matchAll(/@(?:"([^"\r\n]+)"|([^\s,;，；]+))/gu)) {
    paths.add(normalizeQuery(match[1] ?? match[2]).replace(/[.,:!?，。：！？)）\]}`]+$/u, ''));
  }
  for (const match of original.matchAll(/(?:[\w.-]+[\\/])+[\w.-]+/gu)) {
    if (!original.slice(Math.max(0, match.index - 3), match.index).includes('://')) {
      paths.add(normalizeQuery(match[0]).replace(/\.+$/u, ''));
    }
  }
  for (const match of original.matchAll(/[\w.-]+\.(?:[cm]?[jt]sx?|json|ya?ml|md|html?|css|scss|py|go|rs|java|sh|sql|toml|xml|vue|svelte)\b/gu)) {
    paths.add(match[0]);
  }
  const normalizedOriginal = original.replaceAll('\\', '/');
  for (const nomination of nominations) {
    const query = normalizeQuery(nomination);
    if (query && normalizedOriginal.includes(query)) paths.add(query);
  }
  const normalizedRewrite = rewrite.replaceAll('\\', '/');
  return [...paths].filter((path) => path && !normalizedRewrite.includes(path));
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
async function resolveFileReferences(hostCtx, agent, nominations, signal, notes = []) {
  const service = hostCtx.get('fileReferences');
  if (service === undefined || agent === undefined) {
    throw new Error('file references are unavailable: this composition has no file-reference index for the session');
  }
  const resolved = [];
  const seen = new Set();
  /* The lookups are independent, and a cold index pays its traversal once and
     shares it: resolving them together keeps five nominations from costing five
     serial waits. Order is restored below, so the model's own relevance ranking
     survives. */
  const looked = await Promise.all(nominations.slice(0, MAX_FILE_NOMINATIONS).map(async (nomination) => {
    const query = normalizeQuery(nomination);
    if (query === '') return undefined;
    let candidates;
    try {
      const directory = query.endsWith('/');
      const stem = query.replace(/\/+$/u, '');
      const parent = stem.includes('/') ? `${stem.slice(0, stem.lastIndexOf('/'))}/` : '';
      candidates = await withSignal(() => service.list(agent, directory ? parent : query, signal), signal);
      if (directory) {
        candidates = candidates.filter((entry) => entry.kind === 'directory' && entry.path === stem);
        if (candidates.length === 0) {
          const exact = await withSignal(() => service.list(agent, stem, signal), signal);
          candidates = exact.filter((entry) => entry.kind === 'directory' && entry.path === stem);
        }
      }
    } catch (error) {
      notes.push(`file lookup failed: ${String(error?.message ?? error)}`);
      return undefined;
    }
    const stem = query.replace(/\/+$/u, '');
    const matches = candidates.filter((candidate) => nominationMatches(candidate.path, stem));
    /* Exact paths win; ambiguous fragments are refused instead of guessing. */
    const exact = matches.find((candidate) => candidate.path === stem);
    const unique = [...new Map(matches.map((candidate) => [candidate.path, candidate])).values()];
    const chosen = exact ?? (unique.length === 1 ? unique[0] : undefined);
    if (chosen === undefined) {
      if (unique.length > 1) notes.push(`ambiguous file nomination: ${query}`);
      return undefined;
    }
    const token = formatFileMention(chosen.path, chosen.kind);
    if (token === undefined) return undefined;
    return { path: chosen.path, kind: chosen.kind, token };
  }));
  for (const entry of looked) {
    if (entry === undefined || seen.has(entry.token)) continue;
    seen.add(entry.token);
    resolved.push(entry);
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
  const catalog = await withSignal(() => service.list({ scope: agent, ...(cwd === undefined ? {} : { cwd }), signal }), signal);
  const wanted = new Set(nominations.slice(0, MAX_SKILL_NOMINATIONS).map((name) => name.trim()));
  return catalog
    /* Both policies must allow it: the block tells the agent it may load the
       skill, and DSH only loads a `/name` gesture whose skill is user-invocable. */
    .filter((skill) => wanted.has(skill.name)
      && skill.invocation?.modelInvocable === true
      && skill.invocation?.userInvocable === true)
    .map((skill) => ({ name: skill.name, description: skill.description }));
}

/**
 * List the skills this agent can load, as candidates for the nomination question.
 *
 * The nomination question can only choose a skill it can see, and a model has no
 * way to read the catalog itself — asked to name skills unaided, it correctly
 * answers "none" rather than guess. Files already get a real-path listing for
 * exactly this reason; skills need the same, or a request like "write me a
 * résumé" never reaches the skill that exists for it.
 *
 * Both invocation policies are required: the agent may load the entry, and DSH
 * will honour the `/name` gesture the reference block writes.
 *
 * @param hostCtx - host context carrying the optional skills service.
 * @param agent - live agent whose scope and working directory select the layers.
 * @param cwd - the Session's working directory, when known.
 * @param signal - cancellation for discovery.
 * @returns `name — description` lines, catalog order, capped by the budget.
 */
async function listAvailableSkills(hostCtx, agent, cwd, signal) {
  const service = hostCtx.get('skills');
  if (service === undefined || agent === undefined) return [];
  try {
    const catalog = await withSignal(() => service.list({ scope: agent, ...(cwd === undefined ? {} : { cwd }), signal }), signal);
    return catalog
      .filter((skill) => skill.invocation?.modelInvocable === true && skill.invocation?.userInvocable === true)
      .slice(0, CANDIDATE_SKILL_BUDGET)
      .map((skill) => (typeof skill.description === 'string' && skill.description !== ''
        ? `${skill.name} — ${skill.description}`
        : skill.name));
  } catch {
    /* A catalog that cannot be read simply leaves the question without skills. */
    return [];
  }
}

/** Transform only prose regions, keeping fenced examples intact. */
function outsideFences(prompt, transform) {
  let fence = null;
  let buffer = '';
  let result = '';
  for (const line of prompt.match(/[^\n]*\n|[^\n]+$/gu) ?? []) {
    const delimiter = /^\s*(`{3,}|~{3,})/u.exec(line)?.[1];
    if (delimiter && fence === null) {
      result += transform(buffer);
      buffer = '';
      fence = delimiter;
      result += line;
    } else if (fence !== null) {
      result += line;
      if (delimiter && delimiter[0] === fence[0] && delimiter.length >= fence.length) fence = null;
    } else { buffer += line; }
  }
  return result + transform(buffer);
}

/** Read mention paths outside fenced code; quoted directory mentions end at EOL. */
function existingFileMentions(prompt) {
  const paths = new Set();
  outsideFences(prompt, (prose) => {
    for (const line of prose.split('\n')) {
      for (const match of line.matchAll(/(?:^|\s)@(?:"([^"\r\n]+)"|"([^"\r\n]+)$|([^\s`]+))/gu)) {
        if (line.slice(0, match.index).split('`').length % 2 === 0) continue;
        paths.add(normalizeQuery(match[1] ?? match[2] ?? match[3]).replace(/[，；,;]+$/u, ''));
      }
    }
    return prose;
  });
  return paths;
}

/**
 * Append the validated references to a rewrite.
 *
 * References land on their own lines at the very end. The composer's mention
 * grammar needs `@` at a line start or after whitespace, and appending keeps a
 * leading slash command or mention exactly where the author had it — the rewrite
 * contract already forbids moving it.
 *
 * Each group gets a heading line, the way the skill block does, so a reader sees
 * what the tokens below it mean. Both headings are ours: a previous run's
 * heading is recognised and rebuilt rather than stacked, and a heading inside a
 * code fence is left alone as an example.
 *
 * @param prompt - the rewritten prompt.
 * @param files - validated file references.
 * @param skills - validated skill references.
 * @returns the bounded prompt and only newly appended file and skill entries.
 */
function appendReferences(prompt, files, skills) {
  const mentions = existingFileMentions(prompt);
  const escapedSkillMarker = SKILL_REFERENCE_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedFileMarker = FILE_REFERENCE_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const blockPattern = new RegExp(`^${escapedSkillMarker}\\r?\\n(?:[\\p{L}\\p{N}_.:/-]+\\r?(?:\\n|$))+`, 'gmu');
  /* Our own file group: the heading plus the mention lines it introduces. */
  const filePattern = new RegExp(`^${escapedFileMarker}\\r?\\n(?:@[^\\r\\n]*\\r?(?:\\n|$))+`, 'gmu');
  const knownSkills = new Set();
  const knownMentions = [];
  const knownMentionSet = new Set();
  const keepMention = (token) => {
    if (knownMentionSet.has(token)) return;
    knownMentionSet.add(token);
    knownMentions.push(token);
  };
  // Consolidate only our own well-formed groups, preserving other prose.
  const base = outsideFences(prompt, (prose) => prose
    .replace(filePattern, (block) => {
      block.split(/\r?\n/u).slice(1).filter(Boolean).forEach(keepMention);
      return '';
    })
    .replace(blockPattern, (block) => {
      block.split(/\r?\n/u).slice(1).filter(Boolean).forEach((name) => knownSkills.add(name));
      return '';
    })).trimEnd();
  const acceptedFiles = [];
  const acceptedSkills = [];
  const render = () => [
    base,
    /* Existing mentions are re-emitted unchanged; a guard both keeps them and
       stops an already-mentioned path from being listed twice. */
    knownMentions.length > 0
      ? `${FILE_REFERENCE_MARKER}\n${knownMentions.join('\n')}` : '',
    knownSkills.size > 0 ? `${SKILL_REFERENCE_MARKER}\n${[...knownSkills].join('\n')}` : '',
  ].filter(Boolean).join('\n\n');
  for (const file of files) {
    /* A mention a previous group already carries is re-emitted as it was; one the
       prose already used needs no group entry at all. */
    if (knownMentionSet.has(file.token)) { keepMention(file.token); continue; }
    if (mentions.has(normalizeQuery(file.token))) continue;
    keepMention(file.token);
    if (render().length > MAX_INPUT_CHARS) {
      knownMentionSet.delete(file.token);
      knownMentions.pop();
      continue;
    }
    mentions.add(normalizeQuery(file.token));
    acceptedFiles.push(file);
  }
  for (const skill of skills) {
    /* The block carries gestures, not bare names: `/name` is what DSH turns into
       a skill load when the user sends the prompt. A name its grammar cannot
       carry is dropped rather than appended as a token that does nothing. */
    const gesture = formatSkillGesture(skill.name);
    if (gesture === undefined || knownSkills.has(gesture)) continue;
    knownSkills.add(gesture);
    if (render().length > MAX_INPUT_CHARS) { knownSkills.delete(gesture); continue; }
    acceptedSkills.push(skill);
  }
  const result = render();
  // Existing blocks can have significant spacing; never exceed the final limit.
  if (result.length > MAX_INPUT_CHARS) return { prompt, files: [], skills: [], limited: true };
  return { prompt: result, files: acceptedFiles, skills: acceptedSkills,
    limited: files.some((file) => !mentions.has(normalizeQuery(file.token)))
      || skills.some((skill) => !knownSkills.has(formatSkillGesture(skill.name))) };
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
  const skillMode = state.skillMode;
  const wantSkills = skillMode !== 'off';
  const answer = readRewriteAnswer(await callModel(
    llm,
    route,
    composeSystemPrompt(state.systemPrompt, wantFiles, skillMode),
    `Rewrite the following composer text.\n\n<composer_text>\n${text}\n</composer_text>`,
  ), wantFiles, skillMode);
  if (answer.prompt === '') throw new Error(EMPTY_OUTPUT_MESSAGE);
  if (answer.prompt.length > MAX_INPUT_CHARS) {
    throw new Error('the optimized prompt came back longer than the composer limit');
  }

  const lost = lostOriginalPaths(answer.prompt, text, answer.files);
  if (lost.length > 0) {
    return { prompt: text, route, files: [], skills: [],
      referenceStatus: 'preserved',
      notes: ['the rewrite removed original paths or mentions; the original draft was preserved'] };
  }

  const agent = ctx.get('agents')?.get(sessionId);
  const cwd = agent?.ctx?.get('session')?.cwd;
  const referenceDeadline = Date.now() + REFERENCE_TIMEOUT_MS;
  const referenceSignal = AbortSignal.timeout(REFERENCE_TIMEOUT_MS);
  const notes = [];
  let files = [];
  let skills = [];
  const resolve = async (nominations, resolveFiles, resolveSkills) => {
    await Promise.all([
      (async () => {
        if (!resolveFiles || nominations.files.length === 0) return;
        try {
          files = await resolveFileReferences(ctx, agent, nominations.files, referenceSignal, notes);
        } catch (error) {
          notes.push(String(error?.message ?? error));
        }
      })(),
      (async () => {
        if (!resolveSkills || nominations.skills.length === 0) return;
        try {
          skills = await resolveSkillReferences(ctx, agent, cwd, nominations.skills, referenceSignal);
        } catch (error) {
          notes.push(String(error?.message ?? error));
        }
      })(),
    ]);
  };
  await resolve(answer, wantFiles, wantSkills);
  const needFiles = wantFiles && files.length === 0;
  /* Both sides ask the same way: an empty result means "ask once more, with the
     real candidates in hand". Files were already doing this; skills were not,
     which is why a résumé request never reached the office skill — the model was
     asked to name skills it had no way to see, and correctly answered "none". */
  const needSkills = wantSkills && skills.length === 0;
  if ((wantFiles || wantSkills) && agent === undefined) notes.push('reference processing unavailable: no live agent');
  if (needFiles && ctx.get('fileReferences') === undefined) notes.push('file reference index unavailable');
  if (needSkills && ctx.get('skills') === undefined) notes.push('skill catalog unavailable');
  if ((needFiles || needSkills) && agent !== undefined && !referenceSignal.aborted) {
    let candidates = [];
    if (needFiles) {
      const service = ctx.get('fileReferences');
      if (service !== undefined) {
        const discoverySignal = AbortSignal.any([referenceSignal, AbortSignal.timeout(5000)]);
        candidates = await listWorkspacePaths(service, agent, discoverySignal, text, notes);
      }
    }
    /* Skills get the same treatment as paths: the model cannot read the catalog,
       so an unaided "name the skills you are confident exist" reliably answers
       "none" and a résumé request never reaches the office skill that exists for
       it. Listing them turns the question into a choice. */
    const candidateSkills = needSkills
      ? await listAvailableSkills(ctx, agent, cwd, referenceSignal)
      : [];
    // Reserve time for validation inside the single reference-stage deadline.
    const nominationBudget = referenceDeadline - Date.now() - 3000;
    if (nominationBudget > 0) {
      const nominationSignal = AbortSignal.any([referenceSignal, AbortSignal.timeout(nominationBudget)]);
      try {
        const nominations = await nominateReferences(llm, route, answer.prompt, candidates, candidateSkills,
          needSkills ? skillMode : 'off', needFiles, nominationSignal);
        await resolve(nominations, needFiles, needSkills);
      } catch (error) {
        notes.push(`reference nomination failed: ${String(error?.message ?? error)}`);
      }
    } else {
      notes.push('reference nomination skipped: insufficient time remains for validation');
    }
  }
  const appended = appendReferences(answer.prompt, files, skills);
  if (appended.limited) notes.push('some references were omitted to stay within the composer length limit');
  return {
    prompt: appended.prompt,
    route,
    files: appended.files.map((file) => file.path),
    skills: appended.skills.map((skill) => skill.name),
    referenceStatus: !wantFiles && !wantSkills ? 'disabled' : notes.length > 0 ? 'partial'
      : files.length + skills.length > 0 ? 'complete' : 'none',
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
