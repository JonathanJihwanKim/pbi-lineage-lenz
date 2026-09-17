import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** This package's version, read from its own package.json. */
export function version() {
  try {
    return JSON.parse(readFileSync(join(HERE, '../package.json'), 'utf-8')).version;
  } catch {
    return '0.0.0';
  }
}
