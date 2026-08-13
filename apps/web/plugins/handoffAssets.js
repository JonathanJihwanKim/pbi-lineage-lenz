/**
 * Bake the handoff file's two ingredients into the web app at build time.
 *
 * The browser cannot run esbuild or read `viewer.css` off disk, but it has to produce a
 * handoff file identical to the one the CLI produces. So the bundling happens here, at
 * the app's own build time, through the same `assets.js` the CLI calls. Two builders
 * would be two things to keep in step; this is one, invoked twice.
 *
 * The result is a virtual module exporting two strings. It roughly doubles the app's
 * bundle, which is the honest price of the app being able to hand you a file that needs
 * no server.
 */

import { readViewerCss, bundleViewerScript, ENTRY, VIEWER_CSS } from '@pbi-lineage-lenz/handoff/assets';

const VIRTUAL_ID = 'virtual:handoff-assets';
const RESOLVED_ID = `\0${VIRTUAL_ID}`;

/** Compare paths the way a case-insensitive, backslash-using filesystem means them. */
function key(path) {
  return path.replace(/\\/g, '/').toLowerCase();
}

export function handoffAssets() {
  /** Every file that went into the last bundle. */
  let inputs = new Set();

  return {
    name: 'lenz:handoff-assets',

    resolveId(id) {
      return id === VIRTUAL_ID ? RESOLVED_ID : null;
    },

    async load(id) {
      if (id !== RESOLVED_ID) return null;

      const css = readViewerCss();
      const bundled = await bundleViewerScript({ withInputs: true });

      inputs = new Set([VIEWER_CSS, ENTRY, ...bundled.inputs].map(key));
      for (const file of [VIEWER_CSS, ENTRY, ...bundled.inputs]) this.addWatchFile(file);

      return `export const viewerCss = ${JSON.stringify(css)};\n`
        + `export const viewerJs = ${JSON.stringify(bundled.code)};\n`;
    },

    /**
     * Rebuild the embedded copy when any viewer source changes.
     *
     * `addWatchFile` is not enough on its own: it registers the dependency, but Vite's dev
     * server hot-reloads from its own module graph, which this bundle is not part of. The
     * observable failure is nasty and quiet — edit a viewer component, watch the app on
     * screen update correctly, then export a handoff file still carrying the old code.
     * Nobody checks a file they just exported; the recipient finds it.
     *
     * Verified by editing a string in `pageLens.js` and re-fetching the virtual module.
     */
    configureServer(server) {
      server.watcher.on('change', (file) => {
        if (!inputs.has(key(file))) return;

        const graph = server.environments?.client?.moduleGraph ?? server.moduleGraph;
        const module = graph?.getModuleById(RESOLVED_ID);
        if (module) graph.invalidateModule(module);

        // The app reads these strings once at import, so there is nothing to hot-swap —
        // a reload is what actually picks the new bundle up.
        (server.hot ?? server.ws)?.send({ type: 'full-reload' });
      });
    },
  };
}
