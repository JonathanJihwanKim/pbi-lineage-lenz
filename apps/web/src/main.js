/**
 * PBI Lineage Lenz — the web app.
 *
 * Three screens and no router: pick something, watch it parse, read it. The viewer that
 * appears at the end is the same component a handoff file mounts, so this app is mostly
 * the part a handoff file does not need — getting a folder off disk, and putting one back.
 *
 * Nothing is uploaded. The folder is read in the page, parsed in the page, and rendered
 * in the page; there is no server to send it to. That is worth stating plainly on screen,
 * because the natural assumption about a web app that asks for your project folder is the
 * opposite, and a data engineer is right to ask.
 */

import '@pbi-lineage-lenz/viewer/viewer.css';
import './app.css';

import { analyzeFromFiles } from '@pbi-lineage-lenz/core';
import { toViewerModel, mountViewer, h, replace } from '@pbi-lineage-lenz/viewer';
import { extractPayload } from '@pbi-lineage-lenz/handoff/template';
import { pickFolder, pickFile, hasFileSystemAccess } from './readFolder.js';
import { partitionPbip, describeProblem, describeChoice } from './pbipFolder.js';
import { buildHandoffInBrowser, saveFile } from './exportHandoff.js';
import { toJson, jsonFileName } from '@pbi-lineage-lenz/export';
import { valueMoment } from './valueMoment.js';

const root = document.getElementById('app');
let viewer = null;

/** Follow the reader's system theme rather than imposing one. */
function applyTheme() {
  const light = matchMedia('(prefers-color-scheme: light)');
  const set = () => { document.documentElement.dataset.theme = light.matches ? 'light' : 'dark'; };
  set();
  light.addEventListener('change', set);
}

function teardown() {
  viewer?.destroy();
  viewer = null;
}

// ── Screens ─────────────────────────────────────────────────────────────────────

function showLanding(message) {
  teardown();
  root.className = 'app-landing';

  const openFolder = h('button.btn.btn-accent.big', {
    type: 'button',
    onClick: () => loadFolder(),
  }, 'Open a PBIP folder');

  const openHandoff = h('button.btn.big', {
    type: 'button',
    onClick: () => loadHandoff(),
  }, 'Open a handoff file');

  // Nothing to install, nothing to pick, nothing to trust us with. Somebody evaluating
  // this in thirty seconds should be able to see the whole thing working first, and
  // decide about their own folder afterwards.
  const seeExample = h('a.btn.big', {
    href: `${import.meta.env.BASE_URL}demo.html`,
    target: '_blank',
    rel: 'noopener',
  }, 'See a live example');

  replace(root,
    h('div.landing',
      h('div.landing-head',
        h('div.landing-mark', h('span.lens'), h('b', 'PBI Lineage Lenz')),
        h('p.landing-tag', 'One lens on your Power BI model — for the BI developer and the data engineer.')),

      message ? h('div.notice.notice-warn', message) : null,

      h('div.landing-actions', openFolder, openHandoff, seeExample),

      h('div.landing-note',
        hasFileSystemAccess()
          ? 'Your folder is read in this page and never leaves your machine. There is no server.'
          : 'Your folder is read in this page and never leaves your machine. '
            + 'This browser has no File System Access API, so folders are read through a file picker — '
            + 'everything works, but saving an export goes to your downloads folder.'),

      h('div.landing-cards',
        // Model leads: "what am I looking at?" is the question that comes before "where
        // did this column come from?" for anyone meeting a model they did not build.
        card('Model',
          'Which tables are facts and which are dimensions, read from the direction of '
          + 'their relationships rather than their names. Pick a table and see exactly '
          + 'what it joins to — one neighbourhood at a time, never a hairball.'),
        card('Source map',
          'Every model column beside the physical table and column it came from — '
          + 'sales_dw.dbo.FactSales.amt_net_usd next to Sales[Net Amount]. '
          + 'Each row says how confident that mapping is, and unknown stays unknown.'),
        card('Measures',
          'The DAX, the physical columns underneath it, and — the question that decides '
          + 'whether a change is safe — every visual that shows it, located on its page.'),
        card('Pages',
          'What is on each report page and where. Nothing is filtered out: hidden visuals '
          + 'are listed with the bookmark that reveals them, because that is where field '
          + 'parameters and calculation groups live.')),

      h('div.landing-hand',
        h('b', 'The handoff file'),
        h('p',
          'Export one self-contained HTML file and send it to someone with no Power BI, no '
          + 'project folder, and no install. It opens in any browser and fetches nothing. '
          + 'Every measure and column has a link you can paste into a chat.')),

      footer()));
}

function card(title, body) {
  return h('div.landing-card', h('b', title), h('p', body));
}

function footer() {
  return h('footer.lenz-footer',
    h('span', 'Free and open source · MIT'),
    h('span', { style: { flex: '1' } }),
    h('span', h('a', { href: 'https://github.com/JonathanJihwanKim/pbi-lineage-lenz', target: '_blank', rel: 'noopener' }, 'GitHub')));
}

