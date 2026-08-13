/**
 * Command dispatch.
 *
 * Separate from `bin.js` so the whole surface can be exercised in tests without spawning
 * a process — the exit code is returned rather than set, and every command is a function
 * of its arguments.
 */

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { parseArgs, OPTIONS } from './args.js';
import { out, err, style, fail } from './report.js';
import { handoffCommand, usage as handoffUsage } from './commands/handoff.js';
import { checkCommand, usage as checkUsage } from './commands/check.js';
import { docsCommand, usage as docsUsage } from './commands/docs.js';
import { diffCommand, usage as diffUsage } from './commands/diff.js';

const HERE = dirname(fileURLToPath(import.meta.url));

export const COMMANDS = {
  handoff: { run: handoffCommand, usage: handoffUsage, describe: 'Build a self-contained HTML file for anyone' },
  check: { run: checkCommand, usage: checkUsage, describe: 'Verify the model; exit 1 when something is broken' },
  docs: { run: docsCommand, usage: docsUsage, describe: 'Generate markdown, JSON, or HTML documentation' },
  diff: { run: diffCommand, usage: diffUsage, describe: 'Describe what changed between two git refs' },
};

export function version() {
  try {
    return JSON.parse(readFileSync(join(HERE, '../package.json'), 'utf-8')).version;
  } catch {
    return '0.0.0';
  }
}

function topUsage() {
  const width = Math.max(...Object.keys(COMMANDS).map((name) => name.length));
  const commands = Object.entries(COMMANDS)
    .map(([name, command]) => `  ${style.bold(name.padEnd(width))}  ${command.describe}`)
    .join('\n');

  const options = Object.entries(OPTIONS)
    .map(([name, spec]) => {
      const flag = spec.alias ? `-${spec.alias}, --${name}` : `    --${name}`;
      return `  ${style.dim(flag.padEnd(22))}  ${spec.describe}`;
    })
    .join('\n');

  return `
${style.bold('pbi-lineage-lenz')} — one lens on your Power BI model, for the BI developer and the data engineer.

${style.bold('Usage')}
  npx pbi-lineage-lenz <command> [path] [options]

${style.bold('Commands')}
${commands}

${style.bold('Options')}
${options}

${style.bold('Examples')}
  ${style.dim('npx pbi-lineage-lenz handoff ./MyReport -o handoff.html')}
  ${style.dim('npx pbi-lineage-lenz check ./MyReport --min-coverage 70')}
  ${style.dim('npx pbi-lineage-lenz docs ./MyReport -o MODEL.md')}
  ${style.dim('npx pbi-lineage-lenz diff main..HEAD')}
`;
}

/**
 * Run the CLI.
 * @param {string[]} argv - Everything after the executable and script.
 * @returns {Promise<number>} Exit code.
 */
export async function run(argv) {
  const { command, positionals, options, problems } = parseArgs(argv);

  for (const problem of problems) err(fail(problem));
  if (problems.length > 0) return 2;

  if (options.version) {
    out(version());
    return 0;
  }

  if (!command) {
    out(topUsage());
    // No command is a request for help, not a failure — someone typed the bare name to
    // find out what it does.
    return 0;
  }

  const entry = COMMANDS[command];
  if (!entry) {
    err(fail(`Unknown command "${command}"`), '', topUsage());
    return 2;
  }

  if (options.help) {
    out(entry.usage);
    return 0;
  }

  try {
    return await entry.run({ positionals, options });
  } catch (error) {
    // The message is written for whoever typed the command; the stack is for whoever is
    // debugging the tool, and only they asked for it.
    err(fail(error.message));
    if (process.env.LENZ_DEBUG) err(String(error.stack));
    return 1;
  }
}
