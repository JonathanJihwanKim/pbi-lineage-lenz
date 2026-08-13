/**
 * @pbi-lineage-lenz/core - Core analysis engine for Power BI PBIP projects.
 *
 * Platform-independent: works in Node.js, VS Code, and browsers.
 * Provide a Map<string, string> of file paths to contents, and get back
 * a fully-traced lineage graph with physical source names resolved.
 */

// Parsers
import { parseTmdlModel, parseExpressions, extractMDataSource, extractRenameColumns, extractNestedJoins } from './parser/tmdlParser.js';
import { parseDaxExpression, extractColumnRefs, extractMeasureRefs, extractTableRefs, extractUseRelationshipRefs } from './parser/daxParser.js';
import { parsePbirReport, parseReportExtensions } from './parser/pbirParser.js';
import { detectEnrichments, applyEnrichments } from './parser/enrichment.js';
import { identifyProjectStructure, findDefinitionPbir, parseSemanticModelReference, isRelevantFile, RELEVANT_EXTENSIONS } from './parser/projectStructure.js';
import { partitionPbip, describeProblem, describeChoice, shouldRead, normalizePath } from './parser/projectLayout.js';
import { parseBookmarks, resolveVisibility } from './parser/bookmarks.js';
import {
  resolveFieldParameters, expandFieldParameters, parseNameOfTargets, isFieldParameterTable,
} from './parser/fieldParameters.js';

// Power Query M
import {
  extractDataSources, extractTableLineage, extractTableLineageFromModel,
  extractAllFromModel, parseMSteps, parseMStepsFromModel, buildTableSourceKeyMap,
  extractSqlTableRefs, deduplicateSources, sourceKey, requiresGateway,
  classifyStepKind, stripMComments, STEP_KINDS,
} from './parser/mquery.js';

// Physical source naming (the data-engineer <-> BI-developer bridge)
import {
  resolveSourceNames, toSourceMapRows, parseSqlSelectList,
  formatPhysicalTablePath, formatPhysicalColumnPath, CONFIDENCE, ORIGIN,
} from './naming/sourceNameResolver.js';

// Graph
import { buildGraph, computeStats, createNode, createEdge, buildAdjacency } from './graph/graphBuilder.js';
import { traceMeasureLineage, traceVisualLineage } from './graph/lineageTracer.js';
import { analyzeImpact, findOrphans, exportImpactReport } from './graph/impactAnalysis.js';

// Constants
import { NODE_TYPES, EDGE_TYPES, LAYER_COLORS, ENRICHMENT_TYPES } from './utils/constants.js';

// Change Detection
import { detectChanges } from './diff/changeDetector.js';
import { CHANGE_TYPES, CHANGE_SCOPES } from './diff/changeTypes.js';
import { resolveImpact } from './diff/impactResolver.js';

// Re-export everything
export {
  // Parsers
  parseTmdlModel, parseExpressions, extractMDataSource, extractRenameColumns, extractNestedJoins,
  parseDaxExpression, extractColumnRefs, extractMeasureRefs, extractTableRefs, extractUseRelationshipRefs,
  parsePbirReport, parseReportExtensions,
  detectEnrichments, applyEnrichments,
  identifyProjectStructure, findDefinitionPbir, parseSemanticModelReference, isRelevantFile, RELEVANT_EXTENSIONS,
  partitionPbip, describeProblem, describeChoice, shouldRead, normalizePath,
  parseBookmarks, resolveVisibility,
  resolveFieldParameters, expandFieldParameters, parseNameOfTargets, isFieldParameterTable,
  // Graph
  buildGraph, computeStats, createNode, createEdge, buildAdjacency,
  traceMeasureLineage, traceVisualLineage,
  analyzeImpact, findOrphans, exportImpactReport,
  // Constants
  NODE_TYPES, EDGE_TYPES, LAYER_COLORS, ENRICHMENT_TYPES,
  // Change Detection
  detectChanges, CHANGE_TYPES, CHANGE_SCOPES, resolveImpact,
  // Power Query M
  extractDataSources, extractTableLineage, extractTableLineageFromModel,
  extractAllFromModel, parseMSteps, parseMStepsFromModel, buildTableSourceKeyMap,
  extractSqlTableRefs, deduplicateSources, sourceKey, requiresGateway,
  classifyStepKind, stripMComments, STEP_KINDS,
  // Physical source naming
  resolveSourceNames, toSourceMapRows, parseSqlSelectList,
  formatPhysicalTablePath, formatPhysicalColumnPath, CONFIDENCE, ORIGIN,
};

