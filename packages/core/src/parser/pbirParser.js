/**
 * PBIR Parser - Parses Power BI Report (PBIR) visual configuration files.
 * Extracts pages, visuals, and their field bindings to connect visuals
 * to model objects (measures, columns).
 */

/**
 * Parse all PBIR report files and extract pages and visuals.
 * @param {Array<{path: string, content: string}>} visualFiles - Visual JSON file entries.
 * @param {Array<{path: string, content: string}>} pageFiles - Page JSON file entries.
 * @returns {{ pages: Array, visuals: Array }}
 */
export function parsePbirReport(visualFiles, pageFiles) {
  const pages = [];
  const visuals = [];

  // Parse page definitions
  for (const { path, content } of pageFiles) {
    try {
      const config = JSON.parse(content);
      const pageFolderId = extractPageIdFromPath(path);
      const pageName = extractPageName(path, config);
      pages.push({
        id: pageFolderId || pageName,
        name: pageName,
        displayName: config.displayName || config.name || pageName,
        order: config.ordinal ?? config.order ?? pages.length,
        width: config.width || config.defaultSize?.width || 1280,
        height: config.height || config.defaultSize?.height || 720,
        path,
      });
    } catch (err) {
      // Non-JSON page file or parse error — derive name from path
      const pageName = extractPageName(path, null);
      const pageFolderId2 = extractPageIdFromPath(path);
      if (pageName) {
        pages.push({
          id: pageFolderId2 || pageName,
          name: pageName,
          displayName: pageName,
          order: pages.length,
          path,
        });
      }
    }
  }

  // Parse visual configs
  for (const { path, content } of visualFiles) {
    try {
      const config = JSON.parse(content);
      const pageId = extractPageIdFromPath(path);
      const parsed = parseVisualConfig(config, pageId);
      parsed.path = path;
      visuals.push(parsed);
    } catch (err) {
      console.warn(`Failed to parse visual config: ${path}`, err);
    }
  }

  return { pages, visuals };
}

/**
 * Extract the page name from a file path or config object.
 * @param {string} path
 * @param {object|null} config
 * @returns {string}
 */
function extractPageName(path, config) {
  if (config && (config.displayName || config.name)) {
    return config.displayName || config.name;
  }
  // Derive from path: .../pages/PageName/page.json or .../SomePage/...
  const normalized = path.replace(/\\/g, '/');
  const parts = normalized.split('/');
  const pageIdx = parts.findIndex(p => p.toLowerCase() === 'pages');
  if (pageIdx !== -1 && pageIdx + 1 < parts.length) {
    return parts[pageIdx + 1];
  }
  // Fallback: use parent directory name
  const jsonIdx = parts.length - 1;
  return parts[Math.max(0, jsonIdx - 1)];
}

/**
 * Extract page identifier from a visual's file path.
 * Expected pattern: .../pages/<pageId>/visuals/<visualId>/visual.json
 * @param {string} path
 * @returns {string}
 */
function extractPageIdFromPath(path) {
  const normalized = path.replace(/\\/g, '/');
  const parts = normalized.split('/');
  const pagesIdx = parts.findIndex(p => p.toLowerCase() === 'pages');
  if (pagesIdx !== -1 && pagesIdx + 1 < parts.length) {
    return parts[pagesIdx + 1];
  }
  return '';
}



/**
 * Parse a single visual configuration JSON file.
 * @param {object} config - The parsed JSON config for a visual.
 * @param {string} pageName - The page this visual belongs to.
 * @returns {{ id: string, type: string, page: string, title: string, fields: Array }}
 */
