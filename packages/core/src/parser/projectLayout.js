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
    + 'Point at one report’s folder to choose another.';
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