/**
 * Analyze a PBIP project from pre-parsed file structures.
 * This is the main high-level API that runs the full pipeline:
 * parse model -> parse DAX -> parse report -> detect enrichments -> build graph.
 *
 * @param {object} options
 * @param {object} options.modelStructure - Output of identifyProjectStructure() for the semantic model folder.
 * @param {object} [options.reportStructure] - Output of identifyProjectStructure() for the report folder.
 * @returns {{ graph: object, stats: object, enrichments: object, model: object, report: object,
 *   sourceNames: {tables: Map, columns: Map, stats: object}, dataSources: Array, bookmarks: Array }}
 */
export function analyze({ modelStructure, reportStructure }) {
  // Step 1: Parse TMDL model
  const tmdlFiles = modelStructure?.tmdlFiles || [];
  const relationshipFiles = modelStructure?.relationshipFiles || [];
  const expressionFiles = modelStructure?.expressionFiles || [];
  const model = parseTmdlModel(tmdlFiles, relationshipFiles);

  // Step 2: Parse expressions
  const parsedExpressions = { expressions: [], parameters: new Map() };
  for (const { content } of expressionFiles) {
    const result = parseExpressions(content);
    parsedExpressions.expressions.push(...result.expressions);
    for (const [k, v] of result.parameters) parsedExpressions.parameters.set(k, v);
  }
  model.expressions = parsedExpressions.expressions;
  model.parameters = parsedExpressions.parameters;

  // Step 3: Parse DAX for measures and calculated columns
  for (const table of model.tables) {
    for (const measure of (table.measures || [])) {
      if (measure.expression) measure.daxDeps = parseDaxExpression(measure.expression);
    }
    for (const col of (table.calculatedColumns || [])) {
      if (col.expression) col.daxDeps = parseDaxExpression(col.expression);
    }
  }

  // Step 4: Parse report (if provided)
  const report = reportStructure
    ? parsePbirReport(reportStructure.visualFiles || [], reportStructure.pageFiles || [])
    : { visuals: [], pages: [] };

  // Step 4a-0: Report-level measures. Defined on the report, not the model, so a visual
  // that references one is not referencing something missing.
  report.reportMeasures = parseReportExtensions(reportStructure?.extensionFiles || []);

  // Step 4a: Field parameters — a visual binds the parameter table, not the 22 measures
  // behind it. Following the binding is the difference between "shows 7 measures" and
  // "shows 7, and a slicer reaches 15 more".
  const fieldParameters = resolveFieldParameters(model);
  expandFieldParameters(report.visuals || [], fieldParameters);

  // Step 4b: Bookmarks — which named state reveals each hidden visual
  const bookmarks = parseBookmarks(reportStructure?.bookmarkFiles || []);
  const visibility = resolveVisibility(report.visuals || [], bookmarks);
  for (const visual of report.visuals || []) {
    const state = visibility.get(visual.id);
    if (state) {
      visual.revealedBy = state.revealedBy;
      visual.neverShown = state.neverShown;
    }
  }

  // Step 5: Detect and apply enrichments
  const enrichments = detectEnrichments(model.tables);
  let graph = buildGraph(model, report, enrichments);
  graph = applyEnrichments(graph, enrichments);

  // Step 6: Resolve physical source names for every table and column
  const sourceNames = resolveSourceNames(model);
  const dataSources = extractAllFromModel(model);

  // Step 7: Compute stats
  const stats = computeStats(graph);

  return { graph, stats, enrichments, model, report, sourceNames, dataSources, bookmarks };
}

/**
 * Analyze a PBIP project from raw file maps.
 * Convenience wrapper that handles identifyProjectStructure internally.
 *
 * @param {object} options
 * @param {Map<string, string>} options.modelFiles - Map of relative path -> content for the semantic model folder.
 * @param {Map<string, string>} [options.reportFiles] - Map of relative path -> content for the report folder.
 * @returns {{ graph: object, stats: object, enrichments: object, model: object, report: object }}
 */
export function analyzeFromFiles({ modelFiles, reportFiles }) {
  const modelStructure = identifyProjectStructure(modelFiles);
  const reportStructure = reportFiles ? identifyProjectStructure(reportFiles) : null;
  return analyze({ modelStructure, reportStructure });
}
