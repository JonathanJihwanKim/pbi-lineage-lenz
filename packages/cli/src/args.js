/**
 * Argument parsing, kept pure so the awkward cases are testable.
 *
 * Node's own `parseArgs` would do most of this, but it throws on an unknown flag with a
 * message written for a Node developer. A typo in CI should say what was typed and what
 * was meant, not raise. So the parser collects problems and returns them, and the command
 * layer decides what is fatal.
 */

/** Option table: canonical name → {alias, kind, describe}. */
export const OPTIONS = {
  out: { alias: 'o', kind: 'value', describe: 'Where to write the output file' },
  format: { alias: 'f', kind: 'value', describe: 'md | json | html' },
  'min-coverage': { kind: 'value', describe: 'Fail below this % of columns resolved to a physical source' },
  'fail-on': { kind: 'value', describe: 'Comma-separated: broken, unused, coverage, dead-visuals' },
  json: { kind: 'boolean', describe: 'Machine-readable output' },
  quiet: { alias: 'q', kind: 'boolean', describe: 'Only print problems' },
  help: { alias: 'h', kind: 'boolean', describe: 'Show usage' },
  version: { alias: 'v', kind: 'boolean', describe: 'Show version' },
};

const BY_ALIAS = new Map(
  Object.entries(OPTIONS).filter(([, spec]) => spec.alias).map(([name, spec]) => [spec.alias, name]),
);

/**
 * Parse an argv tail (everything after `node cli.js`).
 *
 * @param {string[]} argv
 * @returns {{command: string|null, positionals: string[], options: object, problems: string[]}}
 */
export function parseArgs(argv) {
  const positionals = [];
  const options = {};
  const problems = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }

    if (!arg.startsWith('-') || arg === '-') {
      positionals.push(arg);
      continue;
    }

    // `--name=value` and `--name value` are both common enough that supporting only one
    // guarantees somebody's CI script fails on the other.
    const isLong = arg.startsWith('--');
    const body = isLong ? arg.slice(2) : arg.slice(1);
    const eq = body.indexOf('=');
    const rawName = eq === -1 ? body : body.slice(0, eq);
    const inlineValue = eq === -1 ? null : body.slice(eq + 1);

    const name = isLong ? rawName : BY_ALIAS.get(rawName) ?? rawName;
    const spec = OPTIONS[name];

    if (!spec) {
      problems.push(`Unknown option "${arg}"${suggest(name)}`);
      // Skip a value that plainly belongs to the unknown flag, so it does not land in
      // positionals and get mistaken for a path.
      if (inlineValue === null && argv[i + 1] && !argv[i + 1].startsWith('-')) i++;
      continue;
    }

    if (spec.kind === 'boolean') {
      if (inlineValue !== null) options[name] = inlineValue !== 'false';
      else options[name] = true;
      continue;
    }

    const value = inlineValue ?? argv[++i];
    if (value === undefined || value.startsWith('-')) {
      problems.push(`Option "--${name}" needs a value`);
      continue;
    }
    options[name] = value;
  }

  const [command = null, ...rest] = positionals;
  return { command, positionals: rest, options, problems };
}

/** "Did you mean" for a near-miss, by edit distance of 1–2. */
function suggest(name) {
  const candidates = Object.keys(OPTIONS).filter((option) => distance(option, name) <= 2);
  return candidates.length > 0 ? ` — did you mean "--${candidates[0]}"?` : '';
}

/** Levenshtein distance, iterative, small inputs only. */
function distance(a, b) {
  const rows = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let previous = rows[0];
    rows[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const current = rows[j];
      rows[j] = Math.min(
        rows[j] + 1,
        rows[j - 1] + 1,
        previous + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      previous = current;
    }
  }
  return rows[b.length];
}

/**
 * Read a percentage option.
 * Accepts `80` and `0.8`, because both get typed and silently meaning different
 * thresholds would be worse than accepting both.
 *
 * @returns {number|null} A fraction in 0..1, or null when absent/unreadable.
 */
export function parsePercent(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const value = Number(String(raw).replace('%', ''));
  if (!Number.isFinite(value) || value < 0) return null;
  if (value > 1) return value > 100 ? null : value / 100;
  return value;
}

/** Split a comma list into a lowercase set, ignoring blanks. */
export function parseList(raw) {
  if (!raw) return new Set();
  return new Set(String(raw).split(',').map((part) => part.trim().toLowerCase()).filter(Boolean));
}
