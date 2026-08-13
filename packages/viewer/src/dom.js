/**
 * Minimal DOM helpers.
 *
 * Deliberately not a framework: this code ships inside every handoff file, so the
 * dependency budget is zero. `h()` covers the whole viewer.
 */

/**
 * Build an element.
 * @param {string} tag - Tag name, optionally with `.class` and `#id` suffixes: `div.panel`.
 * @param {object|Array|string|Node} [props] - Attributes, or children if not a plain object.
 * @param {...(Array|string|Node|null|false)} children
 * @returns {HTMLElement}
 */
export function h(tag, props, ...children) {
  const [, name, rest] = /^([a-zA-Z0-9-]+)(.*)$/.exec(tag);
  const el = document.createElement(name);

  for (const token of rest.match(/[.#][^.#]+/g) || []) {
    if (token[0] === '.') el.classList.add(token.slice(1));
    else el.id = token.slice(1);
  }

  const isProps = props && typeof props === 'object' && !Array.isArray(props) && !(props instanceof Node);
  if (isProps) {
    for (const [key, value] of Object.entries(props)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') el.classList.add(...String(value).split(/\s+/).filter(Boolean));
      else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
      else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
      else if (key === 'text') el.textContent = value;
      else if (key === 'html') el.innerHTML = value;
      else el.setAttribute(key, value === true ? '' : String(value));
    }
  } else if (props !== undefined) {
    children.unshift(props);
  }

  append(el, children);
  return el;
}

/** Append children, flattening arrays and skipping nullish entries. */
export function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false || child === '') continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

/** Replace an element's children. */
export function replace(el, ...children) {
  el.replaceChildren();
  return append(el, children);
}

/** Escape text for safe insertion into an HTML string. */
export function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Build a `<span>` per SVG-safe element.
 * @param {string} tag
 * @param {object} [attrs]
 * @param {...any} children
 */
export function svg(tag, attrs = {}, ...children) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else el.setAttribute(key, String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

/** Debounce a function by `ms`. */
export function debounce(fn, ms = 120) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

/** Copy text to the clipboard, falling back for pages without the async API. */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // A handoff file opened from disk may not have clipboard permission.
    const area = document.createElement('textarea');
    area.value = text;
    area.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
    document.body.append(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    area.remove();
    return ok;
  }
}