export function parseVisualConfig(config, pageName) {
  const visual = config.visual || config;

  const id = visual.id || config.id || config.name || '';
  // Detect group visuals via the visualGroup property
  const isGroup = !!config.visualGroup;
  const visualType = isGroup ? 'group' : (visual.visualType || visual.type || config.visualType || 'unknown');

  // Extract title from various possible locations
  let title = '';
  if (visual.title) {
    title = typeof visual.title === 'string' ? visual.title : (visual.title.text || '');
  }
  if (!title && visual.objects?.title?.properties?.text) {
    const textProp = visual.objects.title.properties.text;
    if (typeof textProp === 'string') title = textProp;
    else if (textProp.expr?.Literal?.Value) title = textProp.expr.Literal.Value.replace(/^'|'$/g, '');
  }
  if (!title && visual.vcObjects?.title) {
    const titleArr = visual.vcObjects.title;
    if (Array.isArray(titleArr) && titleArr[0]?.properties?.text?.expr?.Literal?.Value) {
      title = titleArr[0].properties.text.expr.Literal.Value.replace(/^'|'$/g, '');
    } else if (titleArr?.properties?.text?.expr?.Literal?.Value) {
      title = titleArr.properties.text.expr.Literal.Value.replace(/^'|'$/g, '');
    }
  }
  // PBIR format: visualContainerObjects.title
  if (!title && visual.visualContainerObjects?.title) {
    const titleArr = visual.visualContainerObjects.title;
    if (Array.isArray(titleArr) && titleArr[0]?.properties?.text?.expr?.Literal?.Value) {
      title = titleArr[0].properties.text.expr.Literal.Value.replace(/^'|'$/g, '');
    } else if (titleArr?.properties?.text?.expr?.Literal?.Value) {
      title = titleArr.properties.text.expr.Literal.Value.replace(/^'|'$/g, '');
    }
  }

  const fields = extractFieldReferences(visual, config);

  // What the visual plots. Deliberately narrow: a field can be consumed without being
  // plotted, and `field.via` says which route each one took. Reading `boundFields === 0`
  // as "displays nothing" is wrong — a textbox's dynamic values live in its Values well,
  // never in queryState.
  const boundFields = countBoundFields(visual);

  // Extract hidden state
  const isHidden = config.isHidden === true || visual.isHidden === true;

  // parentGroupName is stored directly in the visual config JSON
  const parentGroupName = config.parentGroupName || null;

  // For group visuals, extract the display name
  if (isGroup && !title && config.visualGroup?.displayName) {
    title = config.visualGroup.displayName;
  }

  // `role` labels and sorts a visual. It must never be used to filter one out of a
  // view: 85 visuals in a real report display measures through titles and conditional
  // formatting alone, and those are exactly the field-parameter and calculation-group
  // surfaces a reader needs to find.
  const role = isGroup ? 'container' : (fields.length > 0 ? 'data' : 'decoration');

  return {
    id,
    type: visualType,
    visualType,
    page: pageName,
    pageId: pageName,
    title,
    fields,
    boundFields,
    role,
    position: config.position || null,
    isHidden,
    parentGroupName,
  };
}

/**
 * Count projections bound through `queryState` — the fields a visual actually plots.
 * @param {object} visualConfig
 * @returns {number}
 */
function countBoundFields(visualConfig) {
  const queryState = visualConfig?.query?.queryState || visualConfig?.queryState;
  if (!queryState || typeof queryState !== 'object') return 0;

  let count = 0;
  for (const roleState of Object.values(queryState)) {
    if (Array.isArray(roleState?.projections)) count += roleState.projections.length;
  }
  return count;
}

/**
 * How a visual reaches a field — the Power BI feature the reference belongs to.
 *
 * A count of "bound" fields answers the wrong question. A textbox's **Values** well and a
 * button's tooltip colour both sit outside `queryState`, so both scored zero, and the
 * report read as though 85 visuals referenced data without really using it. They are not
 * the same thing: per Microsoft, a dynamic value is a measure the author placed through
 * the fx field selector in Format > General > Values, and displaying it is the entire
 * point of the textbox.
 *
 * @see https://learn.microsoft.com/en-us/power-bi/create-reports/power-bi-reports-add-text-and-shapes
 */
export const VIA = Object.freeze({
  /** Plotted by the visual — a queryState projection, a field parameter, a binding. */
  QUERY: 'query',
  /** A dynamic value in a text box: `objects.values`, Microsoft's documented feature. */
  VALUE: 'value',
  /** Offered by a field parameter bound to this visual — a slicer away from being shown. */
  PARAMETER: 'parameter',
  /** A dynamic title or subtitle. Shown to the reader, but not the visual's data. */
  TITLE: 'title',
  /** A visual-level filter. */
  FILTER: 'filter',
  /** Drives navigation rather than display — a measure-built link URL. */
  ACTION: 'action',
  /** Conditional formatting: data colours, labels, reference lines, button text. */
  FORMAT: 'format',
});

