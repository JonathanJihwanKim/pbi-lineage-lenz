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
const CONTOSO = join(__dirname, '../../../samples/contoso');

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
    // Named from the `.SemanticModel` folder the report's `definition.pbir` points at.
    // "# Sample" is information; "# Power BI model" is a shrug.
    expect(markdown).toContain('# Sample');
    // The dual name is the reason the tool exists; a data engineer searches for this.
    expect(markdown).toContain('mydb.dbo.fact_sales.sale_amount');
    expect(markdown).toContain('Sales');
  });

  it('asks for support once, after the work, and never in a build log', async () => {
    // The ask is allowed to exist because the tool has just done something. It is not
    // allowed to appear next to a failure, to survive `--quiet`, or to show up in CI —
    // a build log is read when something is wrong, by someone who did not choose to run
    // the command and cannot act on it.
    const target = join(workspace, 'SPONSOR.md');
    const previous = process.env.CI;
    delete process.env.CI;
    try {
      const { out } = await cli('docs', SAMPLE, '-o', target);
      expect(out).toContain('sponsors/JonathanJihwanKim');
      // Below the result, never instead of it.
      expect(out.indexOf('sponsors/JonathanJihwanKim')).toBeGreaterThan(out.indexOf(target));

      const quiet = await cli('docs', SAMPLE, '-o', target, '--quiet');
      expect(quiet.out).not.toContain('sponsors/');

      process.env.CI = '1';
      const inCi = await cli('docs', SAMPLE, '-o', target);
      expect(inCi.out).not.toContain('sponsors/');
    } finally {
      if (previous === undefined) delete process.env.CI;
      else process.env.CI = previous;
    }
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

describe('docs — flat export and workspaces', () => {
  it('writes a CSV with the documented header', async () => {
    const target = join(workspace, 'lineage.csv');
    const { code } = await cli('docs', CONTOSO, '-f', 'csv', '-o', target, '--quiet');
    expect(code).toBe(0);
    const [header, first] = readFileSync(target, 'utf-8').split('\r\n');
    expect(header.startsWith('contract_version,report_key,report,model_key,model,')).toBe(true);
    expect(first.startsWith('1,contoso_project,')).toBe(true);
  });

  it('writes NDJSON to stdout, one parseable row per line', async () => {
    const { code, out } = await cli('docs', CONTOSO, '-f', 'ndjson');
    expect(code).toBe(0);
    const rows = out.trim().split('\n').map((line) => JSON.parse(line));
    expect(rows.length).toBeGreaterThan(10);
  });

  it('documents every report in a workspace, with an index', async () => {
    const folder = join(workspace, 'estate');
    const { code } = await cli('docs', CONTOSO, '--all', '-o', folder, '--quiet');
    expect(code).toBe(0);
    const index = readFileSync(join(folder, 'index.md'), 'utf-8');
    expect(index).toContain('[contoso_sales_thin](reports/contoso_sales_thin.md)');
    expect(index).toMatch(/\| sales\[Margin per Order\] \| 2 of 2 \|/);
    expect(existsSync(join(folder, 'reports/contoso_project.md'))).toBe(true);
  });

  it('exports one flat file across every report', async () => {
    const { out } = await cli('docs', CONTOSO, '--all', '-f', 'ndjson', '--page-maps');
    const rows = out.trim().split('\n').map((line) => JSON.parse(line));
    expect(new Set(rows.map((r) => r.report_key))).toEqual(new Set(['contoso_project', 'contoso_sales_thin']));
    expect(rows.filter((r) => r.visual_key).every((r) => r.page_map?.startsWith('data:image/svg+xml;utf8,'))).toBe(true);
  });

  it('asks for a folder rather than printing many markdown files to a terminal', async () => {
    const { code, err } = await cli('docs', CONTOSO, '--all');
    expect(code).toBe(1);
    expect(err).toContain('--out <folder>');
  });
});

describe('impact', () => {
  it('finds what reads a physical column across every report', async () => {
    const { code, out } = await cli('impact', CONTOSO, '--all', '--column', 'dbo.sales.OrderKey', '--format', 'json');
    expect(code).toBe(0);
    const result = JSON.parse(out);
    expect(result.totals.reports).toBe(2);
    expect(result.reports[0].measures.map((m) => m.name)).toContain('Margin per Order');
  });

  it('exits 2 when nothing matches', async () => {
    const { code } = await cli('impact', CONTOSO, '--measure', 'No Such Measure');
    expect(code).toBe(2);
  });

  it('exits 1 with --fail-if-used when something reads the target', async () => {
    const { code, out } = await cli('impact', CONTOSO, '--column', 'sales[OrderKey]', '--fail-if-used');
    expect(code).toBe(1);
    expect(out).toContain('--fail-if-used');
  });

  it('says what to look up when given nothing', async () => {
    const { code, err } = await cli('impact', CONTOSO);
    expect(code).toBe(1);
    expect(err).toContain('--column');
  });
});

describe('check — workspaces and baselines', () => {
  it('checks every report and model in a folder', async () => {
    const { code, out } = await cli('check', CONTOSO, '--all', '--json');
    expect(code).toBe(0);
    const parsed = JSON.parse(out);
    expect(parsed.findings.find((f) => f.rule === 'unresolved').items[0]).toMatch(/^directlake_import_composite: /);
  });

  it('writes a baseline, passes against it, and fails once a recorded finding is fixed', async () => {
    const file = join(workspace, 'baseline/.lenz-baseline.json');
    const written = await cli('check', SAMPLE, '--write-baseline', file, '--fail-on', 'unused');
    expect(written.code).toBe(0);

    // The sample's unused measure fails this gate on its own, and is known debt here.
    const against = await cli('check', SAMPLE, '--baseline', file, '--fail-on', 'unused', '--quiet');
    expect(against.code).toBe(0);
    expect(against.out).toMatch(/\d+ known issues? suppressed/);

    // Record a finding that no longer exists: the file is now over-suppressing.
    const document = JSON.parse(readFileSync(file, 'utf-8'));
    document.findings.unused = [...(document.findings.unused || []), 'unused|measure:Sales[Long Gone]'];
    writeFileSync(file, JSON.stringify(document));
    const stale = await cli('check', SAMPLE, '--baseline', file, '--fail-on', 'unused');
    expect(stale.code).toBe(1);
    expect(stale.out).toContain('--update-baseline');

    const updated = await cli('check', SAMPLE, '--baseline', file, '--fail-on', 'unused', '--update-baseline');
    expect(updated.code).toBe(0);
    expect(JSON.parse(readFileSync(file, 'utf-8')).findings.unused).not.toContain('unused|measure:Sales[Long Gone]');
  });

  it('explains a missing baseline file', async () => {
    const { code, err } = await cli('check', SAMPLE, '--baseline', join(workspace, 'nope.json'));
    expect(code).toBe(1);
    expect(err).toContain('--write-baseline');
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
    // The model half only, renamed — `diff` is asked about a semantic model, and the
    // point of the rename is that it finds one whatever the folder is called.
    cpSync(join(SAMPLE, 'Sample.SemanticModel'), join(repo, 'Shop.SemanticModel'),
      { recursive: true });

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
