/**
 * `gitContext` has to answer "where does this path sit inside its repository?" when git
 * and Node disagree about how to spell the path.
 *
 * That disagreement is not exotic. A GitHub Actions Windows runner hands out its temp
 * directory as an 8.3 short name (`RUNNER~1`), so the first CI run of the Windows matrix
 * failed all four `diff` cases with "No project files found" — the prefix had come out as
 * `../LENZ_S~1` rather than ''. Junctions, `subst` drives and symlinked checkouts produce
 * the same mismatch on any platform.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync, execSync } from 'child_process';
import { gitContext } from '../src/readProject.js';

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
};

const hasGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

/**
 * A second, differently-spelled route to the same directory — the whole point of the
 * test. Returns null when the platform will not give us one, which is a skip rather than
 * a failure: 8.3 name generation can be disabled, and POSIX symlinks can be unavailable.
 */
function alias(dir) {
  try {
    if (process.platform === 'win32') {
      // `%~sI` is the 8.3 name of the loop variable. It has to go through cmd as one
      // string — passing it as an argv array lets Node's quoting mangle the pattern.
      const short = execSync(`for /d %I in ("${dir}") do @echo %~sI`, { encoding: 'utf-8' }).trim();
      return short && short.toLowerCase() !== dir.toLowerCase() ? short : null;
    }
    const link = `${dir}-link`;
    symlinkSync(dir, link);
    return link;
  } catch {
    return null;
  }
}

let repo;
let sameRepoSpeltDifferently;

beforeAll(() => {
  if (!hasGit) return;

  // A long name, so Windows has something to shorten.
  repo = mkdtempSync(join(tmpdir(), 'lenz-git-context-long-directory-'));
  mkdirSync(join(repo, 'Shop.SemanticModel'), { recursive: true });
  writeFileSync(join(repo, 'Shop.SemanticModel/model.tmdl'), 'model Model\n');

  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'ignore', env: GIT_ENV });
  git('init', '-q');
  git('add', '-A');
  git('commit', '-qm', 'initial');

  sameRepoSpeltDifferently = alias(repo);
});

afterAll(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
  if (sameRepoSpeltDifferently && process.platform !== 'win32') {
    rmSync(sameRepoSpeltDifferently, { recursive: false, force: true });
  }
});

describe.skipIf(!hasGit)('gitContext', () => {
  it('reports no prefix at the repository root', () => {
    expect(gitContext(repo).prefix).toBe('');
  });

  it('reports the subdirectory as the prefix', () => {
    expect(gitContext(join(repo, 'Shop.SemanticModel')).prefix).toBe('Shop.SemanticModel/');
  });

  it('returns null outside a repository', () => {
    expect(gitContext(tmpdir())).toBeNull();
  });

  it('gives the same answer when the path is spelt the other way', () => {
    if (!sameRepoSpeltDifferently) return; // 8.3 names disabled, or no symlink permission.

    // Subtracting `resolve(path)` from `git rev-parse --show-toplevel` gets this wrong:
    // the two strings share no common prefix, so the result climbs out of the repo.
    expect(gitContext(sameRepoSpeltDifferently).prefix).toBe('');
    expect(gitContext(join(sameRepoSpeltDifferently, 'Shop.SemanticModel')).prefix)
      .toBe('Shop.SemanticModel/');
  });
});
