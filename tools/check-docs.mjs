/**
 * Check every relative link and image reference in the Markdown files.
 *
 * A README whose figures do not resolve is worse than one without figures, so
 * this is part of `npm test`.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const root = process.cwd();
const files = readdirSync(root).filter((name) => name.endsWith('.md'));
let checked = 0;
const broken = [];
const anchors = new Map();

/** Collect the heading anchors a Markdown file offers. */
function anchorsOf(file) {
  const slug = (text) => text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/gu, '-');
  return new Set(readFileSync(file, 'utf8').split('\n')
    .filter((line) => /^#{1,6}\s/u.test(line))
    .map((line) => slug(line.replace(/^#{1,6}\s+/u, ''))));
}

for (const name of files) {
  const file = join(root, name);
  const text = readFileSync(file, 'utf8');
  anchors.set(name, anchorsOf(file));
  for (const match of text.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/gu)) {
    const target = match[1];
    if (/^[a-z]+:/iu.test(target)) continue;
    checked++;
    const [path, anchor] = target.split('#');
    if (path !== '') {
      const resolved = resolve(dirname(file), decodeURI(path));
      if (!existsSync(resolved) || statSync(resolved).size === 0) {
        broken.push(`${name} -> ${target}`);
        continue;
      }
    }
    if (anchor !== undefined && anchor !== '' && path === '') {
      if (!anchors.get(name).has(anchor)) broken.push(`${name} -> ${target} (no such heading)`);
    }
  }
  /* Point out fenced blocks that were left unclosed, which silently swallows
     everything after them in most renderers. */
  const fences = (text.match(/^\s*```/gmu) ?? []).length;
  if (fences % 2 !== 0) broken.push(`${name}: unclosed code fence`);
}

if (broken.length > 0) {
  process.stderr.write(`broken references:\n${broken.map((line) => `  ${line}`).join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`dsh-prompt-forge: ${checked} links across ${files.length} markdown files resolve\n`);
}