/**
 * Most direct route first. Used when one field is reachable more than one way.
 *
 * `parameter` sits above `filter` deliberately. A measure that both filters a pivot table
 * and sits in the field parameter bound to its Values well is a measure the reader can
 * put on the canvas — reporting only "filters this visual" answers a question nobody
 * asked and hides the one they did.
 */
export const VIA_RANK = [
  VIA.QUERY, VIA.VALUE, VIA.PARAMETER, VIA.TITLE, VIA.FILTER, VIA.ACTION, VIA.FORMAT,
];

/**
 * Which route a formatting object represents, by the key it hangs off.
 *
 * Measured across the sample report, the keys that actually carry references are
 * `objects.values` (textbox dynamic values, 30), `visualContainerObjects.visualLink`
 * (button and shape links, 32), `objects.text` (button text, 23), and a long tail of
 * `dataPoint`, `labels`, `columnWidth`, `referenceLabel`, `xAxisReferenceLine` — all of
 * which are conditional formatting.
 */
function viaForObjectKey(container, key, visualType) {
  // `objects.values` means two unrelated things. On a text box it is the Values well —
  // the fx field selector Microsoft documents as a dynamic value. On a table, matrix or
  // pivot table it is the *Values* formatting card, where an icon or colour rule lives.
  // Reading the key alone called a pivot table's icon threshold a displayed value.
  if (key === 'values') return visualType === 'textbox' ? VIA.VALUE : VIA.FORMAT;
  if (key === 'title' || key === 'subTitle') return VIA.TITLE;
  if (key === 'visualLink') return VIA.ACTION;
  return VIA.FORMAT;
}

/**
 * Extract field references from a visual's data bindings and query.
 * @param {object} visualConfig - The visual configuration object.
 * @returns {Array<{ type: string, table: string, column: string|null, measure: string|null,
 *   role: string, via: string }>}
 */
export function extractFieldReferences(visualConfig, fullConfig) {
  const fields = [];
  const byKey = new Map();

  function addField(field, via = VIA.FORMAT) {
    const key = `${field.type}|${field.table}|${field.column || ''}|${field.measure || ''}`;
    const existing = byKey.get(key);
    if (!existing) {
      const entry = { ...field, via };
      byKey.set(key, entry);
      fields.push(entry);
      return;
    }
    // The same field can be reached more than one way — plotted and also named in a
    // dynamic title. Keep the most direct route rather than whichever was walked last.
    if (VIA_RANK.indexOf(via) < VIA_RANK.indexOf(existing.via)) existing.via = via;
  }

  // 1. Extract from prototypeQuery.Select (traditional PBI format)
  const query = visualConfig.prototypeQuery || visualConfig.query;
  const sourceAliasMap = {};
  if (query?.From) {
    for (const from of query.From) {
      if (from.Name && from.Entity) {
        sourceAliasMap[from.Name] = from.Entity;
      }
    }
  }
  if (query?.Select) {
    for (const selectItem of query.Select) {
      const ref = extractFromSelectItem(selectItem, sourceAliasMap);
      if (ref) addField(ref, VIA.QUERY);
    }
  }

  // 2. Extract from PBIR queryState projections
  // PBIR format: visual.query.queryState.<DataRole>.projections[].field
  // Each field is { Column: { Expression: { SourceRef: { Entity } }, Property } }
  // or { Measure: { Expression: { SourceRef: { Entity } }, Property } }
  const queryState = visualConfig.query?.queryState || visualConfig.queryState;
  if (queryState) {
    for (const [role, roleState] of Object.entries(queryState)) {
      if (!roleState || typeof roleState !== 'object') continue;

      // Extract from projections
      const projections = roleState.projections;
      if (Array.isArray(projections)) {
        for (const proj of projections) {
          const ref = extractFromPbirProjection(proj, role);
          if (ref) addField(ref, VIA.QUERY);
        }
      }

      // Extract field parameters
      const fieldParams = roleState.fieldParameters;
      if (Array.isArray(fieldParams)) {
        for (const fp of fieldParams) {
          const paramExpr = fp.parameterExpr || fp.ParameterExpr;
          if (!paramExpr) continue;
          const col = paramExpr.Column || paramExpr.column;
          if (!col) continue;
          const sourceRef = col.Expression?.SourceRef || col.expression?.sourceRef;
          const entity = sourceRef?.Entity || sourceRef?.entity || '';
          if (entity) {
            addField({ type: 'fieldParameter', table: entity, column: null, measure: null, role },
              VIA.QUERY);
          }
        }
      }
    }
  }

  // 3. Extract from dataRoleBindings / columnBindings (older format)
  const bindings = visualConfig.dataRoleBindings || visualConfig.columnBindings;
  if (bindings) {
    for (const [role, binding] of Object.entries(bindings)) {
      const items = Array.isArray(binding) ? binding : (binding.items || binding.bindings || [binding]);
      for (const item of items) {
        const ref = extractFromBinding(item, role);
        if (ref) addField(ref, VIA.QUERY);
      }
    }
  }

  // 4. Extract from filterConfig.filters (PBIR format — at top-level config)
  const filterConfig = fullConfig?.filterConfig?.filters || visualConfig.filterConfig?.filters || [];
  for (const filter of filterConfig) {
    if (filter.field) {
      const ref = extractFromPbirField(filter.field, 'filter');
      if (ref) addField(ref, VIA.FILTER);
    }
  }

  // 5. Everything outside the query: dynamic values, dynamic titles, link URLs and
  //    conditional formatting. Walked one top-level key at a time, because the key is
  //    what says which feature the reference belongs to — `objects.values` is a field
  //    well, `objects.dataPoint` is a colour rule, and flattening them loses that.
  const visualType = visualConfig.visualType || visualConfig.type || '';
  for (const container of ['vcObjects', 'visualContainerObjects', 'objects']) {
    const node = visualConfig[container];
    if (!node || typeof node !== 'object') continue;
    for (const [key, child] of Object.entries(node)) {
      const via = viaForObjectKey(container, key, visualType);
      deepSearchForRefs(child, (ref) => addField(ref, via));
    }
  }
  deepSearchForRefs(visualConfig.dataTransforms, (ref) => addField(ref, VIA.QUERY));

  return fields;
}

