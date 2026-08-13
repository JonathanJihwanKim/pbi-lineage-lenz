/**
 * Handoff document template — isomorphic.
 *
 * The CLI builds a handoff file in Node; the web app builds the identical file in the
 * browser, where `readFileSync` and esbuild do not exist. So the assembly step is kept
 * pure: hand it a stylesheet, a bundled script, and a viewer model, and it returns the
 * document. Where those two strings came from is somebody else's problem.
 *
 * Keeping this in one place matters more than the few lines it saves. Two copies of the
 * escaping rules below is two chances to get them subtly different, and a handoff file
 * produced by the web app that differs from one produced by CI is a bug nobody would
 * think to look for.
 */

/** Warn above this; a file this size is awkward to forward. */
export const SIZE_WARN_BYTES = 2 * 1024 * 1024;
/** Refuse above this rather than emit something unusable. */
export const SIZE_FAIL_BYTES = 8 * 1024 * 1024;

/**
 * Escape a JSON payload for safe embedding in a `<script type="application/json">` block.
 *
 * Each replacement must emit the six-character sequence <, not the character it
 * denotes. Writing the replacement as '<' in source is a silent no-op:
 * JavaScript resolves the escape at parse time, so the code becomes .replace(/</g, '<')
 * and the payload keeps its raw angle brackets. A model string containing </script then
 * closes the block early and the rest of the payload is parsed as markup. Building the
 * sequence from an explicit backslash makes that mistake impossible to reintroduce.
 */
const BACKSLASH = String.fromCharCode(92);

export function embedJson(value) {
  return JSON.stringify(value)
    // `</script` would close the block early; `<!--` opens an HTML comment.
    .replace(/</g, `${BACKSLASH}u003c`)
    .replace(/>/g, `${BACKSLASH}u003e`)
    // U+2028/U+2029 are legal in JSON strings but are line terminators in JS source.
    .replace(new RegExp(String.fromCharCode(0x2028), 'g'), `${BACKSLASH}u2028`)
    .replace(new RegExp(String.fromCharCode(0x2029), 'g'), `${BACKSLASH}u2029`);
}

export function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** One line a reader can judge the file by before opening anything. */
export function summarize(model) {
  const tables = model.tables?.length ?? 0;
  const columns = model.columns?.length ?? 0;
  const coverage = model.stats?.confidence?.coverage;
  return coverage == null
    ? `${tables} tables · ${columns} columns`
    : `${tables} tables · ${columns} columns · ${Math.round(coverage * 100)}% of source-backed columns traced`;
}

/** UTF-8 size of a string. `Buffer` is Node-only; `TextEncoder` is everywhere. */
export function byteLength(text) {
  return new TextEncoder().encode(text).length;
}

export function megabytes(bytes) {
  return (bytes / 1024 / 1024).toFixed(2);
}

/**
 * Size verdict for a built file.
 * @returns {{bytes: number, level: 'ok'|'warn'|'fail', message: string|null}}
 */
export function sizeVerdict(bytes) {
  if (bytes > SIZE_FAIL_BYTES) {
    return {
      bytes,
      level: 'fail',
      message: `Handoff file is ${megabytes(bytes)} MB, above the ${megabytes(SIZE_FAIL_BYTES)} MB limit.`,
    };
  }
  if (bytes > SIZE_WARN_BYTES) {
    return {
      bytes,
      level: 'warn',
      message: `Handoff file is ${megabytes(bytes)} MB, above the ${megabytes(SIZE_WARN_BYTES)} MB target.`,
    };
  }
  return { bytes, level: 'ok', message: null };
}

/** A filename that says what it holds and when — handoff files get forwarded and kept. */
export function handoffFileName(model) {
  const name = (model.meta?.modelName || 'model')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'model';
  const day = (model.meta?.generatedAt || new Date().toISOString()).slice(0, 10);
  return `${name}-handoff-${day}.html`;
}

/**
 * Assemble the handoff document.
 *
 * @param {object} options
 * @param {object} options.model - Viewer model from toViewerModel().
 * @param {string} options.css - The viewer stylesheet, inlined.
 * @param {string} options.js - The viewer bundle as a single IIFE, inlined.
 * @param {string} [options.title]
 * @returns {string} A complete HTML document that fetches nothing.
 */
export function renderHandoff({ model, css, js, title }) {
  const name = model.meta?.modelName || 'Power BI model';
  const documentTitle = title || `${name} — PBI Lineage Lenz`;
  const summary = summarize(model);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(documentTitle)}</title>
<meta name="description" content="${escapeHtml(summary)}">
<meta name="generator" content="PBI Lineage Lenz">
<meta name="robots" content="noindex">
<style>${css}</style>
</head>
<body class="lenz">
<div id="lenz-root">
  <noscript>
    <div style="padding:40px;font-family:monospace;color:#93a6b8;background:#0b0f14">
      <b style="color:#e3ecf4">This handoff file needs JavaScript.</b><br><br>
      The model is embedded in this file and nothing is fetched from the network —
      but the viewer needs scripting to render it.
    </div>
  </noscript>
</div>

<footer class="lenz-footer">
  <span>${escapeHtml(summary)}</span>
  <span style="flex:1"></span>
  <span>Nothing in this file is fetched from the network.</span>
  <span>Made with <a href="https://github.com/JonathanJihwanKim/pbi-lineage-lenz" target="_blank" rel="noopener">PBI Lineage Lenz</a></span>
</footer>

<script type="application/json" id="lenz-payload">${embedJson(model)}</script>
<script>${js}</script>
</body>
</html>
`;
}

/**
 * Read the model back out of a handoff file.
 *
 * This is what lets a Firefox or Safari user open a colleague's handoff file in the web
 * app rather than being told their browser is unsupported. The producing side needs
 * Chrome; the reading side needs nothing, and that has to include the web app itself.
 *
 * Parsed as text rather than by injecting the document: the payload is JSON in a script
 * block, and running an untrusted colleague's file to get at it would be an odd way to
 * repay the trust involved in forwarding it.
 *
 * @param {string} html - Contents of a handoff file.
 * @returns {object} The viewer model.
 * @throws {Error} When the file holds no readable payload.
 */
export function extractPayload(html) {
  const match = /<script[^>]*id=["']lenz-payload["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (!match) {
    throw new Error('No handoff payload found — is this a file exported by PBI Lineage Lenz?');
  }

  let model;
  try {
    model = JSON.parse(match[1]);
  } catch (cause) {
    throw new Error('The handoff payload is not readable JSON — ask for a freshly generated copy.', { cause });
  }

  if (!model || !Array.isArray(model.tables)) {
    throw new Error('The handoff payload is missing its model — ask for a freshly generated copy.');
  }
  return model;
}
