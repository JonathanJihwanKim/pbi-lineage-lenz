/**
 * Locating a model inside a folder somebody pointed at.
 *
 * A PBIP project is a convention, not a manifest, and people do not all point at the same
 * level of it. The three things a Power BI developer will plausibly hand over are the
 * project root (holding `X.SemanticModel` and `X.Report`), the `.SemanticModel` folder on
 * its own, and — because it is the folder they were last editing — a bare `definition`
 * folder. All three are accepted rather than answered with "wrong folder".
 *
 * Pure functions over a `Map<path, content>`: no filesystem, no File System Access, no
 * DOM. The web app walks a directory handle and the CLI walks a disk path; both arrive
 * here with the same Map, so the awkward cases are decided in one place and tested
 * without a browser.
 */

import { isRelevantFile, parseSemanticModelReference } from './projectStructure.js';

/** Directories never worth walking into. Cheap to skip, expensive to read. */
const SKIP_DIRS = new Set(['.git', 'node_modules', '.vscode', '.idea', '.pbi', 'cache']);

/** Normalize a path the way the parsers expect: forward slashes, no leading slash. */
export function normalizePath(path) {
  return String(path).replace(/\\/g, '/').replace(/^\.?\//, '');
}

/**
 * Should this path be read at all?
 *
 * A real project folder carries a `.pbi/cache.abf` of tens of megabytes and, if it is
 * under version control, a `.git` directory larger than everything else combined. Reading
 * those in a browser is slow enough to look broken, and in CI it is time spent on bytes
 * no parser will ever look at.
 */
export function shouldRead(path) {
  const parts = normalizePath(path).split('/');
  if (parts.some((part) => SKIP_DIRS.has(part.toLowerCase()))) return false;
  return isRelevantFile(parts[parts.length - 1]);
}

/** Index of the segment ending in `suffix`, or -1. */
function findSegment(parts, suffix) {
  return parts.findIndex((part) => part.toLowerCase().endsWith(suffix));
}

/**
 * Slice a file map down to one subtree, relativized to it.
 * @returns {Map<string, string>}
 */
function subtree(files, prefix) {
  const out = new Map();
  const head = prefix ? `${prefix}/` : '';
  for (const [path, content] of files) {
    if (!head) { out.set(path, content); continue; }
    if (path.startsWith(head)) out.set(path.slice(head.length), content);
  }
  return out;
}

/**
 * Everything below `root`, relativized — preferring its `definition` folder when it has
 * one. The parsers want paths relative to `definition`, since that is what makes
 * `pages/<p>/visuals/<v>/visual.json` recognisable.
 */
function definitionOf(files, root) {
  const withDefinition = subtree(files, root ? `${root}/definition` : 'definition');
  return withDefinition.size > 0 ? withDefinition : subtree(files, root);
}

/** Every distinct folder whose name ends in `suffix`, in the order they appear. */
function rootsEndingIn(paths, suffix) {
  const roots = [];
  const seen = new Set();
  for (const path of paths) {
    const parts = path.split('/');
    const i = findSegment(parts, suffix);
    if (i === -1) continue;
    const root = parts.slice(0, i + 1).join('/');
    if (seen.has(root)) continue;
    seen.add(root);
    roots.push(root);
  }
  return roots;
}

/** Resolve `../Other.SemanticModel` against the folder that named it. */
function resolveRelative(fromRoot, relative) {
  const parts = fromRoot.split('/').filter(Boolean);
  for (const segment of normalizePath(relative).split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') parts.pop();
    else parts.push(segment);
  }
  return parts.join('/');
}

/**
 * Pair each report with the semantic model it actually references.
 *
 * A report states its model in `definition.pbir`, and that is the only reliable link:
 * `contoso_project.Report` points at `directlake_import_composite.SemanticModel`, so no
 * amount of name-matching finds it. Reading the first `.Report` and the first
 * `.SemanticModel` independently — which is what this used to do — pairs report A with
 * model B in any folder holding more than one of each.
 *
 * That is the normal shape of a Fabric workspace synced to git, not an edge case, and the
 * consequence is worse than a wrong label: visuals checked against the wrong model
 * manufacture broken references and unused measures that do not exist.
 *
 * @returns {Array<{reportRoot: string, modelRoot: string, visualCount: number}>}
 */
function pairsFromPbir(files, modelRoots) {
  const models = new Set(modelRoots);
  const pairs = [];

  for (const [path, content] of files) {
    if (!path.toLowerCase().endsWith('definition.pbir')) continue;

    const reportRoot = path.split('/').slice(0, -1).join('/');
    const reference = parseSemanticModelReference(content);
    if (!reference) continue;

    const modelRoot = resolveRelative(reportRoot, reference);
    if (!models.has(modelRoot)) continue;

    // An empty report is never the one somebody meant to open, so the count decides
    // between candidates rather than file order.
    const head = reportRoot ? `${reportRoot}/` : '';
    let visualCount = 0;
    for (const candidate of files.keys()) {
      if (candidate.startsWith(head) && candidate.toLowerCase().endsWith('/visual.json')) visualCount++;
    }
    pairs.push({ reportRoot, modelRoot, visualCount });
  }

  return pairs.sort((a, b) => b.visualCount - a.visualCount);
}

/**
 * Split a picked folder into the model half and the report half.
 *
 * @param {Map<string, string>} files - Path (any separator) to contents.
 * @returns {{modelFiles: Map, reportFiles: Map|null, modelName: string|null,
 *   reportName: string|null, layout: string, pairs: Array<{report: string, model: string,
 *   visualCount: number}>}}
 *   `pairs` lists every report/model pair found, so a caller can say which one it chose
 *   rather than choosing silently.
 */
export function partitionPbip(files) {
  const normalized = new Map();
  for (const [path, content] of files) normalized.set(normalizePath(path), content);

  const paths = [...normalized.keys()];
  const modelRoots = rootsEndingIn(paths, '.semanticmodel');
  const reportRoots = rootsEndingIn(paths, '.report');

  // What the reports themselves say. Beats every heuristic below when it is available.
  const pairs = pairsFromPbir(normalized, modelRoots);
  const chosen = pairs[0] ?? null;

  let modelRoot = chosen?.modelRoot ?? modelRoots[0] ?? null;
  let reportRoot = chosen?.reportRoot ?? reportRoots[0] ?? null;

  // Only one model, and a report that never named it: the pairing is not in doubt.
  if (!chosen && modelRoots.length > 1 && reportRoots.length === 0) modelRoot = modelRoots[0];

  const baseName = (root) => (root ? root.split('/').pop().replace(/\.(SemanticModel|Report)$/i, '') : null);
  const allPairs = pairs.map((pair) => ({
    report: baseName(pair.reportRoot),
    model: baseName(pair.modelRoot),
    visualCount: pair.visualCount,
  }));

  if (modelRoot !== null) {
    const reportFiles = reportRoot !== null ? definitionOf(normalized, reportRoot) : null;
    return {
      modelFiles: definitionOf(normalized, modelRoot),
      reportFiles: reportFiles && reportFiles.size > 0 ? reportFiles : null,
      modelName: baseName(modelRoot),
      reportName: baseName(reportRoot),
      modelKey: keyOf(modelRoot),
      reportKey: reportRoot !== null ? keyOf(reportRoot) : null,
      layout: reportRoot !== null
        ? (allPairs.length > 1 ? 'project-multi' : 'project')
        : 'semantic-model',
      pairs: allPairs,
    };
  }

  // No `.SemanticModel` segment: the folder is either a semantic model folder under
  // another name, or a `definition` folder itself. Both hold TMDL — the difference is
  // only whether it sits one level down.
  const nested = subtree(normalized, 'definition');
  const hasTmdl = (map) => [...map.keys()].some((p) => p.toLowerCase().endsWith('.tmdl'));

  if (nested.size > 0 && hasTmdl(nested)) {
    return {
      modelFiles: nested, reportFiles: null, modelName: null, reportName: null,
      layout: 'definition-parent', pairs: [],
    };
  }
  return {
    modelFiles: normalized,
    reportFiles: null,
    modelName: null,
    reportName: null,
    layout: hasTmdl(normalized) ? 'definition' : 'unknown',
    pairs: [],
  };
}

/**
 * A report's or model's key: its folder path within what was analysed, suffix dropped.
 *
 * The folder is the one identity a PBIR item carries that is both stable across runs and
 * unique within a workspace — two reports can share a display name, never a path.
 */
export function keyOf(root) {
  if (root === null || root === undefined) return null;
  return root.replace(/\.(SemanticModel|Report)$/i, '') || null;
}

/**
 * Every report and every model in a folder, each report paired with the model it names.
 *
 * partitionPbip() answers "which one did you mean?", because a person opening one report
 * wants one report. A workspace-wide question — which reports use this column, which of
 * the five thin reports over this model show this measure — needs all of them, and needs
 * the reports that could not be paired listed rather than skipped: a report whose model
 * is not in the repository is itself something the reader should know.
 *
 * @param {Map<string, string>} files - Path (any separator) to contents.
 * @returns {{
 *   models: Array<{key: string, name: string, root: string, files: Map, reports: string[]}>,
 *   reports: Array<{key: string, name: string, root: string, files: Map, modelKey: string|null,
 *     reference: string|null, visualCount: number, problem: string|null}>
 * }}
 */
export function partitionEstate(files) {
  const normalized = new Map();
  for (const [path, content] of files) normalized.set(normalizePath(path), content);

  const paths = [...normalized.keys()];
  const modelRoots = rootsEndingIn(paths, '.semanticmodel');
  const reportRoots = rootsEndingIn(paths, '.report');
  const known = new Set(modelRoots);
  const baseName = (root) => root.split('/').pop().replace(/\.(SemanticModel|Report)$/i, '');

  const models = modelRoots.map((root) => ({
    key: keyOf(root),
    name: baseName(root),
    root,
    files: definitionOf(normalized, root),
    reports: [],
  }));
  const modelByRoot = new Map(models.map((model) => [model.root, model]));

  const reports = reportRoots.map((root) => {
    const pbir = normalized.get(`${root}/definition.pbir`);
    const head = `${root}/`;
    let visualCount = 0;
    for (const candidate of paths) {
      if (candidate.startsWith(head) && candidate.toLowerCase().endsWith('/visual.json')) visualCount++;
    }

    let modelRoot = null;
    let problem = null;
    // The raw `../X.SemanticModel` the report names, kept rather than folded into `problem`:
    // a caller explaining what went wrong needs the value, not a sentence about it.
    let reference = null;
    if (pbir === undefined) {
      problem = 'No definition.pbir, so the model this report reads is not stated.';
    } else {
      reference = parseSemanticModelReference(pbir);
      if (!reference) {
        problem = /byConnection/i.test(pbir)
          ? 'Connects to a published semantic model (byConnection), which is not in this folder.'
          : 'definition.pbir names no semantic model.';
      } else {
        modelRoot = resolveRelative(root, reference);
        if (!known.has(modelRoot)) {
          problem = `Reads ${reference}, which is not in this folder.`;
          modelRoot = null;
        }
      }
    }

    const report = {
      key: keyOf(root),
      name: baseName(root),
      root,
      files: definitionOf(normalized, root),
      modelKey: modelRoot !== null ? keyOf(modelRoot) : null,
      reference,
      visualCount,
      problem,
    };
    if (modelRoot !== null) modelByRoot.get(modelRoot).reports.push(report.key);
    return report;
  });

  const byKey = (a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  return { models: models.sort(byKey), reports: reports.sort(byKey) };
}

/**
 * Say which report was chosen when the folder held more than one.
 *
 * A Fabric workspace synced to git puts every item in one repository, so a folder with
 * four reports in it is ordinary rather than exotic. Choosing one silently means the
 * numbers on screen belong to a report the reader may not have had in mind, and nothing
 * on screen would say so.
 *
 * @param {object} partition - partitionPbip() output.
 * @returns {string|null} null when there was nothing to choose between.
 */
export function describeChoice(partition) {
  const pairs = partition?.pairs ?? [];
  if (pairs.length < 2) return null;

  const others = pairs.slice(1).map((pair) => pair.report).filter(Boolean).join(', ');
  const shown = partition.reportName ?? pairs[0].report;
  return `This folder holds ${pairs.length} reports. Showing ${shown} `
    + `(${pairs[0].visualCount} visual${pairs[0].visualCount === 1 ? '' : 's'})`
    + `${others ? `; also found ${others}` : ''}. `
    + 'Point at one report’s folder to choose another, or pass --all for every report.';
}

/**
 * Why a folder could not be read, in the words of the person who pointed at it.
 * @returns {string|null} null when the folder is usable.
 */
export function describeProblem(partition) {
  if (partition.layout === 'unknown' || partition.modelFiles.size === 0) {
    return 'No TMDL files here. Point at the folder that holds your .SemanticModel and .Report folders — '
      + 'the one next to your .pbip file.';
  }
  return null;
}

/**
 * Why a folder holding reports and no model is not enough, naming what was picked.
 *
 * A report folder is the one a Power BI developer is most likely to point at, because it
 * is the half they were working in and the only half that states the pairing. But the
 * model it reads is its *sibling*, and a browser folder picker hands over the picked
 * subtree and nothing above it — so the files simply are not there to parse.
 *
 * "No TMDL files here" is true and useless. Naming the folder they picked, the model it
 * asked for, and the one move that fixes it costs three lines and saves the guess.
 *
 * @param {object} estate - partitionEstate() output.
 * @returns {string|null} null when there is nothing to explain.
 */
export function describeReportOnly(estate) {
  const reports = estate?.reports ?? [];
  if (reports.length === 0 || (estate?.models ?? []).length > 0) return null;

  // The biggest report is the one they most plausibly meant, and the only one worth
  // naming: a list of four folders is a worse answer than one example of the shape.
  const [first] = [...reports].sort((a, b) => b.visualCount - a.visualCount);

  if (reports.every((report) => report.reference === null)) {
    return `${first.name}.Report names no semantic model in this folder — it reads a published `
      + 'model, or its definition.pbir is missing. There is nothing here to trace a column back to. '
      + 'Point at a folder that holds a .SemanticModel folder.';
  }

  const wanted = first.reference
    ? first.reference.split('/').filter((part) => part && part !== '..').pop()
    : null;

  return `${first.name}.Report is a report folder. The semantic model it reads`
    + `${wanted ? ` — ${wanted} — ` : ' '}`
    + 'sits beside it, not inside it, and a browser can only read the folder you pick. '
    + 'Pick the folder one level up: the one that holds both.';
}

/**
 * The picked folder is itself a `.Report` folder.
 *
 * Both pickers hand over paths relative to what was picked, with the folder's own name
 * stripped — so pointing at `contoso_project.Report` arrives as `definition.pbir` and
 * `definition/pages/...`, with no `.Report` segment anywhere for a suffix scan to find.
 * This is the single most likely wrong pick there is, and without this check it lands on
 * the generic "no TMDL files" message, which describes none of it.
 *
 * @param {Map<string, string>} files - Already normalized.
 * @param {string|null} name - What the picker called the folder, when it said.
 * @returns {string|null} null when the picked folder is not a report.
 */
function describeRootReport(files, name) {
  const pbir = files.get('definition.pbir');
  if (pbir === undefined) return null;

  const folder = name ? `${name}` : 'This folder';
  const reference = parseSemanticModelReference(pbir);

  if (!reference) {
    return /byConnection/i.test(pbir)
      ? `${folder} is a report folder, and it reads a published semantic model rather than one `
        + 'on disk — so there is no model here to trace a column back to. Point at a folder that '
        + 'holds a .SemanticModel folder.'
      : `${folder} is a report folder, and its definition.pbir names no semantic model. `
        + 'Point at the folder that holds your .SemanticModel folder.';
  }

  const wanted = reference.split('/').filter((part) => part && part !== '..').pop();
  return `${folder} is a report folder. The semantic model it reads — ${wanted} — sits beside it, `
    + 'not inside it, and a browser can only read the folder you pick. '
    + 'Pick the folder one level up: the one that holds both.';
}

/**
 * Which screen a picked folder earns.
 *
 * One folder pick has three honest outcomes, and the caller should not have to work out
 * which by inspecting two different partitions. A workspace with several reports is a
 * question, not a default — choosing one silently and mentioning the rest in a footnote
 * puts numbers on screen that belong to a report the reader may not have had in mind.
 *
 * Only genuinely ambiguous folders divert: one model with one report, a lone
 * `.SemanticModel`, and a bare `definition` folder all keep the path they have always
 * taken through partitionPbip().
 *
 * @param {Map<string, string>} files - Path (any separator) to contents.
 * @param {object} [options]
 * @param {string} [options.name] - What the picker called the folder, used to name it back.
 * @returns {{screen: 'viewer', partition: object}
 *   | {screen: 'chooser', estate: object}
 *   | {screen: 'problem', message: string}}
 */
export function planOpen(files, { name = null } = {}) {
  const normalized = new Map();
  for (const [path, content] of files) normalized.set(normalizePath(path), content);

  const estate = partitionEstate(normalized);

  if (estate.models.length === 0) {
    const rootReport = describeRootReport(normalized, name);
    if (rootReport) return { screen: 'problem', message: rootReport };
    if (estate.reports.length > 0) {
      return { screen: 'problem', message: describeReportOnly(estate) };
    }
  }

  if (estate.models.length >= 1 && (estate.reports.length >= 2 || estate.models.length >= 2)) {
    return { screen: 'chooser', estate };
  }

  const partition = partitionPbip(files);
  const message = describeProblem(partition);
  return message ? { screen: 'problem', message } : { screen: 'viewer', partition };
}
