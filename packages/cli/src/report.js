/**
 * Terminal output.
 *
 * Colour is applied only when the stream is a TTY and NO_COLOR is unset — CI logs and
 * piped output get plain text, because escape codes in a build log are noise a reader
 * cannot turn off.
 */

const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

/** ESC, built from its code point so the source carries no invisible control bytes. */
const ESC = String.fromCharCode(27);

const wrap = (code) => (text) => (useColor ? `${ESC}[${code}m${text}${ESC}[0m` : String(text));

export const style = {
  bold: wrap('1'),
  dim: wrap('2'),
  red: wrap('31'),
  green: wrap('32'),
  yellow: wrap('33'),
  blue: wrap('36'),
};

export function out(...lines) {
  for (const line of lines) process.stdout.write(`${line}\n`);
}

export function err(...lines) {
  for (const line of lines) process.stderr.write(`${line}\n`);
}

/** A leading blank line, then a heading. */
export function heading(text) {
  out('', style.bold(text));
}

/** `label  value` with the labels aligned. */
export function rows(pairs, indent = '  ') {
  const width = Math.max(...pairs.map(([label]) => String(label).length));
  for (const [label, value] of pairs) {
    out(`${indent}${style.dim(String(label).padEnd(width))}  ${value}`);
  }
}

export function bytesToMb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/** `4.2s`, or `840ms` when that reads better. */
export function duration(ms) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

export const ok = (text) => `${style.green('✓')} ${text}`;
export const warn = (text) => `${style.yellow('!')} ${text}`;
export const fail = (text) => `${style.red('✗')} ${text}`;
