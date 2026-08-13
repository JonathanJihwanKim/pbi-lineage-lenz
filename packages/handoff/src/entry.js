/**
 * Handoff bundle entry point.
 *
 * Bundled into a single IIFE and inlined into the generated file. It reads the payload
 * that the builder embedded in the page and mounts the viewer — nothing else. No fetch,
 * no imports at runtime, no external anything.
 */

import { mountViewer } from '@pbi-lineage-lenz/viewer';

function readPayload() {
  const node = document.getElementById('lenz-payload');
  if (!node) throw new Error('Handoff payload missing');
  return JSON.parse(node.textContent);
}

/**
 * Follow the reader's system theme.
 *
 * A handoff file gets forwarded to people who never chose to open it; forcing a dark page
 * on someone working in a bright room is a small rudeness the tokens already support
 * avoiding. Reuses the [data-theme] block, so no CSS is duplicated to do it.
 */
function applyTheme() {
  const prefersLight = matchMedia('(prefers-color-scheme: light)');
  const set = () => {
    document.documentElement.dataset.theme = prefersLight.matches ? 'light' : 'dark';
  };
  set();
  prefersLight.addEventListener('change', set);
}

function boot() {
  applyTheme();
  const root = document.getElementById('lenz-root');
  let model;

  try {
    model = readPayload();
  } catch (error) {
    root.innerHTML =
      '<div class="empty"><b>This handoff file is damaged</b>'
      + 'Its embedded model could not be read. Ask for a freshly generated copy.</div>';
    console.error(error);
    return;
  }

  const generated = model.meta?.generatedAt
    ? new Date(model.meta.generatedAt).toISOString().slice(0, 10)
    : null;

  mountViewer(root, model, {
    subtitle: [model.meta?.modelName, generated].filter(Boolean).join(' · '),
  });
}

if (document.readyState === 'loading') addEventListener('DOMContentLoaded', boot);
else boot();
