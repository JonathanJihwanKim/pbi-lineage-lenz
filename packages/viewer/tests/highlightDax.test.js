/**
 * DAX highlighting.
 *
 * The first implementation parked tokens in numbered placeholders and restored them at the
 * end. The number rule then matched the placeholder indices and rewrote them, so nothing
 * was ever restored and the output contained no highlight spans at all — a failure that is
 * invisible unless something counts the spans. Hence the counting assertions below.
 */
import { describe, it, expect } from 'vitest';
import { highlightDax } from '../src/catalog.js';

const spans = (html, cls) => (html.match(new RegExp(`class="${cls}"`, 'g')) || []).length;

describe('highlightDax', () => {
  it('emits spans at all', () => {
    const html = highlightDax('SUM(Sales[Amount])');
    expect(html).toContain('<span');
  });

  it('marks function calls', () => {
    expect(spans(highlightDax('CALCULATE(SUM(Sales[Amount]))'), 'fn')).toBe(2);
  });

  it('marks keywords', () => {
    const html = highlightDax('VAR x = 1 RETURN x');
    expect(spans(html, 'kw')).toBe(2);
  });

  it('marks column and measure references', () => {
    const html = highlightDax("DIVIDE([Total Sales], 'Date Table'[Year])");
    expect(spans(html, 'ref')).toBe(2);
  });

  it('marks numbers and strings', () => {
    const html = highlightDax('IF(x = 1, "yes", "no")');
    expect(spans(html, 'num')).toBe(1);
    expect(spans(html, 'str')).toBe(2);
  });

  it('marks both comment styles', () => {
    expect(spans(highlightDax('// line\nSUM(a)'), 'cmt')).toBe(1);
    expect(spans(highlightDax('/* block */ SUM(a)'), 'cmt')).toBe(1);
  });

  it('does not tokenise inside a string literal', () => {
    // "SUM(" inside a string is text, not a call.
    const html = highlightDax('x = "SUM(not a call)"');
    expect(spans(html, 'fn')).toBe(0);
    expect(spans(html, 'str')).toBe(1);
  });

  it('does not tokenise inside a comment', () => {
    const html = highlightDax('// CALCULATE(1)\nA');
    expect(spans(html, 'fn')).toBe(0);
  });

  it('treats a keyword before a paren as a keyword, not a function', () => {
    const html = highlightDax('IF ( TRUE, 1, 2 )');
    expect(spans(html, 'kw')).toBeGreaterThanOrEqual(1);
  });

  it('escapes markup so an expression cannot inject HTML', () => {
    // The result is assigned via innerHTML, so this is the security boundary.
    const html = highlightDax('<img src=x onerror=alert(1)>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('escapes markup inside strings and comments too', () => {
    expect(highlightDax('"<b>"')).not.toContain('<b>');
    expect(highlightDax('// <b>')).not.toContain('<b>');
  });

  it('preserves the original text content', () => {
    const source = "CALCULATE([Total], 'D'[Y] = 2024) // note";
    const text = highlightDax(source)
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    expect(text).toBe(source);
  });

  it('returns an empty string for no expression', () => {
    expect(highlightDax('')).toBe('');
    expect(highlightDax(null)).toBe('');
  });

  it('is not affected by a previous call', () => {
    // A module-level regex with /g carries lastIndex between calls unless reset.
    const first = highlightDax('SUM(A[b])');
    const second = highlightDax('SUM(A[b])');
    expect(second).toBe(first);
  });
});
