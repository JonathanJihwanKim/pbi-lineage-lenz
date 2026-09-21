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

import { analyzeFromFiles, parseModel, analyzeReport, identifyProjectStructure } from '@pbi-lineage-lenz/core';
import { toViewerModel, mountViewer, h, replace } from '@pbi-lineage-lenz/viewer';
import { extractPayload } from '@pbi-lineage-lenz/handoff/template';
import { pickFolder, pickFile, hasFileSystemAccess } from './readFolder.js';
import { planOpen } from './pbipFolder.js';
import { buildHandoffInBrowser, saveFile } from './exportHandoff.js';
import { toJson, jsonFileName } from '@pbi-lineage-lenz/export';
import { valueMoment } from './valueMoment.js';

const root = document.getElementById('app');
let viewer = null;

/**
 * What the last folder pick found, when it found more than one thing.
 *
 * Held so that "Switch report" costs nothing: the files are already in memory, and asking
 * somebody to find their folder again to read the report next to the one they opened
 * would be the tool forgetting what it was just shown.
 */
let picked = null;

/** Parsed models, keyed as partitionEstate keys them. A shared model is parsed once. */
const parsedModels = new Map();

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
  }, 'Open a PBIP project folder');

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

      // The one thing the old label never said. A workspace holds several of each folder,
      // and a browser can only read the folder you pick — so pointing at the report you
      // were editing leaves its model, which is its sibling, out of reach. A picture of
      // the shape answers that faster than a sentence about it.
      h('div.landing-hint',
        h('pre.landing-tree', [
          'my_workspace/                              ← pick this folder',
          '├─ contoso_project.Report/',
          '│  └─ definition.pbir                      ← names the model it reads',
          '├─ contoso_sales_thin.Report/',
          '└─ directlake_import_composite.SemanticModel/',
        ].join('\n')),
        h('p',
          'Pick the folder that holds your .Report and .SemanticModel folders — not one of '
          + 'them. If it holds several reports, you choose which one next. A .SemanticModel '
          + 'folder on its own also works, for the model lenses without the report.')),

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

function showViewer(model, { source, canSwitch = false }) {
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

  // Only when a chooser was passed through: the files are still in memory, so going back
  // to read the report next to this one costs nothing and asks for nothing.
  const switchBtn = canSwitch
    ? h('button.btn', { type: 'button', onClick: () => showChooser() }, 'Switch report')
    : null;

  const closeBtn = h('button.btn', { type: 'button', onClick: () => { picked = null; showLanding(); } }, 'Close');

  // "Shop · Shop" when a folder is named after the model it holds, which is the common
  // case — the second half only earns its space when it says something new.
  const name = model.meta?.modelName;
  const subtitle = [name, source === name ? null : source].filter(Boolean).join(' · ');

  const actions = [status, jsonBtn, exportBtn, switchBtn, closeBtn].filter(Boolean);
  viewer = mountViewer(root, model, { subtitle, actions });
}

/**
 * Which report, when the folder held more than one.
 *
 * A Fabric workspace synced to git is many thin reports over a few shared models, so a
 * folder with four reports in it is the ordinary shape rather than an exotic one. The
 * version of this that chose silently and mentioned the rest in a footnote put numbers on
 * screen belonging to a report the reader may not have had in mind — and the footnote told
 * them to pass `--all`, a flag that exists only in the command line.
 *
 * Reports are grouped under the model each one names, because `definition.pbir` is the
 * only thing that states the pairing and the names routinely do not match.
 */
