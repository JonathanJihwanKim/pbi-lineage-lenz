/**
 * The CLI end to end, through `run()` rather than a spawned process.
 *
 * Exit codes are the contract here: CI reacts to the number, not the text, so a command
 * that prints a failure and exits 0 is worse than one that crashes.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, cpSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { run } from '../src/cli.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SAMPLE = join(__dirname, '../../../samples/sample-pbip');

let workspace;

/** Capture stdout/stderr so assertions can read what a user would see. */
function capture() {
  const chunks = { out: '', err: '' };
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((text) => { chunks.out += text; return true; });
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((text) => { chunks.err += text; return true; });
  return { chunks, restore: () => { outSpy.mockRestore(); errSpy.mockRestore(); } };
}

async function cli(...argv) {
  const { chunks, restore } = capture();
  try {
    const code = await run(argv);
    return { code, ...chunks };
  } finally {
    restore();
  }
}

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), 'lenz-cli-'));
});

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe('usage', () => {
  it('prints help and exits 0 for a bare invocation', async () => {
    // Someone typing the name to find out what it does has not made an error.
    const { code, out } = await cli();
    expect(code).toBe(0);
    expect(out).toContain('handoff');
    expect(out).toContain('check');
  });

  it('exits 2 on an unknown command', async () => {
    const { code, err } = await cli('explode');
    expect(code).toBe(2);
    expect(err).toContain('Unknown command');
  });

  it('exits 2 on an unknown option, without running anything', async () => {
    const { code, err } = await cli('check', SAMPLE, '--nope');
    expect(code).toBe(2);
    expect(err).toContain('Unknown option');
  });

  it('prints a version', async () => {
    const { code, out } = await cli('--version');
    expect(code).toBe(0);
    expect(out.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('handoff', () => {
  it('writes a self-contained file', async () => {
    const target = join(workspace, 'nested/handoff.html');
    const { code } = await cli('handoff', SAMPLE, '-o', target);

    expect(code).toBe(0);
    const html = readFileSync(target, 'utf-8');
    // The whole promise of the artifact, asserted where it is produced.
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/<link[^>]+href=/i);
    expect(html).toContain('id="lenz-payload"');
  });

  it('creates the output directory rather than failing on it', async () => {
    expect(existsSync(join(workspace, 'nested'))).toBe(true);
  });
});

describe('check', () => {
  it('passes a healthy model', async () => {
    const { code, out } = await cli('check', SAMPLE);
    expect(code).toBe(0);
    expect(out).toContain('No broken references');
  });

  it('does not fail on unused measures by default', async () => {
    // The sample deliberately contains `Unused Metric`.
    const { code, out } = await cli('check', SAMPLE);
    expect(out).toMatch(/measure.* no visual shows/);
    expect(code).toBe(0);
  });

  it('fails on them when asked', async () => {
    const { code } = await cli('check', SAMPLE, '--fail-on', 'unused');
    expect(code).toBe(1);
  });

  it('fails when coverage is below the floor', async () => {
    const { code, out } = await cli('check', SAMPLE, '--min-coverage', '99');
    expect(code).toBe(1);
    expect(out).toContain('below the 99% required');
  });

  it('rejects an unreadable threshold instead of treating it as zero', async () => {
    // Reading "high" as 0 would pass every build while looking configured.
    const { code, err } = await cli('check', SAMPLE, '--min-coverage', 'high');
    expect(code).toBe(1);
    expect(err).toContain('must be a percentage');
  });

  it('names the known rules when given an unknown one', async () => {
    const { code, err } = await cli('check', SAMPLE, '--fail-on', 'vibes');
    expect(code).toBe(1);
    expect(err).toContain('Known rules');
  });

  it('emits machine-readable findings with --json', async () => {
    const { code, out } = await cli('check', SAMPLE, '--json');
    const parsed = JSON.parse(out);
    expect(code).toBe(0);
    expect(parsed.exitCode).toBe(0);
    expect(parsed.findings.map((f) => f.rule)).toContain('broken');
  });
});

describe('docs', () => {
  it('writes markdown carrying both vocabularies', async () => {
    const target = join(workspace, 'MODEL.md');
    const { code } = await cli('docs', SAMPLE, '-o', target);
    const markdown = readFileSync(target, 'utf-8');

    expect(code).toBe(0);
    // Falls back to the folder name when the layout carries none. "# sample-pbip" is
    // information; "# Power BI model" is a shrug.
    expect(markdown).toContain('# sample-pbip');
    // The dual name is the reason the tool exists; a data engineer searches for this.
    expect(markdown).toContain('mydb.dbo.fact_sales.sale_amount');
    expect(markdown).toContain('Sales');
  });

  it('writes JSON that round-trips', async () => {
    const target = join(workspace, 'model.json');
    await cli('docs', SAMPLE, '-f', 'json', '-o', target);
    const parsed = JSON.parse(readFileSync(target, 'utf-8'));
    expect(parsed.tables.length).toBeGreaterThan(0);
  });

  it('refuses to print a megabyte of HTML to a terminal', async () => {
    const { code, err } = await cli('docs', SAMPLE, '-f', 'html');
    expect(code).toBe(1);
    expect(err).toContain('--out is required');
  });

  it('rejects an unknown format', async () => {
    const { code, err } = await cli('docs', SAMPLE, '-f', 'pdf');
    expect(code).toBe(1);
    expect(err).toContain('Unknown format');
  });
});

describe('errors a user can act on', () => {
  it('says which folder is missing', async () => {
    const { code, err } = await cli('check', join(workspace, 'nowhere'));
    expect(code).toBe(1);
    expect(err).toContain('No such folder');
  });

  it('explains a folder with no model in it', async () => {
    const empty = join(workspace, 'empty');
    mkdirSync(empty, { recursive: true });
    const { code, err } = await cli('check', empty);
    expect(code).toBe(1);
    expect(err).toContain('.SemanticModel');
  });
});

// ── diff ────────────────────────────────────────────────────────────────────────

const hasGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

// Each case shells out to git several times; on Windows that regularly exceeds the
// 5s default and fails as a timeout rather than as a defect.
describe.skipIf(!hasGit)('diff', { timeout: 30_000 }, () => {
  let repo;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'lenz-repo-'));
    cpSync(SAMPLE, join(repo, 'Shop.SemanticModel'), { recursive: true });

    const git = (...args) => execFileSync('git', args, {
      cwd: repo,
      stdio: 'ignore',
      env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
    });

    git('init', '-q');
    git('add', '-A');
    git('commit', '-qm', 'initial');

    const file = join(repo, 'Shop.SemanticModel/definition/tables/Sales.tmdl');
    writeFileSync(file, readFileSync(file, 'utf-8')
      .replace("measure 'Total Sales' = SUM(Sales[Amount])", "measure 'Total Sales' = SUM(Sales[Amount]) * 1.1"));

    git('add', '-A');
    git('commit', '-qm', 'tweak');
  });

  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it('describes what changed about the model', async () => {
    const { code, out } = await cli('diff', 'HEAD~1..HEAD', repo);
    expect(code).toBe(0);
    expect(out).toContain('Total Sales');
    expect(out).toMatch(/expression changed/i);
  });

  it('works from outside the repository', async () => {
    // The repo is taken from the target path, not the working directory — which is the
    // normal case in CI, where the checkout is a subdirectory.
    expect(process.cwd()).not.toBe(repo);
    const { code } = await cli('diff', 'HEAD~1..HEAD', repo);
    expect(code).toBe(0);
  });

  it('compares a ref against the working tree', async () => {
    const { code, out } = await cli('diff', `HEAD..WORKTREE`, repo);
    expect(code).toBe(0);
    expect(out).toContain('working tree');
  });

  it('reports no changes between a ref and itself', async () => {
    const { code, out } = await cli('diff', 'HEAD..HEAD', repo);
    expect(code).toBe(0);
    expect(out).toContain('Nothing about the model changed');
  });

  it('explains a range it cannot read', async () => {
    const { code, err } = await cli('diff', 'main', repo);
    expect(code).toBe(1);
    expect(err).toContain('main..HEAD');
  });

  it('explains a path outside any repository', async () => {
    const { code, err } = await cli('diff', 'a..b', workspace);
    expect(code).toBe(1);
    expect(err).toContain('not inside a git repository');
  });
});
