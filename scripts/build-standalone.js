/**
 * Build the one tarball a user installs from a GitHub release.
 *
 * The registry is not the only way to hand someone a CLI, and for this project it stopped
 * being a good one: publishing to npm needs an account on a site that can lock you out of
 * your own release, which is a strange dependency for a tool whose source is right here.
 * A GitHub release needs nothing but the credentials git already has.
 *
 * **Why this stages a directory instead of bundling to one file.** `handoff` is not static.
 * `packages/handoff/src/assets.js` reads `viewer.css` off disk and runs esbuild *at runtime*
 * over `entry.js` and the whole viewer source tree, because the handoff file embeds a fresh
 * build of the viewer. Flatten the CLI into a single file and that command breaks — not at
 * build time, where it would be noticed, but on a user's machine the first time they ask for
 * a handoff. So the artifact keeps the real package layout.
 *
 * `bundleDependencies` is what makes that shippable: npm strips `node_modules` from a pack
 * *except* for the dependencies named there, which is exactly the "vendor my own packages"
 * case. The four internal packages travel inside the tarball; only `esbuild` is fetched from
 * the registry, which is an anonymous read and needs no account. It cannot be vendored
 * anyway — it installs a platform-specific native binary.
 *
 * Usage: `node scripts/build-standalone.js [--out <dir>]`. Prints the tarball path on the
 * last line of stdout, for CI to upload.
 */

import { execFileSync } from 'child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STAGE = join(ROOT, 'build', 'standalone');

/** The four packages that travel inside the tarball, and the one that becomes the CLI. */
const BUNDLED = ['core', 'viewer', 'export', 'handoff'];

/**
 * npm's own entry script, run through this node. Spawning `npm.cmd` instead would fail on
 * Windows — Node refuses to execute `.cmd` without a shell, and a shell would then need the
 * paths quoted by hand, which this repo's own folder (it has a space in it) breaks.
 */
const NPM_CLI = [
  join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
  join(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'),
].find(existsSync);

const npm = (args) => execFileSync(process.execPath, [NPM_CLI, ...args], {
  encoding: 'utf-8',
  stdio: ['ignore', 'pipe', 'inherit'],
});

const manifest = (pkg) => JSON.parse(readFileSync(join(ROOT, 'packages', pkg, 'package.json'), 'utf-8'));

function outDir() {
  const flag = process.argv.indexOf('--out');
  return flag === -1 ? join(ROOT, 'build') : resolve(process.argv[flag + 1]);
}

/**
 * Copy a workspace package to where npm expects a bundled dependency to sit.
 *
 * Only what the package's own `files` list declares, plus its manifest — the same set a
 * published package would carry, so the tarball cannot pick up a stray fixture or an editor
 * backup that happened to be in the folder.
 */
function vendor(pkg) {
  const { name, files = ['src/'] } = manifest(pkg);
  const from = join(ROOT, 'packages', pkg);
  const target = join(STAGE, 'node_modules', ...name.split('/'));
  mkdirSync(target, { recursive: true });

  for (const entry of [...files, 'package.json']) {
    const source = join(from, entry);
    if (existsSync(source)) cpSync(source, join(target, entry), { recursive: true });
  }
  return name;
}

console.log('Staging', STAGE);
rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });

const cli = manifest('cli');
const bundled = BUNDLED.map(vendor);

// The CLI's own source sits at the root of the tarball, exactly as it does in its package.
for (const entry of cli.files ?? ['src/']) {
  const from = join(ROOT, 'packages', 'cli', entry);
  if (existsSync(from)) cpSync(from, join(STAGE, entry), { recursive: true });
}
for (const file of ['README.md', 'LICENSE']) {
  if (existsSync(join(ROOT, file))) cpSync(join(ROOT, file), join(STAGE, file));
}

writeFileSync(join(STAGE, 'package.json'), `${JSON.stringify({
  name: cli.name,
  version: cli.version,
  description: cli.description,
  type: cli.type,
  bin: cli.bin,
  exports: cli.exports,
  engines: cli.engines,
  // The four internal packages have to appear here as well as in `bundleDependencies` —
  // npm bundles a dependency, not an arbitrary folder, and silently ignores a bundled name
  // it cannot find in `dependencies`. Pinned exactly, so that if the bundled copy ever went
  // missing npm would fail trying to fetch a version the registry does not have, rather than
  // quietly installing an older one.
  dependencies: {
    ...Object.fromEntries(bundled.map((name) => [name, cli.version])),
    esbuild: manifest('handoff').dependencies.esbuild,
  },
  bundleDependencies: bundled,
  keywords: cli.keywords,
  license: cli.license,
  author: cli.author,
  repository: cli.repository,
  homepage: cli.homepage,
}, null, 2)}\n`);

const destination = outDir();
mkdirSync(destination, { recursive: true });

// A pack that quietly lost the vendored packages still succeeds and still looks right; it
// fails later, on a user's machine. So ask npm what it is about to include and check the
// files that prove the layout survived — the stylesheet handoff reads from disk, and the
// entry point it hands to esbuild — before anything is written.
const [planned] = JSON.parse(npm(['pack', STAGE, '--dry-run', '--json']));
const included = new Set(planned.files.map((file) => file.path.replace(/\\/g, '/')));
const required = [
  'node_modules/@pbi-lineage-lenz/viewer/src/viewer.css',
  'node_modules/@pbi-lineage-lenz/handoff/src/entry.js',
  'src/bin.js',
];
const missing = required.filter((path) => !included.has(path));
if (missing.length > 0) {
  console.error(`The tarball would be missing:\n  ${missing.join('\n  ')}`);
  process.exit(1);
}

const name = npm(['pack', STAGE, '--pack-destination', destination, '--silent'])
  .trim()
  .split(/\r?\n/)
  .pop();

console.log(`${included.size} files, ${bundled.length} packages vendored`);
console.log(join(destination, name));
