/**
 * Getting a project into a Map — from disk, or from a git ref.
 *
 * The git side shells out to `git` rather than taking on `isomorphic-git`. Every place
 * this command runs — a developer's machine, a GitHub Action — already has git installed,
 * and a dependency that reimplements it would be a large amount of code to carry for a
 * single subcommand. The browser is the case that genuinely needs a JS implementation,
 * and the browser does not run this file.
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { execFileSync } from 'child_process';
import { shouldRead, partitionPbip, describeProblem, describeChoice } from '@pbi-lineage-lenz/core';

/**
 * Read a project folder, skipping everything the parsers have no use for.
 * @param {string} root
 * @returns {Map<string, string>} Slash-separated relative paths to contents.
 */
export function readProjectFolder(root) {
  const files = new Map();

  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const relative = prefix ? `${prefix}/${entry}` : entry;

      let stats;
      try {
        stats = statSync(full);
      } catch {
        // A broken symlink or a file deleted mid-walk is not worth aborting a build for.
        continue;
      }

      if (stats.isDirectory()) {
        if (shouldRead(`${relative}/probe.tmdl`)) walk(full, relative);
        continue;
      }
      if (shouldRead(relative)) files.set(relative, readFileSync(full, 'utf-8'));
    }
  };

  walk(resolve(root), '');
  return files;
}

/**
 * Read a project as it existed at a git ref.
 *
 * @param {string} ref - Any revision git understands: a branch, a tag, `HEAD~1`, a SHA.
 * @param {string} [cwd] - Repository directory.
 * @param {string} [subdir] - Limit to a subdirectory of the repo.
 * @returns {Map<string, string>}
 */
export function readProjectAtRef(ref, cwd = process.cwd(), subdir = '') {
  const prefix = subdir ? `${subdir.replace(/\\/g, '/').replace(/\/$/, '')}/` : '';
  const listing = git(['ls-tree', '-r', '--name-only', '-z', ref, '--', prefix || '.'], cwd);

  const files = new Map();
  for (const path of listing.split('\0')) {
    if (!path) continue;
    const relative = prefix && path.startsWith(prefix) ? path.slice(prefix.length) : path;
    if (!shouldRead(relative)) continue;
    files.set(relative, git(['show', `${ref}:${path}`], cwd));
  }
  return files;
}

/**
 * Locate the repository containing a path, and where the path sits inside it.
 *
 * Taking the repository from the target path rather than the current directory is what
 * makes `diff main..HEAD ./reports/Sales` work from anywhere — including from a
 * monorepo root that is not itself the project, which is the normal case in CI.
 *
 * @param {string} path
 * @returns {{root: string, prefix: string}|null} null when the path is not in a repo.
 */
export function gitContext(path) {
  const start = resolve(path);
  try {
    // Ask git for both halves rather than subtracting one path string from the other.
    // The two spell the same directory differently — git answers with forward slashes and
    // the long form of every name, Node answers with whatever it was given. On a GitHub
    // Actions Windows runner the temp directory arrives as an 8.3 short name, so
    // `relative('C:/…/lenz_shortname_repro_directory', 'C:\…\LENZ_S~1')` returned
    // `../LENZ_S~1` instead of ''. That prefix matched nothing in `ls-tree`, and every
    // `diff` under such a path failed with "No project files found". Junctions, `subst`
    // drives and symlinked checkouts all produce the same mismatch.
    const root = git(['rev-parse', '--show-toplevel'], start).trim();
    const prefix = git(['rev-parse', '--show-prefix'], start).trim();
    return { root, prefix };
  } catch {
    return null;
  }
}

/** Resolve a ref to a short SHA, so the output says what was actually compared. */
export function describeRef(ref, cwd = process.cwd()) {
  try {
    return `${ref} (${git(['rev-parse', '--short', ref], cwd).trim()})`;
  } catch {
    return ref;
  }
}

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    // A large repo's ls-tree and a big TMDL file both exceed the 1 MB default.
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * Read a path and split it into the model and report halves, or explain why not.
 *
 * @param {string} path
 * @returns {{partition: object, files: Map, note: string|null}}
 *   `note` is a line worth showing the user before the results — currently only that a
 *   folder held several reports and one was chosen.
 * @throws {Error} With a message written for whoever typed the path.
 */
export function loadProject(path) {
  const root = resolve(path);
  if (!existsSync(root)) throw new Error(`No such folder: ${path}`);
  if (!statSync(root).isDirectory()) {
    throw new Error(`${path} is a file. Point at the folder that holds your .SemanticModel folder.`);
  }

  const files = readProjectFolder(root);
  const partition = partitionPbip(files);

  const problem = describeProblem(partition);
  if (problem) throw new Error(problem);

  return { partition, files, note: describeChoice(partition) };
}
