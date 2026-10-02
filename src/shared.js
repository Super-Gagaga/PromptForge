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

/** Upper bound on file paths the model may nominate for one rewrite. */
const MAX_FILE_NOMINATIONS = 5;

/** Upper bound on skill names the model may nominate for one rewrite. */
const MAX_SKILL_NOMINATIONS = 3;

/** Appended to the composer output when the model produced nothing usable. */
const EMPTY_OUTPUT_MESSAGE = 'prompt-forge: the model returned no usable prompt text';

/**
 * Marker opening the appended skill-reference block.
 *
 * A skill is not a path: DSH loads one through the model-facing `skill` tool,
 * keyed by name. The block therefore names the skills the rewrite depends on and
 * says how to load them, instead of inventing a text token the agent would not
 * understand.
 */
const SKILL_REFERENCE_MARKER = 'Skills this task may need (load one with the skill tool by name):';

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
 * @param skills - whether skill nominations are collected.
 * @returns the instruction, or an empty string when neither is enabled.
 */
function buildEnvelopeInstruction(files, skills) {
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
  }
  if (skills) {
    rules.push('- For "skills": list only skills you are confident exist and that this task needs, at most 3. Use an empty array when none apply.');
  }
  rules.push('- Include every field even when it is empty, and prefer an empty list over a guess.');
  return `\n\n${rules.join('\n')}`;
}

/**
 * Compose the system instruction for one rewrite.
 *
 * @param systemPrompt - the user's configured instruction.
 * @param files - whether file nominations are collected.
 * @param skills - whether skill nominations are collected.
 * @returns the instruction the model receives.
 */
function composeSystemPrompt(systemPrompt, files, skills) {
  const envelope = buildEnvelopeInstruction(files, skills);
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
- When the text is vague, make the goal, the relevant context, the expected deliverable, and any real acceptance criteria explicit — without adding scope the author did not imply.
- When the text already reads well, make only light corrections instead of padding it.
- Structure only as much as the content earns: plain prose for short asks, a short labelled list when there are several distinct requirements. Do not force a template onto a simple request.
- Keep any leading slash command, file reference, or mention marker exactly where the author put it, and keep it on the first line.

${PLAIN_OUTPUT_CONTRACT}`;

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
    referenceSkills: flag(source.referenceSkills, true),
  };
}

/** The defaults, built through the same validator so the shapes cannot drift. */
const DEFAULT_STATE = normalizeState({});
