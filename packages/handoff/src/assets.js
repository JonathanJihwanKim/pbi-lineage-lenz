/**
 * The two strings a handoff file is built from — stylesheet and viewer bundle.
 *
 * Node-only: it reads from disk and shells out to esbuild. The browser cannot do either,
 * so the web app gets the same two strings baked in at its own build time (see
 * `apps/web/plugins/handoffAssets.js`, which calls straight into this module). One
 * bundler invocation, described once.
 */

import { readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Entry point bundled into every handoff file. */
export const ENTRY = join(HERE, 'entry.js');
/** Stylesheet inlined into every handoff file. */
export const VIEWER_CSS = join(HERE, '../../viewer/src/viewer.css');

/** @returns {string} */
export function readViewerCss() {
  return readFileSync(VIEWER_CSS, 'utf-8');
}

/**
 * Bundle the viewer into a single IIFE with no imports left in it.
 *
 * `es2020` rather than anything newer: a handoff file is opened by whoever it was
 * forwarded to, on whatever browser their employer installed, possibly a year from now.
 *
 * @param {object} [options]
 * @param {boolean} [options.withInputs=false] - Also return every file that went into the
 *   bundle, so a watching build can invalidate on any of them.
 * @returns {Promise<string|{code: string, inputs: string[]}>}
 */
export async function bundleViewerScript({ withInputs = false } = {}) {
  const esbuild = await import('esbuild');
  const result = await esbuild.build({
    entryPoints: [ENTRY],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['es2020'],
    minify: true,
    write: false,
    legalComments: 'none',
    metafile: withInputs,
  });

  const code = result.outputFiles[0].text;
  if (!withInputs) return code;

  // Every module esbuild pulled in, not just the entry. Watching the entry alone would
  // leave the embedded copy stale after an edit to any viewer component — the app on
  // screen would update while the file it exports quietly did not.
  return { code, inputs: Object.keys(result.metafile.inputs).map((p) => resolve(p)) };
}
