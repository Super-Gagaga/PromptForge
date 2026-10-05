import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
// V8 does not retain script text. Keep exact evaluated text beside its raw
// coverage so wrappers and test-only exports cannot shift source attribution.
export function recordSource(filename, code) {
  if (!process.env.PF_COVERAGE_DIR) return filename;
  const id = createHash('sha256').update(code).digest('hex');
  const url = pathToFileURL(filename).href + '?pf=' + id;
  writeFileSync(join(process.env.PF_COVERAGE_DIR, 'source-'+id+'.json'), JSON.stringify({ url, code }));
  return url;
}
