/**
 * dsh-prompt-forge build.
 *
 * Both artifacts are plain JavaScript, so this script has no dependencies: it
 * inlines src/shared.js into both halves and wraps the browser half in the
 * module-loader envelope the client module system serves.
 *
 *   node build.mjs
 *
 * Output goes to `lib/`, which package.json's `exports` names — the layout
 * every shipped DSH package uses. Byte-identical copies are written to the
 * package root as well: a running Host may still hold the root path resolved
 * from an earlier manifest, and a dangling path would blank the plugin's UI
 * until the next restart. Both locations are generated, so they cannot drift.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const read = (relative) => readFile(join(root, relative), 'utf8');

const pkg = JSON.parse(await read('package.json'));
const [shared, host, client] = await Promise.all([
  read('src/shared.js'),
  read('src/host.js'),
  read('src/client.js'),
]);

const banner = (half) =>
  `/* ${pkg.name} v${pkg.version} — generated ${half}. Edit src/ and run "node build.mjs". */\n`;

/** The plugin version, injected where the browser half renders it. */
const versionConst = `const PLUGIN_VERSION = ${JSON.stringify(pkg.version)};\n`;

/**
 * Translate the sources' ESM surface into the factory-form CJS the client
 * module loader materializes: `factory(require) → exports`.
 *
 * The loader calls `registration.factory(require)` and uses the returned object
 * as the module's exports (see `dsh-client-modules`), so a bundle that leaves an
 * `export` statement in place is a classic script with an ESM-only syntax error
 * — it never even reaches the loader. Named imports become `require` bindings,
 * which is how every shipped client bundle obtains React and the primitives.
 */
function toFactoryBody(source) {
  const imports = new Map();
  const withoutImports = source.replace(
    /^import\s*\{([^}]*)\}\s*from\s*'([^']+)';$/gm,
    (match, names, specifier) => {
      const bindings = names.split(',').map((name) => name.trim()).filter((name) => name !== '');
      imports.set(specifier, [...(imports.get(specifier) ?? []), ...bindings]);
      return '';
    },
  );
  const importLines = [...imports.entries()]
    .map(([specifier, names]) => `const { ${names.join(', ')} } = require(${JSON.stringify(specifier)});`)
    .join('\n');
  const withoutExports = withoutImports.replace(
    /^export\s*\{([^}]*)\};$/m,
    (match, names) => names.split(',').map((name) => name.trim()).filter((name) => name !== '')
      .map((name) => `exports.${name} = ${name};`)
      .join('\n'),
  );
  return `\t\t${importLines.split('\n').join('\n\t\t')}\n${withoutExports}`;
}

/* The Host half is an ordinary ES module: shared constants + Host body. */
const hostArtifact = `${banner('Host half')}${shared}\n${host}`;

/* The browser half only registers a factory; the loader materializes it later
   with `factory(require)`. Same-origin `fetch` is a page global, not a module
   import. No re-indentation: template literals inside the sources must keep
   their bytes. */
const clientArtifact = `${banner('browser half')}window.__ModuleLoader__.load({
\tid: ${JSON.stringify(pkg.name)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
${versionConst}${shared}${toFactoryBody(client)}
\t\treturn module.exports;
\t}
});
`;

await mkdir(join(root, 'lib'), { recursive: true });
for (const directory of ['lib', '.']) {
  await writeFile(join(root, directory, 'index.js'), hostArtifact, 'utf8');
  await writeFile(join(root, directory, 'client.js'), clientArtifact, 'utf8');
}

process.stdout.write(
  `${pkg.name}: wrote lib/index.js, lib/client.js (and root mirrors) — ${hostArtifact.length} + ${clientArtifact.length} bytes\n`,
);
