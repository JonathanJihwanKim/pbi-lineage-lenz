/**
 * The parsed model as JSON — the contract for anyone building on top of this.
 *
 * The viewer model *is* the export. There is no second, reduced shape to keep in sync,
 * because a shape that only the exporter produces drifts from the one the app renders and
 * then quietly stops matching what the tool shows on screen.
 *
 * `version` travels with it so a consumer can tell whether the shape changed under them.
 */

import { VIEWER_MODEL_VERSION } from '@pbi-lineage-lenz/viewer';

/**
 * Serialise a viewer model.
 *
 * @param {object} model - Viewer model from toViewerModel().
 * @param {object} [options]
 * @param {boolean} [options.pretty=true] - Indent for a file a person will read in a diff.
 * @returns {string} JSON, newline-terminated.
 */
export function toJson(model, { pretty = true } = {}) {
  const payload = { ...model, version: model?.version ?? VIEWER_MODEL_VERSION };
  return `${JSON.stringify(payload, replacer, pretty ? 2 : 0)}\n`;
}

/**
 * `Map` and `Set` serialise to `{}` and disappear without a word.
 *
 * Nothing in the viewer model uses them today — `toViewerModel` flattens everything to
 * arrays on purpose — but a field added later would vanish silently rather than fail, and
 * a consumer would find an empty object where the data used to be. Converting them costs
 * nothing and removes a way for this file to lie.
 */
function replacer(key, value) {
  if (value instanceof Map) return Object.fromEntries(value);
  if (value instanceof Set) return [...value];
  return value;
}

/** Suggested file name for an exported model. */
export function jsonFileName(model) {
  const name = (model?.meta?.modelName || 'model').replace(/[^\w.-]+/g, '-');
  const date = (model?.meta?.generatedAt || new Date().toISOString()).slice(0, 10);
  return `${name}-model-${date}.json`;
}
