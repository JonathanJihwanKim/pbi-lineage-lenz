/**
 * Folder layout detection, re-exported.
 *
 * This logic moved into core once the CLI needed it too: the web app walks a directory
 * handle and the CLI walks a disk path, but both have to make the same decision about
 * where the model is, and two copies of that decision would drift.
 *
 * The re-export is kept so the app's own modules read as app-local.
 */

export {
  partitionPbip, describeProblem, describeChoice, shouldRead, normalizePath,
} from '@pbi-lineage-lenz/core';
