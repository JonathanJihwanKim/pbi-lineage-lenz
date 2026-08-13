/**
 * Directory traversal, both routes.
 *
 * The handles are faked rather than mocked wholesale: `readDirectoryHandle` touches only
 * four members of the File System Access API, and `readFileList` only two of `File`. Fake
 * objects that implement exactly those are enough to test the parts that can be wrong —
 * pruning, path shape, and the two routes agreeing — without a browser.
 */

import { describe, it, expect } from 'vitest';
import { readDirectoryHandle, readFileList } from '../src/readFolder.js';

/** Build a fake FileSystemDirectoryHandle from a nested object literal. */
function dirHandle(name, tree) {
  return {
    kind: 'directory',
    name,
    async *values() {
      for (const [key, value] of Object.entries(tree)) {
        yield typeof value === 'string'
          ? { kind: 'file', name: key, getFile: async () => ({ text: async () => value }) }
          : dirHandle(key, value);
      }
    },
  };
}

/** Build a fake File as `<input webkitdirectory>` yields it. */
function webkitFile(relativePath, content) {
  return { webkitRelativePath: relativePath, name: relativePath.split('/').pop(), text: async () => content };
}

const PROJECT = {
  'Shop.SemanticModel': {
    definition: {
      'expressions.tmdl': 'expression P = "x"',
      tables: { 'Sales.tmdl': 'table Sales' },
    },
    '.pbi': { 'cache.abf': 'BINARY', 'localSettings.json': '{}' },
  },
  'Shop.Report': {
    definition: { pages: { p1: { 'page.json': '{}' } } },
    StaticResources: { 'logo.png': 'PNG' },
  },
  '.git': { objects: { 'ab.json': '{}' } },
  'README.md': '# Shop',
};

describe('readDirectoryHandle', () => {
  it('reads the whole tree with slash-joined relative paths', async () => {
    const files = await readDirectoryHandle(dirHandle('Shop', PROJECT));
    expect([...files.keys()].sort()).toEqual([
      'Shop.Report/definition/pages/p1/page.json',
      'Shop.SemanticModel/definition/expressions.tmdl',
      'Shop.SemanticModel/definition/tables/Sales.tmdl',
    ]);
    expect(files.get('Shop.SemanticModel/definition/tables/Sales.tmdl')).toBe('table Sales');
  });

  it('never descends into a skipped directory', async () => {
    // Not just "excludes the files": a `.git` or `.pbi/cache.abf` that gets walked at all
    // makes a real project take long enough to look like a hang. The check has to happen
    // before the recursion, not after.
    let opened = 0;
    const counted = {
      kind: 'directory',
      name: 'Shop',
      async *values() {
        yield {
          kind: 'directory',
          name: '.git',
          async *values() { opened += 1; },
        };
        yield { kind: 'file', name: 'Sales.tmdl', getFile: async () => ({ text: async () => 'table Sales' }) };
      },
    };

    const files = await readDirectoryHandle(counted);
    expect(opened).toBe(0);
    expect(files.size).toBe(1);
  });

  it('reports progress as it goes', async () => {
    const counts = [];
    await readDirectoryHandle(dirHandle('Shop', PROJECT), (n) => counts.push(n));
    expect(counts).toEqual([1, 2, 3]);
  });
});

describe('readFileList', () => {
  it('strips the picked folder name so both routes produce the same map', async () => {
    // The FSA route yields paths relative to the picked folder; `webkitRelativePath`
    // includes the folder itself. Everything downstream would need to know which route
    // ran if these disagreed.
    const viaInput = await readFileList([
      webkitFile('Shop/Shop.SemanticModel/definition/tables/Sales.tmdl', 'table Sales'),
      webkitFile('Shop/Shop.SemanticModel/definition/expressions.tmdl', 'expression P = "x"'),
      webkitFile('Shop/Shop.Report/definition/pages/p1/page.json', '{}'),
      webkitFile('Shop/.git/objects/ab.json', '{}'),
      webkitFile('Shop/README.md', '# Shop'),
    ]);
    const viaHandle = await readDirectoryHandle(dirHandle('Shop', PROJECT));

    expect([...viaInput.keys()].sort()).toEqual([...viaHandle.keys()].sort());
  });

  it('handles a flat selection with no folder prefix', async () => {
    const files = await readFileList([webkitFile('Sales.tmdl', 'table Sales')]);
    expect(files.get('Sales.tmdl')).toBe('table Sales');
  });
});
