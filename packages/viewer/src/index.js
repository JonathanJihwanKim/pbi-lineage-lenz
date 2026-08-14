/**
 * @pbi-lineage-lenz/viewer — read-only UI for a parsed Power BI model.
 *
 * No file system, no network, no framework. Give it a viewer model and a DOM node.
 * The web app and the handoff file mount the same components.
 */

export {
  toViewerModel, buildIndex, traceMeasure, parseRef, refs,
  VIEWER_MODEL_VERSION, TABLE_KIND,
} from './viewerModel.js';
export { mountViewer } from './viewer.js';
export { NameState, nameToggle, bindToggleShortcut, columnName, physicalPath, VOCAB } from './names.js';
export { sourceMapLens, confidenceBadge, confidenceBar } from './sourceMap.js';
export { catalogLens, highlightDax } from './catalog.js';
export { graphView, buildTraceGraph } from './graph.js';
export { pageLens } from './pageLens.js';
export { modelLens, kindChip, describeKind } from './modelLens.js';
export { overviewLens } from './overviewLens.js';
export {
  describeModelShape, neighbourhood, describeRole, TABLE_ROLE, ROLE_ORDER,
} from './modelShape.js';
export { pageCanvas, locatorCard, visibilityNote, describe } from './locator.js';
export { h, svg, replace, append, copyText, debounce, escapeHtml } from './dom.js';