function showBusy(label) {
  teardown();
  root.className = 'app-busy';
  const detail = h('div.busy-detail', '');
  replace(root, h('div.busy', h('div.busy-bar'), h('b', label), detail));
  return (text) => { detail.textContent = text; };
}

function showViewer(model, { source, note = null }) {
  teardown();
  root.className = 'app-viewer';

  const status = h('span.export-status');

  const exportBtn = h('button.btn.btn-accent', {
    type: 'button',
    onClick: async () => {
      exportBtn.disabled = true;
      status.textContent = 'building…';
      const started = performance.now();
      try {
        const built = buildHandoffInBrowser(model);
        // Measured before the save: the picker is the user deciding where to put the
        // file, and counting their deliberation as the tool's runtime would be a lie in
        // the direction that flatters nobody.
        const buildMs = performance.now() - started;
        const result = await saveFile(built.fileName, built.html);
        status.className = `export-status ${built.level === 'ok' ? '' : 'warn'}`.trim();
        status.textContent = result === 'cancelled'
          ? ''
          : `${built.fileName} · ${(built.bytes / 1024 / 1024).toFixed(2)} MB${built.message ? ` · ${built.message}` : ''}`;

        // Only after a real save, and never after a cancel or a failure.
        if (result !== 'cancelled') {
          const prompt = valueMoment(model, buildMs);
          if (prompt) root.append(prompt);
        }
      } catch (error) {
        status.className = 'export-status warn';
        status.textContent = error.message;
        console.error(error);
      } finally {
        exportBtn.disabled = false;
      }
    },
  }, 'Export handoff');

  // The same model the viewer is rendering, for anyone building their own thing on it.
  // Cheap enough to be synchronous — no bundling, just the payload — so it needs none of
  // the progress reporting the handoff export earns.
  const jsonBtn = h('button.btn', {
    type: 'button',
    title: 'The parsed model as JSON — the same data this page is rendering',
    onClick: async () => {
      jsonBtn.disabled = true;
      try {
        const text = toJson(model);
        const result = await saveFile(jsonFileName(model), text, 'application/json');
        status.className = 'export-status';
        status.textContent = result === 'cancelled'
          ? ''
          : `${jsonFileName(model)} · ${(new TextEncoder().encode(text).length / 1024 / 1024).toFixed(2)} MB`;
      } catch (error) {
        status.className = 'export-status warn';
        status.textContent = error.message;
        console.error(error);
      } finally {
        jsonBtn.disabled = false;
      }
    },
  }, 'Export JSON');

  const closeBtn = h('button.btn', { type: 'button', onClick: () => showLanding() }, 'Close');

  // "Shop · Shop" when a folder is named after the model it holds, which is the common
  // case — the second half only earns its space when it says something new.
  const name = model.meta?.modelName;
  const subtitle = [name, source === name ? null : source].filter(Boolean).join(' · ');

  viewer = mountViewer(root, model, { subtitle, actions: [status, jsonBtn, exportBtn, closeBtn] });

  // Which report was chosen, when the folder held more than one. Prepended rather than
  // appended: someone reading numbers that belong to a report they did not have in mind
  // needs to know before they read them, not after.
  if (note) root.prepend(h('div.notice.notice-warn', note));
}

function showError(title, detail) {
  teardown();
  root.className = 'app-landing';
  replace(root,
    h('div.landing',
      h('div.landing-mark', h('span.lens'), h('b', 'PBI Lineage Lenz')),
      h('div.notice.notice-error', h('b', title), h('p', detail)),
      h('div.landing-actions',
        h('button.btn.btn-accent.big', { type: 'button', onClick: () => showLanding() }, 'Try again')),
      footer()));
}

// ── Actions ─────────────────────────────────────────────────────────────────────

async function loadFolder() {
  const progress = showBusy('Reading your project folder');
  try {
    const picked = await pickFolder((count) => progress(`${count} files`));
    if (!picked) { showLanding(); return; }

    progress(`${picked.files.size} files read · parsing`);
    // One frame, so the count above actually paints before the parse blocks the thread.
    await new Promise((resolve) => requestAnimationFrame(resolve));

    const partition = partitionPbip(picked.files);
    const problem = describeProblem(partition);
    if (problem) { showLanding(problem); return; }

    const analysis = analyzeFromFiles({
      modelFiles: partition.modelFiles,
      reportFiles: partition.reportFiles ?? undefined,
    });

    showViewer(toViewerModel(analysis, {
      modelName: partition.modelName || picked.name,
      reportName: partition.reportName,
      projectPath: picked.name,
    }), { source: picked.name });
  } catch (error) {
    console.error(error);
    showError('That folder could not be read', error.message);
  }
}

async function loadHandoff() {
  try {
    const picked = await pickFile();
    if (!picked) { showLanding(); return; }

    const progress = showBusy('Opening the handoff file');
    progress(picked.name);
    await new Promise((resolve) => requestAnimationFrame(resolve));

    showViewer(extractPayload(picked.text), { source: picked.name });
  } catch (error) {
    console.error(error);
    showError('That file could not be opened', error.message);
  }
}

applyTheme();
showLanding();