/**
 * Extract a field reference from a PBIR queryState projection item.
 * PBIR format: { field: { Measure: { Expression: { SourceRef: { Entity } }, Property } } }
 * or { field: { Column: { Expression: { SourceRef: { Entity } }, Property } } }
 */
function extractFromPbirProjection(proj, role) {
  const field = proj?.field;
  if (!field) return null;
  return extractFromPbirField(field, role);
}

/**
 * Extract a field reference from a PBIR field object.
 * Handles both Measure and Column patterns with direct Entity references.
 */
function extractFromPbirField(field, role) {
  if (!field) return null;

  // Measure reference
  if (field.Measure) {
    const entity = field.Measure.Expression?.SourceRef?.Entity || '';
    const property = field.Measure.Property || '';
    if (entity || property) {
      return { type: 'measure', table: entity, column: null, measure: property, role: role || '' };
    }
  }

  // Column reference
  if (field.Column) {
    const entity = field.Column.Expression?.SourceRef?.Entity || '';
    const property = field.Column.Property || '';
    if (entity || property) {
      return { type: 'column', table: entity, column: property, measure: null, role: role || '' };
    }
  }

  // Aggregation wrapping a column
  if (field.Aggregation) {
    const expr = field.Aggregation.Expression;
    if (expr?.Column) {
      const entity = expr.Column.Expression?.SourceRef?.Entity || '';
      const property = expr.Column.Property || '';
      if (entity || property) {
        return { type: 'column', table: entity, column: property, measure: null, role: role || '' };
      }
    }
  }

  return null;
}

/**
 * Extract field parameter table references from a visual's queryState.
 * When a visual uses a field parameter, the queryState contains a fieldParameters
 * block under data roles (Values, Rows, Columns, etc.) that references the
 * field parameter table via parameterExpr.Column.Expression.SourceRef.Entity.
 * @param {object} queryState - The visual's queryState object.
 * @param {function} addField - Callback to add found field references.
 * @param {object} sourceAliasMap - Map of source aliases to entity names.
 */
