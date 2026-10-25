/**
 * Read-only smoke probe against an installed DSH distribution.
 *
 * Every contract this plugin depends on is asserted against the *installed*
 * build, so a DSH upgrade that moves a package, a slot id, or a grammar fails
 * here instead of silently breaking the plugin at runtime.
 *
 * A contract may live in a package file (`path`) or in a hashed build asset
 * (`dir` + `suffix`), because some modules are compiled into the web frontend
 * rather than shipped as their own package.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
const install = process.env.DSH_INSTALL_DIR ?? join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DeepSeek Harness');
const executable = join(install,'DeepSeek Harness.exe');
if (!existsSync(executable)) throw Error('Set DSH_INSTALL_DIR to the installed Windows DeepSeek Harness directory.');
const checks = [
  /* `@deepseek-ai/dsh-client-ui-primitives` is no longer a shipped package: the
     module is registered by the web frontend bundle under the same id. Scanning
     the assets keeps this check honest across hash renames. */
  { package: 'dsh-web-frontend', dir: 'dist/assets', suffix: '.js', tokens: ['"@deepseek-ai/dsh-client-ui-primitives"'], label: 'Client UI primitive module registration' },
  { package: 'dsh-client-modules', path: 'lib/client.js', tokens: ['factory(require','__ModuleLoader__'], label: 'Client module-loader factory' },
  { package: 'dsh-client-ui-conversation', path: 'lib/client.js', tokens: ['conversation.input.right','draftRev','setDraft','sessionId','attachmentIds'], label: 'Composer slot, draft store and attachments' },
  { package: 'dsh-client-ui-settings-general', path: 'lib/client.js', tokens: ['settings.section','_navLabel','data-shortcut-modal'], label: 'Settings slot and optional icon DOM' },
  { package: 'dsh-api-session-controller', path: 'lib/index.js', tokens: ['modelCatalog'], label: 'Remote model catalog' },
  { package: 'dsh-llm', path: 'lib/index.js', tokens: ['listProviders','stream','inputModalities'], label: 'LLM service and image modalities' },
  { package: 'dsh-attachment', path: 'lib/index.js', tokens: ['admitPromptContent','imageLimits'], label: 'Attachment admission for draft images' },
  { package: 'dsh-file-reference', path: 'lib/index.js', tokens: ['formatFileMention','FILE_REFERENCE_PROMPT'], label: 'File reference grammar and guidance' },
  { package: 'dsh-file-reference-local', path: 'lib/index.js', tokens: ['list('], label: 'File reference index' },
  { package: 'dsh-skill', path: 'lib/index.js', tokens: ['modelInvocable','userInvocable'], label: 'Skill catalog policies' },
  { package: 'dsh-tool-skill', path: 'lib/index.js', tokens: ['SKILL_GESTURE'], label: 'Skill gesture grammar' },
];
const script = `const fs=require('fs'),p=require('path');const root=${JSON.stringify(join(install,'resources','app.asar','dsh','node_modules','@deepseek-ai'))};const checks=${JSON.stringify(checks)};
function read(c){const dir=p.join(root,c.package);
  if(c.path) return fs.readFileSync(p.join(dir,c.path),'utf8');
  const assets=p.join(dir,c.dir);
  return fs.readdirSync(assets).filter(f=>f.endsWith(c.suffix)).map(f=>fs.readFileSync(p.join(assets,f),'utf8')).join(' ');
}
let failed=0;
for(const c of checks){try{const pkg=JSON.parse(fs.readFileSync(p.join(root,c.package,'package.json'),'utf8'));const s=read(c);const missing=c.tokens.filter(t=>!s.includes(t));console.log((missing.length?'FAIL':'PASS')+' '+c.label+' ['+c.package+' '+pkg.version+']'+(missing.length?' missing: '+missing.join(', '):''));failed+=missing.length;}catch(e){console.log('FAIL '+c.label+' '+e.message.split('\\n')[0]);failed++;}}
process.exitCode=failed?1:0;`;
try { process.stdout.write(execFileSync(executable,['-e',script],{encoding:'utf8',env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},timeout:30000})); }
catch (error) { process.stdout.write(error.stdout ?? ''); process.stderr.write(error.stderr ?? ''); process.exitCode=1; }
