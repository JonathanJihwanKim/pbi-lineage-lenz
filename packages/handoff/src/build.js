/**
 * Handoff builder — one self-contained HTML file from a viewer model.
 *
 * The producing side needs Chrome or Edge for the File System Access API. The reading
 * side needs a browser and nothing else: no Power BI, no PBIP folder, no install, no
 * network. That asymmetry is the whole point — the people who most need to read a model
 * are the ones least likely to have the tooling to open one.
 *
 * The payload is embedded as plain JSON rather than compressed. `DecompressionStream`
 * would cut the file by roughly 85%, but it is unsupported in older browsers, and a
 * handoff file that fails to open somewhere is worth less than one that is a few hundred
 * kilobytes larger everywhere.
 *
 * Assembly lives in `template.js` and the two inlined strings in `assets.js`, because the
 * web app builds the identical file in a browser that has neither a filesystem nor a
 * bundler. This module is the Node composition of those two halves.
 */

import { readViewerCss, bundleViewerScript } from './assets.js';
import { renderHandoff, byteLength, sizeVerdict, SIZE_WARN_BYTES, SIZE_FAIL_BYTES } from './template.js';

export { SIZE_WARN_BYTES, SIZE_FAIL_BYTES };
export { renderHandoff, extractPayload, handoffFileName, summarize } from './template.js';

/**
 * Build a handoff file.
 *
 * @param {object} model - Viewer model from toViewerModel().
 * @param {object} [options]
 * @param {string} [options.title] - Document title.
 * @param {boolean} [options.strictSize=true] - Throw above SIZE_FAIL_BYTES.
 * @returns {Promise<{html: string, bytes: number, warnings: string[]}>}
 */
export async function buildHandoff(model, options = {}) {
  const { strictSize = true, title } = options;

  const html = renderHandoff({
    model,
    css: readViewerCss(),
    js: await bundleViewerScript(),
    title,
  });

  const verdict = sizeVerdict(byteLength(html));
  if (verdict.level === 'fail' && strictSize) throw new Error(verdict.message);

  return { html, bytes: verdict.bytes, warnings: verdict.message ? [verdict.message] : [] };
}