function extractFieldParameterRefs(queryState, addField, sourceAliasMap) {
  if (!queryState || typeof queryState !== 'object') return;

  // Walk each data role (Values, Rows, Columns, etc.)
  for (const [role, roleState] of Object.entries(queryState)) {
    if (!roleState || typeof roleState !== 'object') continue;

    // Check for fieldParameters array
    const fieldParams = roleState.fieldParameters;
    if (!Array.isArray(fieldParams)) continue;

    for (const fp of fieldParams) {
      // Extract the field parameter table name from parameterExpr
      const paramExpr = fp.parameterExpr || fp.ParameterExpr;
      if (!paramExpr) continue;

      const col = paramExpr.Column || paramExpr.column;
      if (!col) continue;

      const sourceRef = col.Expression?.SourceRef || col.expression?.sourceRef;
      if (!sourceRef) continue;

      const entity = sourceRef.Entity || sourceRef.entity ||
        (sourceRef.Source && sourceAliasMap[sourceRef.Source]) || '';

      if (entity) {
        addField({
          type: 'fieldParameter',
          table: entity,
          column: null,
          measure: null,
          role: role,
        });
      }
    }
  }
}

/**
 * Extract a field reference from a prototypeQuery Select item.
 * @param {object} selectItem
 * @returns {{ type: string, table: string, column: string|null, measure: string|null, role: string }|null}
 */
function extractFromSelectItem(selectItem, sourceAliasMap = {}) {
  function resolveEntity(sourceRef) {
    if (!sourceRef) return '';
    // Direct Entity reference
    if (sourceRef.Entity) return sourceRef.Entity;
    // Alias-based: resolve Source alias to Entity name
    if (sourceRef.Source && sourceAliasMap[sourceRef.Source]) {
      return sourceAliasMap[sourceRef.Source];
    }
    return sourceRef.Source || '';
  }

  // Column reference
  if (selectItem.Column) {
    const col = selectItem.Column;
    const entity = resolveEntity(col.Expression?.SourceRef);
    const property = col.Property || col.Name || '';
    if (entity || property) {
      return {
        type: 'column',
        table: entity,
        column: property,
        measure: null,
        role: selectItem.Name || '',
      };
    }
  }

  // Measure reference
  if (selectItem.Measure) {
    const meas = selectItem.Measure;
    const entity = resolveEntity(meas.Expression?.SourceRef);
    const property = meas.Property || meas.Name || '';
    if (entity || property) {
      return {
        type: 'measure',
        table: entity,
        column: null,
        measure: property,
        role: selectItem.Name || '',
      };
    }
  }

  // Aggregation wrapping a column
  if (selectItem.Aggregation) {
    const agg = selectItem.Aggregation;
    const expr = agg.Expression;
    if (expr?.Column) {
      const entity = resolveEntity(expr.Column.Expression?.SourceRef);
      const property = expr.Column.Property || '';
      if (entity || property) {
        return {
          type: 'column',
          table: entity,
          column: property,
          measure: null,
          role: selectItem.Name || '',
        };
      }
    }
  }

  return null;
}

/**
 * Extract a field reference from a data role binding item.
 * @param {object} item
 * @param {string} role
 * @returns {{ type: string, table: string, column: string|null, measure: string|null, role: string }|null}
 */
function extractFromBinding(item, role) {
  if (!item || typeof item !== 'object') return null;

  // Direct table/column/measure properties
  if (item.table && (item.column || item.measure)) {
    return {
      type: item.measure ? 'measure' : 'column',
      table: item.table,
      column: item.column || null,
      measure: item.measure || null,
      role,
    };
  }

  // Nested expression format
  const expr = item.Expression || item.expression || item;
  if (expr?.SourceRef?.Entity) {
    return {
      type: item.measure || item.Measure ? 'measure' : 'column',
      table: expr.SourceRef.Entity,
      column: item.Property || item.column || null,
      measure: item.Property || item.measure || null,
      role,
    };
  }

  return null;
}

/**
 * Recursively search an object for SourceRef/Entity/Property patterns.
 * @param {*} obj
 * @param {function} addField - Callback to add found field references.
 * @param {number} [depth=0]
 */
