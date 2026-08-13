import { defineConfig } from 'vite';
import { handoffAssets } from './plugins/handoffAssets.js';

/**
 * `base` is the GitHub Pages sub-path. Project pages are served from
 * `/<repo>/`, so a root-absolute asset path 404s there while working perfectly
 * on localhost — the classic way a Pages deploy ships broken. Overridable via
 * PAGES_BASE for a custom domain or a fork under another name.
 */
export default defineConfig({
  base: process.env.PAGES_BASE ?? '/pbi-lineage-lenz/',
  plugins: [handoffAssets()],
  build: {
    outDir: 'dist',
    target: 'es2020',
    // The embedded viewer bundle is a single large string by design, not an
    // oversight worth warning about on every build.
    chunkSizeWarningLimit: 2000,
  },
  server: { port: 5173 },
});
