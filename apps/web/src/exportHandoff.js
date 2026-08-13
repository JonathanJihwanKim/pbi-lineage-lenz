/**
 * Producing the handoff file in the browser.
 *
 * The viewer bundle and stylesheet are baked into this app at build time by
 * `plugins/handoffAssets.js`, which calls the same esbuild invocation the CLI uses. So a
 * file exported here is byte-identical to one exported by `npx pbi-lineage-lenz handoff`,
 * and neither can drift from the other without the build noticing.
 */

import { renderHandoff, byteLength, sizeVerdict, handoffFileName } from '@pbi-lineage-lenz/handoff/template';
import { viewerCss, viewerJs } from 'virtual:handoff-assets';

/**
 * Build a handoff file from a viewer model.
 * @returns {{html: string, bytes: number, level: string, message: string|null, fileName: string}}
 */
export function buildHandoffInBrowser(model) {
  const html = renderHandoff({ model, css: viewerCss, js: viewerJs });
  return { html, ...sizeVerdict(byteLength(html)), fileName: handoffFileName(model) };
}

/**
 * Save text to disk, letting the user choose where when the browser allows it.
 *
 * `showSaveFilePicker` puts the file where the user meant it to go; the anchor fallback
 * drops it in Downloads. Both work, so the fallback is not worth apologising for.
 *
 * @returns {Promise<'saved'|'downloaded'|'cancelled'>}
 */
export async function saveFile(fileName, text, mime = 'text/html') {
  if (typeof globalThis.showSaveFilePicker === 'function') {
    try {
      const handle = await globalThis.showSaveFilePicker({
        suggestedName: fileName,
        types: [{ description: 'HTML file', accept: { 'text/html': ['.html'] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(text);
      await writable.close();
      return 'saved';
    } catch (error) {
      if (error?.name === 'AbortError') return 'cancelled';
      // Anything else — a sandboxed iframe, a policy block — falls through to the
      // download path rather than losing the user's export.
    }
  }

  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  // Revoking immediately can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return 'downloaded';
}