/**
 * Resolve a `SourceRef` to a table name.
 *
 * A reference names its table one of two ways. Directly, as `SourceRef.Entity`. Or by
 * alias, as `SourceRef.Source: "m"`, which resolves against the `From` array of the
 * nearest enclosing query — `From: [{ Name: "m", Entity: "Measure" }]`.
 *
 * The alias form is what a dynamic title or a conditional format compiles to, because
 * those wrap their measure in a subquery. Resolving only `Entity` silently drops them,
 * which is why a textbox titled by a measure did not count as consuming it.
 *
 * @param {object} sourceRef
 * @param {Array<Map<string, string>>} scopes - Enclosing alias maps, outermost first.
 * @returns {string|null}
 */
function resolveSourceRef(sourceRef, scopes) {
  if (!sourceRef) return null;
  if (sourceRef.Entity) return sourceRef.Entity;
  if (!sourceRef.Source) return null;

  // Innermost scope wins: an inner query may shadow an outer alias.
  for (let i = scopes.length - 1; i >= 0; i--) {
    const entity = scopes[i].get(sourceRef.Source);
    if (entity) return entity;
  }
  return null;
}

/** Alias map for a node that introduces a query scope, or null. */
function aliasScopeOf(obj) {
  if (!Array.isArray(obj?.From)) return null;
  const scope = new Map();
  for (const from of obj.From) {
    if (from?.Name && from?.Entity) scope.set(from.Name, from.Entity);
  }
  return scope.size > 0 ? scope : null;
}

function deepSearchForRefs(obj, addField, depth = 0, scopes = []) {
  // 24 rather than 15: a measure inside a conditional-format subquery sits ~13 levels
  // below `visual.objects`, and nesting deepens with each wrapping aggregation.
  if (!obj || typeof obj !== 'object' || depth > 24) return;

  if (Array.isArray(obj)) {
    for (const item of obj) {
      deepSearchForRefs(item, addField, depth + 1, scopes);
    }
    return;
  }

  // A node carrying `From` opens an alias scope for everything beneath it.
  const scope = aliasScopeOf(obj);
  const inner = scope ? [...scopes, scope] : scopes;

  // Check if this object has SourceRef with Entity
  if (obj.SourceRef && obj.Property) {
    const table = resolveSourceRef(obj.SourceRef, inner);
    if (table) {
      // Determine type from context
      addField({
        type: 'column', // default; caller context may override
        table,
        column: obj.Property,
        measure: null,
        role: '',
      });
    }
  }

  // Check Column/Measure wrapper
  if (obj.Column?.Property) {
    const table = resolveSourceRef(obj.Column.Expression?.SourceRef, inner);
    if (table) {
      addField({
        type: 'column',
        table,
        column: obj.Column.Property,
        measure: null,
        role: obj.Name || '',
      });
    }
  }
  if (obj.Measure?.Property) {
    const table = resolveSourceRef(obj.Measure.Expression?.SourceRef, inner);
    if (table) {
      addField({
        type: 'measure',
        table,
        column: null,
        measure: obj.Measure.Property,
        role: obj.Name || '',
      });
    }
  }

  // Recurse into child properties
  for (const value of Object.values(obj)) {
    if (value && typeof value === 'object') {
      deepSearchForRefs(value, addField, depth + 1, inner);
    }
  }
}

/**
 * Report-level measures, defined on the report rather than in the semantic model.
 *
 * Power BI lets a report add measures of its own — the usual reason is a live connection
 * to a model the report author cannot edit. They live in `definition/reportExtensions.json`
 * and are indistinguishable from model measures once a visual references one.
 *
 * A gate that only knows the semantic model reports every one of them as a reference to
 * something deleted. This file was not being read at all, so the first version of the
 * dangling-reference check would have accused a live measure.
 *
 * @param {Array<{path: string, content: string}>} extensionFiles
 * @returns {Array<{table: string, name: string, expression: string|null}>}
 */
export function parseReportExtensions(extensionFiles) {
  const measures = [];

  for (const { content } of extensionFiles || []) {
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      continue;
    }
    for (const entity of parsed?.entities || []) {
      if (!entity?.name) continue;
      for (const measure of entity.measures || []) {
        if (!measure?.name) continue;
        measures.push({
          table: entity.name,
          name: measure.name,
          expression: measure.expression ?? null,
        });
      }
    }
  }

  return measures;
}
