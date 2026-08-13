/**
 * What the published package actually contains.
 *
 * This exists because of a bug that every other test was structurally incapable of
 * catching. `assets.js` does `await import('esbuild')` to bundle the viewer into a handoff
 * file, and `esbuild` was declared under `devDependencies`. Inside this monorepo it
 * resolves from the hoisted root `node_modules`, so all 533 tests passed and the CLI
 * worked — while `npx pbi-lineage-lenz handoff`, on a clean install, would have failed
 * with `Cannot find module 'esbuild'`.
 *
 * That is the one feature everything else in the project exists to support, and the
 * failure would have reached every user on day one. A test that reads the manifest is a
 * poor substitute for installing the tarball, but it is the part that can run on every
 * commit, and it makes the mistake impossible to repeat by accident.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { builtinModules } from 'module';

const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf-8'));

/** Node's own modules, importable with or without the `node:` prefix. */
const BUILTIN = new Set(builtinModules);

/** Every third-party module specifier imported anywhere in src/. */
function runtimeImports() {
  const found = new Set();
  const files = ['src/build.js', 'src/assets.js', 'src/template.js'];
  for (const file of files) {
    const source = readFileSync(join(packageDir, file), 'utf-8');
    // Static `from '…'` and dynamic `import('…')` alike — the bug was in a dynamic one.
    for (const match of source.matchAll(/(?:from|import)\s*\(?\s*['"]([^'".][^'"]*)['"]/g)) {
      const specifier = match[1];
      if (specifier.startsWith('.')) continue;
      // Scoped and plain package names both reduce to their install name.
      const name = specifier.startsWith('@')
        ? specifier.split('/').slice(0, 2).join('/')
        : specifier.split('/')[0];
      if (BUILTIN.has(name.replace(/^node:/, ''))) continue;
      found.add(name);
    }
  }
  return found;
}

describe('handoff package manifest', () => {
  it('declares every module its source imports as a runtime dependency', () => {
    const declared = new Set(Object.keys(manifest.dependencies ?? {}));
    const missing = [...runtimeImports()].filter((name) => !declared.has(name));

    expect(missing).toEqual([]);
  });

  it('keeps esbuild out of devDependencies specifically', () => {
    // Named on its own because this is the one that shipped broken, and because a future
    // "tidy up the dependencies" pass would otherwise look at a bundler in `dependencies`
    // and reasonably assume it belonged in `devDependencies`.
    expect(manifest.dependencies?.esbuild).toBeTruthy();
    expect(manifest.devDependencies?.esbuild).toBeUndefined();
  });

  it('ships its licence inside the tarball', () => {
    // `files` overrides npm's defaults for everything except a few special names, and a
    // LICENSE that lives only at the repo root is not one of them.
    expect(manifest.files).toContain('LICENSE');
    expect(() => readFileSync(join(packageDir, 'LICENSE'), 'utf-8')).not.toThrow();
  });

  it('points at its source on npm', () => {
    expect(manifest.repository?.url).toMatch(/github\.com\/JonathanJihwanKim\/pbi-lineage-lenz/);
    expect(manifest.repository?.directory).toBe('packages/handoff');
  });

  it('pins its workspace dependency rather than floating', () => {
    // `*` resolves to whatever is latest on npm, which need not be the version the user
    // just installed alongside it.
    expect(manifest.dependencies['@pbi-lineage-lenz/viewer']).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
