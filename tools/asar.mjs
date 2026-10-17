/**
 * Read files out of the installed DSH ASAR.
 *
 * Figures and probes need the shipped theme tokens and UI strings. The ASAR is
 * the only copy that is guaranteed to match the running app, and it survives
 * updates, so read it directly instead of depending on a temporary extraction.
 *
 * ASAR layout: 8-byte header, a JSON directory header, then concatenated bytes.
 */
import { readFileSync } from 'node:fs';

/** The installed archive; override with DSH_ASAR when the app lives elsewhere. */
export const ASAR_PATH = process.env.DSH_ASAR
  ?? 'C:/Users/hzh12/AppData/Local/Programs/DeepSeek Harness/resources/app.asar';

/**
 * Open the archive once and return a reader for individual files.
 *
 * @param archive - absolute path to app.asar.
 * @returns `{ read, list }` helpers keyed by archive-internal path.
 */
export function openAsar(archive = ASAR_PATH) {
  const buffer = readFileSync(archive);
  const headerSize = buffer.readUInt32LE(4);
  const headerLength = buffer.readUInt32LE(12);
  const header = JSON.parse(buffer.subarray(16, 16 + headerLength).toString('utf8'));
  const dataStart = 8 + headerSize;

  const walk = (node, path, visit) => {
    for (const [name, child] of Object.entries(node.files ?? {})) {
      const here = `${path}/${name}`;
      if (child.files === undefined) visit(here, child);
      else walk(child, here, visit);
    }
  };

  return {
    /**
     * Read one file as UTF-8 text.
     *
     * @param path - archive-internal path such as `/dsh/package.json`.
     * @returns the file text.
     */
    read(path) {
      let hit;
      walk(header, '', (here, entry) => {
        if (here === path) hit = entry;
      });
      if (hit === undefined) throw new Error(`not in app.asar: ${path}`);
      const start = dataStart + Number(hit.offset);
      return buffer.subarray(start, start + Number(hit.size)).toString('utf8');
    },

    /**
     * List archive-internal paths, optionally filtered.
     *
     * @param suffix - keep only paths ending with this string.
     * @returns matching paths.
     */
    list(suffix = '') {
      const out = [];
      walk(header, '', (here) => {
        if (here.endsWith(suffix)) out.push(here);
      });
      return out;
    },
  };
}
