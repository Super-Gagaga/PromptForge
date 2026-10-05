import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'pf-coverage-'));
try {
  const tests = (await readdir(join(root,'tests'))).filter(f => f.endsWith('.test.mjs')).map(f => 'tests/'+f);
  const result = spawnSync(process.execPath, ['--test', ...tests, 'tools/selfcheck.mjs'], { cwd: root, encoding: 'utf8', env: { ...process.env, NODE_V8_COVERAGE: temp, PF_COVERAGE_DIR: temp } });
  process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? '');
  if (result.status !== 0) throw Error('Tests failed; coverage gate not evaluated');
  const names = ['shared','host','client'];
  const originals = Object.fromEntries(await Promise.all(names.map(async n => [n, (await readFile(join(root,'src',n+'.js'),'utf8')).split(/\r?\n/)])));
  const lines = Object.fromEntries(names.map(n => [n,new Map()])), branches = Object.fromEntries(names.map(n => [n,new Map()])), funcs = Object.fromEntries(names.map(n => [n,new Map()]));
  const sourceMap = new Map();
  for (const file of await readdir(temp)) if (file.startsWith('source-')) { const s = JSON.parse(await readFile(join(temp,file),'utf8')); sourceMap.set(s.url,s.code); }
  for (const n of ['index','client']) sourceMap.set(pathToFileURL(join(root,'lib',n+'.js')).href, await readFile(join(root,'lib',n+'.js'),'utf8'));
  // Ordered exact-line alignment accounts for the build's removed imports and
  // exports. No production source is instrumented or changed.
  const cache = new Map();
  function mapping(code) {
    if (cache.has(code)) return cache.get(code);
    const entries = [], built = code.split('\n'); let offset = 0;
    for (let i=0;i<built.length;i++) { entries.push({ start: offset, end: offset+built[i].length, text: built[i].replace(/\r$/,'') }); offset += built[i].length+1; }
    const mapped = [];
    for (const name of names) {
      const src = originals[name]; let cursor = entries.findIndex(e => e.text === src[0]);
      // host/client begin with the same comment delimiter. Locate their module
      // header first, then align back to the opening comment.
      if (name !== 'shared') { const anchor = src.findIndex(l => l.includes(name === 'host' ? 'Host half.' : 'browser half.')); const idx = entries.findIndex(e => e.text === src[anchor]); cursor = idx < 0 ? -1 : idx-anchor; }
      if (cursor < 0) continue;
      let importing = false;
      for (let j=0;j<src.length;j++) {
        const text = src[j];
        if (/^import\b/.test(text)) { importing = !text.endsWith(';'); continue; }
        if (importing) { if (text.endsWith(';')) importing=false; continue; }
        if (/^export\b/.test(text)) continue;
        let idx = cursor;
        while (idx < entries.length && idx < cursor+12 && entries[idx].text !== text) idx++;
        if (idx >= entries.length || idx >= cursor+12) {
          if (text.trim() === '') continue;
          throw Error(`Coverage source alignment failed: src/${name}.js:${j+1}`);
        }
        const e = entries[idx]; mapped.push({ ...e, name, line: j+1 }); cursor=idx+1;
      }
    }
    mapped.sort((a,b)=>a.start-b.start); cache.set(code,mapped); return mapped;
  }
  function add(map,key,hit) { map.set(key,(map.get(key) ?? false) || hit); }
  for (const file of await readdir(temp)) if (file.startsWith('coverage-')) {
    const payload = JSON.parse(await readFile(join(temp,file),'utf8'));
    for (const script of payload.result) {
      const code = sourceMap.get(script.url); if (!code) continue;
      const mapped = mapping(code), ranges = script.functions.flatMap(f => f.ranges).sort((a,b)=>(a.endOffset-a.startOffset)-(b.endOffset-b.startOffset));
      const at = pos => mapped.find(l => l.start <= pos && pos <= l.end);
      for (const line of mapped) {
        if (!line.text.trim() || /^\s*(\/\*|\*|\/\/)/.test(line.text)) continue;
        const pos = line.start + line.text.search(/\S/), range = ranges.find(r => r.startOffset<=pos && r.endOffset>pos);
        if (range) add(lines[line.name],line.line,range.count>0);
      }
      for (const fn of script.functions) {
        const r = fn.ranges[0], start = at(r.startOffset);
        if (start) add(funcs[start.name],start.line+':'+(r.startOffset-start.start)+':'+fn.functionName,r.count>0);
        for (const branch of fn.ranges.slice(1)) { const b = at(branch.startOffset); if (b) add(branches[b.name],b.line+':'+(branch.startOffset-b.start)+':'+(branch.endOffset-branch.startOffset),branch.count>0); }
      }
    }
  }
  const percent = map => map.size === 0 ? 0 : [...map.values()].filter(Boolean).length/map.size*100;
  const report = { files: {}, totals: {} };
  for (const name of names) report.files['src/'+name+'.js'] = { lines: +percent(lines[name]).toFixed(2), branches: +percent(branches[name]).toFixed(2), functions: +percent(funcs[name]).toFixed(2), measuredLines: lines[name].size, uncoveredLines: [...lines[name]].filter(([,hit])=>!hit).map(([line])=>line).sort((a,b)=>a-b) };
  for (const [key,maps] of Object.entries({ lines, branches, functions: funcs })) { const all = new Map(names.flatMap(n=>[...maps[n]].map(([k,v])=>[n+':'+k,v]))); report.totals[key] = +percent(all).toFixed(2); }
  await mkdir(join(root,'coverage'),{recursive:true}); await writeFile(join(root,'coverage','summary.json'),JSON.stringify(report,null,2)+'\n');
  console.table(report.files); console.log('Source coverage:',report.totals);
  // Gates are calibrated against executable source, excluding tests and the
  // same shared helpers duplicated into both bundles.
  const gate = JSON.parse(await readFile(join(root,'tests','coverage-thresholds.json'),'utf8'));
  for (const [file,values] of Object.entries(gate)) for (const [metric,minimum] of Object.entries(values)) if (report.files[file][metric] < minimum) throw Error(`${file} ${metric}: ${report.files[file][metric]}% < ${minimum}%`);
} finally { await rm(temp,{recursive:true,force:true}); }
