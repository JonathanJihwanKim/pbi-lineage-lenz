/**
 * `diff` — what changed about the model between two git refs.
 *
 * A TMDL diff in a pull request shows which lines moved. This shows what it means: a
 * measure's DAX changed, and here are the visuals that show it. That second half is the
 * reason a reviewer can approve the change without opening Power BI.
 */

import { analyzeFromFiles, detectChanges, partitionPbip } from '@pbi-lineage-lenz/core';
import { readProjectAtRef, readProjectFolder, gitContext, describeRef } from '../readProject.js';
import { out, heading, ok, style } from '../report.js';

export const usage = `
${style.bold('pbi-lineage-lenz diff')} <before>..<after> [path] [options]

  Compare a PBIP project between two git refs and describe what changed about the
  model — not which lines moved.

  ${style.dim('<before>..<after>')}   Any refs git understands: main..HEAD, v1..v2, a SHA
  ${style.dim('[path]')}              Project subdirectory, when the repo holds more than one
  ${style.dim('--json')}              Machine-readable changes

  Use ${style.dim('WORKTREE')} as a ref to mean the files on disk right now:
  ${style.dim('pbi-lineage-lenz diff main..WORKTREE')}
`;

/** The ref that means "what is on disk", so uncommitted work can be reviewed. */
const WORKTREE = 'WORKTREE';

export function diffCommand({ positionals, options }) {
  const [range, path = '.'] = positionals;

  if (!range || !range.includes('..')) {
    throw new Error('Give a range like `main..HEAD`. Run `pbi-lineage-lenz diff --help` for examples.');
  }

  const repo = gitContext(path);
  if (!repo) {
    throw new Error(`${path} is not inside a git repository — \`diff\` compares git refs.`);
  }

  const [beforeRef, afterRef] = range.split('..');
  if (!beforeRef || !afterRef) throw new Error(`Could not read the range "${range}". Expected <before>..<after>.`);

  const before = readSide(beforeRef, path, repo);
  const after = readSide(afterRef, path, repo);

  if (before.size === 0) throw new Error(`No project files found at "${beforeRef}"${path === '.' ? '' : ` under ${path}`}.`);
  if (after.size === 0) throw new Error(`No project files found at "${afterRef}"${path === '.' ? '' : ` under ${path}`}.`);

  // The graph comes from the *after* side: impact answers "what does this break now",
  // which is a question about the state being proposed, not the one being replaced.
  const partition = partitionPbip(after);
  const analysis = analyzeFromFiles({
    modelFiles: partition.modelFiles,
    reportFiles: partition.reportFiles ?? undefined,
  });

  const { changes, summary } = detectChanges(before, after, analysis.graph);

  if (options.json) {
    out(JSON.stringify({ before: beforeRef, after: afterRef, summary, changes }, null, 2));
    return 0;
  }

  heading(`${describe(beforeRef, repo)} → ${describe(afterRef, repo)}`);

  if (changes.length === 0) {
    out('', ok('Nothing about the model changed.'));
    return 0;
  }

  out('', `${summary.totalChanges} change${summary.totalChanges === 1 ? '' : 's'}`, '');

  // Grouped by scope, because a reviewer reads "what changed in the report" and "what
  // changed in the model" as separate questions.
  const byScope = new Map();
  for (const change of changes) {
    if (!byScope.has(change.scope)) byScope.set(change.scope, []);
    byScope.get(change.scope).push(change);
  }

  for (const [scope, scoped] of byScope) {
    out(style.bold(`  ${scope}`));
    for (const change of scoped) {
      out(`    ${style.dim(change.type.replace(/_/g, ' '))}  ${change.description}`);
      const impact = change.impact ?? [];
      if (impact.length > 0) {
        out(`      ${style.yellow(`affects ${impact.length} downstream object${impact.length === 1 ? '' : 's'}`)}`);
      }
    }
    out('');
  }

  return 0;
}

function readSide(ref, path, repo) {
  return ref === WORKTREE ? readProjectFolder(path) : readProjectAtRef(ref, repo.root, repo.prefix);
}

function describe(ref, repo) {
  return ref === WORKTREE ? 'working tree' : describeRef(ref, repo.root);
}
