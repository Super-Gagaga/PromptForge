/** Read-only smoke probe against an installed DSH distribution. */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
const install = process.env.DSH_INSTALL_DIR ?? join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DeepSeek Harness');
const executable = join(install,'DeepSeek Harness.exe');
if (!existsSync(executable)) throw Error('Set DSH_INSTALL_DIR to the installed Windows DeepSeek Harness directory.');
const checks = [
  { package: 'dsh-client-ui-primitives', path: 'lib/index.js', tokens: ['IconCheckOutlineRegular','IconChevronDownOutlineRegular','IconLoadingOutlineRegular','MenuGroup','Tooltip'], label: 'Client UI primitive exports' },
  { package: 'dsh-client-modules', path: 'lib/client.js', tokens: ['factory(require','__ModuleLoader__'], label: 'Client module-loader factory' },
  { package: 'dsh-client-ui-conversation', path: 'lib/client.js', tokens: ['conversation.input.right','draftRev','setDraft','sessionId'], label: 'Composer slot and draft store' },
  { package: 'dsh-client-ui-settings-general', path: 'lib/client.js', tokens: ['settings.section','_navLabel','data-shortcut-modal'], label: 'Settings slot and optional icon DOM' },
  { package: 'dsh-api-session-controller', path: 'lib/index.js', tokens: ['modelCatalog'], label: 'Remote model catalog' },
  { package: 'dsh-llm', path: 'lib/index.js', tokens: ['listProviders','stream'], label: 'LLM service' },
  { package: 'dsh-file-reference-local', path: 'lib/index.js', tokens: ['list('], label: 'File reference index' },
  { package: 'dsh-skill', path: 'lib/index.js', tokens: ['modelInvocable','userInvocable'], label: 'Skill catalog policies' },
];
const script = `const fs=require('fs'),p=require('path');const root=${JSON.stringify(join(install,'resources','app.asar','dsh','node_modules','@deepseek-ai'))};const checks=${JSON.stringify(checks)};let failed=0;for(const c of checks){try{const pkg=JSON.parse(fs.readFileSync(p.join(root,c.package,'package.json'),'utf8'));const s=fs.readFileSync(p.join(root,c.package,c.path),'utf8');const missing=c.tokens.filter(t=>!s.includes(t));console.log((missing.length?'FAIL':'PASS')+' '+c.label+' ['+c.package+' '+pkg.version+']'+(missing.length?' missing: '+missing.join(', '):''));failed+=missing.length;}catch(e){console.log('FAIL '+c.label+' '+e.message.split('\\n')[0]);failed++;}}process.exitCode=failed?1:0;`;
try { process.stdout.write(execFileSync(executable,['-e',script],{encoding:'utf8',env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},timeout:30000})); }
catch (error) { process.stdout.write(error.stdout ?? ''); process.stderr.write(error.stderr ?? ''); process.exitCode=1; }

