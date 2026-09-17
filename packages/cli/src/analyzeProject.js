/**
 * From a path to viewer models — for one report, or for every report in a workspace.
 *
 * Every command that reads lineage starts here, so `docs`, `check` and `impact` agree on
 * what "the project" is and on the keys that identify its parts.
 */

import { basename, resolve } from 'path';
import {
  analyzeFromFiles, identifyProjectStructure, parseModel, analyzeReport, partitionEstate,
} from '@pbi-lineage-lenz/core';
import { toViewerModel } from '@pbi-lineage-lenz/viewer';
import { loadProject, readProjectFolder } from './readProject.js';
import { existsSync, statSync } from 'fs';

/**
 * @typedef {object} Loaded
 * @property {Array<object>} models - One viewer model per analysed report (or per model
 *   with no report, under --all).
 * @property {string|null} note - A line worth showing before the results.
 * @property {object|null} manifest - Under --all: what was found, how it paired, and
 *   what could not be analysed. null for a single project.
 */

/**
 * @param {string} path
 * @param {{all?: boolean}} [options]
 * @returns {Loaded}
 */
export function loadModels(path, { all = false } = {}) {
  return all ? loadEstate(path) : loadSingle(path);
}

function loadSingle(path) {
  const { partition, note } = loadProject(path);
  const analysis = analyzeFromFiles({
    modelFiles: partition.modelFiles,
    reportFiles: partition.reportFiles ?? undefined,
  });
  const fallback = basename(resolve(path));
  const model = toViewerModel(analysis, {
    modelName: partition.modelName ?? fallback,
    reportName: partition.reportName,
    modelKey: partition.modelKey ?? partition.modelName ?? fallback,
    reportKey: partition.reportKey ?? partition.reportName ?? partition.modelName ?? fallback,
    projectPath: resolve(path),
  });
  return { models: [model], note, manifest: null };
}

/**
 * Every report in a folder, each against the model it names.
 *
 * A model shared by several reports is parsed once. One report that cannot be read does not
 * abort the rest: in a workspace of forty items, one broken report is a finding to report,
 * not a reason to produce nothing.
 */
function loadEstate(path) {
  const root = resolve(path);
  if (!existsSync(root)) throw new Error(`No such folder: ${path}`);
  if (!statSync(root).isDirectory()) throw new Error(`${path} is a file. Point at a workspace folder.`);

  const estate = partitionEstate(readProjectFolder(root));
  if (estate.models.length === 0 && estate.reports.length === 0) {
    throw new Error('No .SemanticModel or .Report folders here. Point at the folder that holds them — '
      + 'the root of a Fabric workspace synced to git, for example.');
  }

  const parsed = new Map();
  const failures = new Map();
  const parsedModel = (model) => {
    if (parsed.has(model.key) || failures.has(model.key)) return parsed.get(model.key) ?? null;
    try {
      parsed.set(model.key, parseModel(identifyProjectStructure(model.files)));
    } catch (error) {
      failures.set(model.key, error.message);
    }
    return parsed.get(model.key) ?? null;
  };

  const models = [];
  const reportRows = [];
  const modelsByKey = new Map(estate.models.map((model) => [model.key, model]));

  for (const report of estate.reports) {
    const row = {
      key: report.key,
      name: report.name,
      modelKey: report.modelKey,
      visualCount: report.visualCount,
      status: 'analysed',
      problem: report.problem,
    };
    reportRows.push(row);
    if (report.problem) { row.status = 'unpaired'; continue; }

    const model = modelsByKey.get(report.modelKey);
    const parsedResult = parsedModel(model);
    if (!parsedResult) {
      row.status = 'failed';
      row.problem = `Its model could not be read: ${failures.get(model.key)}`;
      continue;
    }

    try {
      const analysis = analyzeReport(parsedResult, identifyProjectStructure(report.files));
      models.push(toViewerModel(analysis, {
        modelName: model.name,
        reportName: report.name,
        modelKey: model.key,
        reportKey: report.key,
        projectPath: root,
      }));
    } catch (error) {
      row.status = 'failed';
      row.problem = error.message;
    }
  }

  // A model no report reads is still documented, and still answers impact questions about
  // its own measures — it just has no visuals to report.
  const modelRows = [];
  for (const model of estate.models) {
    const row = { key: model.key, name: model.name, reports: model.reports, status: 'analysed', problem: null };
    modelRows.push(row);
    if (model.reports.length > 0) {
      if (failures.has(model.key)) { row.status = 'failed'; row.problem = failures.get(model.key); }
      continue;
    }
    const parsedResult = parsedModel(model);
    if (!parsedResult) { row.status = 'failed'; row.problem = failures.get(model.key); continue; }
    try {
      models.push(toViewerModel(analyzeReport(parsedResult, null), {
        modelName: model.name,
        reportName: null,
        modelKey: model.key,
        reportKey: null,
        projectPath: root,
      }));
    } catch (error) {
      row.status = 'failed';
      row.problem = error.message;
    }
  }

  const manifest = {
    root,
    models: modelRows,
    reports: reportRows,
    counts: {
      models: modelRows.length,
      reports: reportRows.length,
      analysed: reportRows.filter((r) => r.status === 'analysed').length,
      unpaired: reportRows.filter((r) => r.status === 'unpaired').length,
      failed: reportRows.filter((r) => r.status === 'failed').length
        + modelRows.filter((m) => m.status === 'failed' && m.reports.length === 0).length,
    },
  };

  return { models, note: describeManifest(manifest), manifest };
}

/** One line on what a workspace run covered, and what it could not. */
export function describeManifest(manifest) {
  const { counts } = manifest;
  const parts = [`${counts.analysed} of ${counts.reports} report${counts.reports === 1 ? '' : 's'} analysed `
    + `over ${counts.models} model${counts.models === 1 ? '' : 's'}`];
  if (counts.unpaired > 0) parts.push(`${counts.unpaired} could not be paired with a model`);
  if (counts.failed > 0) parts.push(`${counts.failed} failed to read`);
  return `${parts.join('; ')}.`;
}
