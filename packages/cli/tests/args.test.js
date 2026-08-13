/**
 * Argument parsing.
 *
 * The cases that matter are the ones a CI script hits at 3am: a flag written the other
 * way round, a typo, a missing value. None of them should raise a stack trace at
 * somebody, and none should silently do the wrong thing.
 */

import { describe, it, expect } from 'vitest';
import { parseArgs, parsePercent, parseList } from '../src/args.js';

describe('parseArgs', () => {
  it('reads a command and a path', () => {
    const { command, positionals, problems } = parseArgs(['handoff', './MyReport']);
    expect(command).toBe('handoff');
    expect(positionals).toEqual(['./MyReport']);
    expect(problems).toEqual([]);
  });

  it('accepts both --name value and --name=value', () => {
    expect(parseArgs(['docs', '.', '--out', 'a.md']).options.out).toBe('a.md');
    expect(parseArgs(['docs', '.', '--out=a.md']).options.out).toBe('a.md');
  });

  it('accepts short aliases', () => {
    const { options } = parseArgs(['docs', '.', '-o', 'a.md', '-f', 'json', '-q']);
    expect(options).toMatchObject({ out: 'a.md', format: 'json', quiet: true });
  });

  it('reports a missing value instead of swallowing the next flag', () => {
    // `--out --json` would otherwise set out to "--json" and write a file with that name.
    const { options, problems } = parseArgs(['docs', '.', '--out', '--json']);
    expect(problems).toEqual(['Option "--out" needs a value']);
    expect(options.out).toBeUndefined();
  });

  it('suggests the intended flag for a typo', () => {
    const { problems } = parseArgs(['check', '.', '--min-coverag', '70']);
    expect(problems[0]).toContain('did you mean "--min-coverage"');
  });

  it('does not leave an unknown flag\'s value looking like a path', () => {
    const { positionals } = parseArgs(['check', '.', '--nope', 'value']);
    expect(positionals).toEqual(['.']);
  });

  it('passes everything after -- through as positionals', () => {
    expect(parseArgs(['diff', '--', '--weird-branch']).positionals).toEqual(['--weird-branch']);
  });

  it('treats a bare command as no options rather than an error', () => {
    expect(parseArgs([])).toMatchObject({ command: null, problems: [] });
  });
});

describe('parsePercent', () => {
  it('accepts a whole number, a fraction, and a percent sign', () => {
    // All three get typed, and quietly meaning different thresholds would be worse than
    // accepting all of them.
    expect(parsePercent('70')).toBeCloseTo(0.7);
    expect(parsePercent('0.7')).toBeCloseTo(0.7);
    expect(parsePercent('70%')).toBeCloseTo(0.7);
  });

  it('rejects nonsense rather than defaulting to zero', () => {
    // Silently reading "high" as 0 would pass every build.
    expect(parsePercent('high')).toBeNull();
    expect(parsePercent('101')).toBeNull();
    expect(parsePercent('-1')).toBeNull();
  });

  it('returns null when absent', () => {
    expect(parsePercent(undefined)).toBeNull();
  });
});

describe('parseList', () => {
  it('splits and normalizes', () => {
    expect([...parseList('broken, Unused ,')]).toEqual(['broken', 'unused']);
  });

  it('is empty for nothing', () => {
    expect(parseList(undefined).size).toBe(0);
  });
});