function showChooser() {
  teardown();
  root.className = 'app-chooser';

  const { estate, name } = picked;
  const byModel = new Map(estate.models.map((model) => [model.key, model]));
  const paired = estate.reports.filter((report) => report.modelKey !== null);
  const orphans = estate.reports.filter((report) => report.modelKey === null);

  const count = (report) => `${report.visualCount} visual${report.visualCount === 1 ? '' : 's'}`;

  const reportRow = (report) => h('button.chooser-row', {
    type: 'button',
    onClick: () => openPair(byModel.get(report.modelKey), report),
  }, h('b', report.name), h('span.chooser-meta', count(report)));

  const modelGroup = (model) => {
    const reports = paired.filter((report) => report.modelKey === model.key);
    return h('div.chooser-group',
      h('div.chooser-model', h('span.chooser-kind', 'semantic model'), h('b', model.name)),
      ...reports.map(reportRow),
      // Worth offering even when the model has reports: the model lenses are the whole
      // answer to "what am I looking at?", and they do not need a report at all.
      h('button.chooser-row.chooser-row-model', {
        type: 'button',
        onClick: () => openPair(model, null),
      }, h('span', reports.length > 0 ? 'Open the model on its own' : 'Open this model'),
      h('span.chooser-meta', 'no report')));
  };

  replace(root,
    h('div.chooser',
      h('div.landing-mark', h('span.lens'), h('b', 'PBI Lineage Lenz')),

      h('div.chooser-head',
        h('b', 'Which report?'),
        h('p', `${name} holds ${estate.models.length} semantic model`
          + `${estate.models.length === 1 ? '' : 's'} and ${estate.reports.length} report`
          + `${estate.reports.length === 1 ? '' : 's'}. `
          + 'Each report is listed under the model its definition.pbir names — which is not '
          + 'always the one it sorts next to.')),

      ...estate.models.map(modelGroup),

      // Listed rather than dropped: a report whose model is not in the folder is itself
      // something the reader should know, and silence would read as the report missing.
      orphans.length > 0
        ? h('div.chooser-group.chooser-group-orphan',
          h('div.chooser-model', h('span.chooser-kind', 'not paired')),
          ...orphans.map((report) => h('div.chooser-row.chooser-row-dead',
            h('b', report.name),
            h('span.chooser-meta', report.problem))))
        : null,

      h('div.chooser-actions',
        h('button.btn', { type: 'button', onClick: () => { picked = null; showLanding(); } },
          'Pick a different folder')),

      footer()));
}

/**
 * Analyse one model, optionally against one report, and show it.
 *
 * The model is parsed once and kept: moving between thin reports over a shared model is
 * the reason the chooser exists, and re-parsing the model on each hop would make the
 * cheapest move in the app the slowest one.
 */
function openPair(model, report) {
  const progress = showBusy(report ? `Reading ${report.name}` : `Reading ${model.name}`);
  progress(model.name);

  requestAnimationFrame(() => {
    try {
      if (!parsedModels.has(model.key)) {
        parsedModels.set(model.key, parseModel(identifyProjectStructure(model.files)));
      }

      const analysis = analyzeReport(
        parsedModels.get(model.key),
        report ? identifyProjectStructure(report.files) : null,
      );

      showViewer(toViewerModel(analysis, {
        modelName: model.name,
        reportName: report ? report.name : null,
        modelKey: model.key,
        reportKey: report ? report.key : null,
        projectPath: picked.name,
      }), { source: picked.name, canSwitch: true });
    } catch (error) {
      console.error(error);
      showError(`${report ? report.name : model.name} could not be read`, error.message);
    }
  });
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
    const folder = await pickFolder((count) => progress(`${count} files`));
    if (!folder) { showLanding(); return; }

    progress(`${folder.files.size} files read · parsing`);
    // One frame, so the count above actually paints before the parse blocks the thread.
    await new Promise((resolve) => requestAnimationFrame(resolve));

    picked = null;
    parsedModels.clear();

    // One pick, three honest outcomes: something to read, something to choose between, or
    // something to say about what was picked.
    const plan = planOpen(folder.files, { name: folder.name });

    if (plan.screen === 'problem') { showLanding(plan.message); return; }

    if (plan.screen === 'chooser') {
      picked = { estate: plan.estate, name: folder.name };
      showChooser();
      return;
    }

    const { partition } = plan;
    const analysis = analyzeFromFiles({
      modelFiles: partition.modelFiles,
      reportFiles: partition.reportFiles ?? undefined,
    });

    showViewer(toViewerModel(analysis, {
      modelName: partition.modelName || folder.name,
      reportName: partition.reportName,
      modelKey: partition.modelKey ?? null,
      reportKey: partition.reportKey ?? null,
      projectPath: folder.name,
    }), { source: folder.name });
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
