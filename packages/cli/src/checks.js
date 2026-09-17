/**
 * The CI gate's findings, computed over a viewer model.
 *
 * Pure and separate from the command so the rules can be tested without a filesystem, and
 * so the web app could show the same list later without a second implementation.
 *
 * Only `broken` fails the build by default. The others are real signal but they are
 * judgement calls — a measure with no visual may be a building block, a column that
 * resolves to `unknown` may be a legitimately dynamic query. A gate that fails on
 * judgement calls gets disabled within a week, and then it catches nothing at all.
 */

/** Every rule, in the order they are reported. */
export const RULES = [
  'broken', 'broken-nameof', 'dangling-visuals', 'unused', 'unresolved', 'coverage', 'dead-visuals',
];

/** Rules that fail the build unless told otherwise. */
export const DEFAULT_FAIL_ON = new Set(['broken', 'broken-nameof']);

/**
 * Rules whose findings can be recorded in a baseline. `coverage` is a threshold over the
 * whole model, not a list of defects, so there is nothing individual to acknowledge.
 */
export const BASELINE_RULES = new Set(RULES.filter((rule) => rule !== 'coverage'));

/**
 * @param {object} model - Viewer model.
 * @param {object} [options]
 * @param {number|null} [options.minCoverage] - Fraction 0..1.
 * @returns {{rule: string, severity: string, summary: string, items: string[],
 *   entries: {key: string, text: string}[]}[]}
 *   `items` is the text of each finding. `entries` pairs it with a key built from stable
 *   identities — model refs and visual keys, never positions or line numbers — so a
 *   baseline can recognise the same finding on the next run after a visual has moved.
 */
export function runChecks(model, { minCoverage = null } = {}) {
  return [
    brokenReferences(model),
    brokenNameOf(model),
    danglingVisualRefs(model),
    unusedMeasures(model),
    unresolvedColumns(model),
    coverage(model, minCoverage),
    deadVisuals(model),
  ];
}

/** A finding from its entries: `items` is their text, kept for everything that reads it. */
function finding(rule, entries, { severity, none, some }) {
  return {
    rule,
    severity: entries.length > 0 ? severity : 'ok',
    summary: entries.length === 0 ? none : some(entries.length),
    items: entries.map((entry) => entry.text),
    entries,
  };
}

const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

/**
 * DAX that points at something the model does not contain.
 *
 * The only unambiguous defect here: a measure referencing a deleted column is broken now,
 * not a matter of taste. Table references are checked too, since a renamed table leaves
 * exactly this trace.
 */
function brokenReferences(model) {
  // Everything is compared case-insensitively, because DAX is. `[Orders on Time %]`
  // resolves to a measure defined as `Orders On Time %` in Power BI, and a gate
  // that calls that broken is reporting its own comparison, not a defect.
  const fold = (text) => String(text).toLowerCase();

  const qualified = new Set([
    ...model.columns.map((c) => fold(`${c.table}[${c.name}]`)),
    ...model.measures.map((m) => fold(`${m.table}[${m.name}]`)),
  ]);
  // Unqualified names, of either kind. A bare `[Name]` in DAX is a measure *or* a column
  // of the current row context — both are legal and indistinguishable to a text parser,
  // so a name that exists as either is not a broken reference.
  const bareNames = new Set([
    ...model.columns.map((c) => fold(c.name)),
    ...model.measures.map((m) => fold(m.name)),
  ]);
  const tables = new Set(model.tables.map((t) => fold(t.name)));

  const nameOf = (reference) => fold(/\[(.*)\]$/.exec(reference)?.[1] ?? reference);

  const entries = [];
  for (const measure of model.measures) {
    const from = `${measure.table}[${measure.name}]`;
    const key = (kind, ref) => `broken|${measure.ref}|${kind}:${ref}`;

    for (const ref of measure.dependsOn.columns) {
      if (qualified.has(fold(ref)) || bareNames.has(nameOf(ref))) continue;
      entries.push({ key: key('column', ref), text: `${from} reads ${ref}, which does not exist` });
    }

    for (const ref of measure.dependsOn.measures) {
      if (qualified.has(fold(ref)) || bareNames.has(nameOf(ref))) continue;
      entries.push({ key: key('measure', ref), text: `${from} calls ${ref}, which does not exist` });
    }

    for (const table of measure.dependsOn.tables) {
      if (tables.has(fold(table))) continue;
      entries.push({ key: key('table', table), text: `${from} reads table ${table}, which does not exist` });
    }
  }

  return finding('broken', entries, {
    severity: 'error',
    none: 'No broken references',
    some: (n) => plural(n, 'broken reference'),
  });
}

/**
 * Field parameters offering a field the model no longer contains.
 *
 * A `NAMEOF` pointing at a deleted measure does not error: the slicer entry is still
 * there, and choosing it puts nothing on the visual. It is as broken as a measure reading
 * a deleted column, and quieter, which is why it fails the build by default.
 */
function brokenNameOf(model) {
  const entries = [];
  for (const table of model.tables) {
    for (const target of table.offersMissing || []) {
      const name = `${target.table ?? ''}[${target.name}]`;
      entries.push({
        key: `broken-nameof|${table.ref ?? `table:${table.name}`}|${name}`,
        text: `${table.name} offers ${name}, which does not exist`,
      });
    }
  }
  return finding('broken-nameof', entries, {
    severity: 'error',
    none: 'Every field a field parameter offers exists',
    some: (n) => `${plural(n, 'field parameter entry', 'field parameter entries')} naming a field that does not exist`,
  });
}

/**
 * Visuals pointing at a measure the model does not have.
 *
 * A different defect from `broken`, and a quieter one. A measure whose DAX reads a deleted
 * column errors outright; a visual whose conditional format or dynamic label references a
 * deleted measure renders the default and says nothing. That silence is why these survive
 * — a card meant to show a dynamic title shows a blank one, and nobody files a bug.
 *
 * Two things have to be read before this can be reported honestly, and getting either
 * wrong turns the rule into an accusation:
 *
 *  - `reportExtensions.json`. A report can define measures of its own, usually against a
 *    live connection. They are not in the semantic model and they are not missing.
 *  - Field parameters. A measure offered by one is referenced through the parameter's
 *    DAX, so it must be resolvable the same way any other reference is.
 *
 * Reported, not failed, by default. It is a genuine defect rather than a judgement call,
 * but it does not break a refresh or error a visual, so it does not belong in the same
 * bucket as a measure that cannot evaluate. Add it to `--fail-on` to gate on it.
 */
function danglingVisualRefs(model) {
  const fold = (text) => String(text).toLowerCase();

  // Qualified and bare, because a reference may name a table that was itself renamed.
  const known = new Set();
  for (const measure of model.measures) {
    known.add(fold(`${measure.table}[${measure.name}]`));
    known.add(fold(measure.name));
  }
  for (const measure of model.reportMeasures || []) {
    known.add(fold(`${measure.table}[${measure.name}]`));
    known.add(fold(measure.name));
  }
  const columns = new Set(model.columns.map((c) => fold(`${c.table}[${c.name}]`)));

  const seen = new Set();
  const entries = [];
  for (const visual of model.visuals) {
    for (const field of visual.fields || []) {
      if (field.kind !== 'measure' || !field.name) continue;
      const qualified = `${field.table}[${field.name}]`;
      if (known.has(fold(qualified)) || known.has(fold(field.name))) continue;
      // A name that exists as a column is a mislabelled reference, not a missing one.
      if (columns.has(fold(qualified))) continue;

      const where = `${visual.title || visual.type || visual.id} on ${pageName(model, visual.page)}`;
      const line = `${qualified} — referenced by ${where} (${field.via ?? 'unknown route'})`;
      if (seen.has(line)) continue;
      seen.add(line);
      entries.push({ key: `dangling-visuals|${visual.key ?? visual.ref}|${qualified}`, text: line });
    }
  }

  return finding('dangling-visuals', entries, {
    severity: 'warn',
    none: 'Every measure a visual references exists',
    some: (n) => `${plural(n, 'visual reference')} to a measure that does not exist`,
  });
}

/**
 * Measures nothing reaches — not even indirectly.
 *
 * Reachability, not direct binding. A base measure that ten shown measures build on is
 * doing more work than most, and "no visual shows it" is true of it in the same way it is
 * true of a genuinely dead measure. On one real model the direct-only reading called 101
 * measures unused when 90 of them were consumed by another measure; the honest number
 * was 11.
 *
 * The count is only trustworthy at all because field references are collected from
 * dynamic titles, conditional formatting and button actions as well as `queryState` —
 * read from `queryState` alone it roughly doubles. Both mistakes point the same way, and
 * a tool that invites you to delete a live measure is worse than one that says nothing.
 */
function unusedMeasures(model) {
  const entries = unreachableMeasures(model).map((measure) => ({
    key: `unused|${measure.ref ?? `measure:${measure.table}[${measure.name}]`}`,
    text: `${measure.table}[${measure.name}]`,
  }));

  return finding('unused', entries, {
    severity: 'warn',
    none: 'Every measure is shown somewhere',
    some: (n) => `${plural(n, 'measure')} no visual shows`,
  });
}

/**
 * Columns that read from a source the tool could not trace.
 *
 * Only `sourceless: unresolved`. A field parameter's columns, a calculation group's, a
 * calculated column and a column added in Power Query have no source by definition, and a
 * rule that fires on every one of them gets muted on day one. This one lists the real
 * gaps, and with a baseline it fails only when the list grows.
 */
function unresolvedColumns(model) {
  const entries = model.columns
    .filter((column) => column.sourceless === 'unresolved')
    .map((column) => ({
      key: `unresolved|${column.ref ?? `column:${column.table}[${column.name}]`}`,
      text: `${column.table}[${column.name}] — ${column.reason ?? 'no physical source could be traced'}`,
    }));
  return finding('unresolved', entries, {
    severity: 'warn',
    none: 'Every source-backed column is traced',
    some: (n) => `${plural(n, 'column')} whose source could not be traced`,
  });
}

/**
 * Measures with no path to a visual, following measure-to-measure references.
 *
 * Walks backwards from everything a visual shows, marking whatever it depends on as
 * reached. What is left over is unreachable.
 */
function unreachableMeasures(model) {
  const byRef = new Map(model.measures.map((measure) => [measure.ref, measure]));

  // A DAX reference can be written `Table[Measure]` or bare `[Measure]`, and the bare
  // form is the common one. Names are unique across a model, so a name index resolves it —
  // case-insensitively, because DAX is: an exact-case lookup lost every reference spelled
  // differently from its definition, and called the measure behind it unused.
  const byName = new Map();
  const byFoldedRef = new Map();
  for (const measure of model.measures) {
    if (!byName.has(measure.name.toLowerCase())) byName.set(measure.name.toLowerCase(), measure);
    byFoldedRef.set(measure.ref.toLowerCase(), measure);
  }

  const resolve = (reference) => {
    const direct = byRef.get(`measure:${reference}`) ?? byFoldedRef.get(`measure:${reference}`.toLowerCase());
    if (direct) return direct;
    const bare = /\[(.*)\]$/.exec(reference)?.[1] ?? reference;
    return byName.get(bare.toLowerCase()) ?? null;
  };

  const reached = new Set();
  const queue = model.measures.filter((measure) => measure.usedByVisuals.length > 0);
  for (const measure of queue) reached.add(measure.ref);

  while (queue.length > 0) {
    const measure = queue.pop();
    for (const reference of measure.dependsOn.measures) {
      const target = resolve(reference);
      if (!target || reached.has(target.ref)) continue;
      reached.add(target.ref);
      queue.push(target);
    }
  }

  return model.measures.filter((measure) => !reached.has(measure.ref));
}

/**
 * How much of the model can be traced back to a physical source column.
 *
 * The denominator is columns that read from a source, not every column. A DAX calculated
 * column has no physical origin by definition, so counting it against coverage would
 * penalise a model for containing calculations.
 */
function coverage(model, minCoverage) {
  const value = model.stats?.confidence?.coverage ?? null;
  if (value == null) {
    return { rule: 'coverage', severity: 'ok', summary: 'Source coverage not measured', items: [], entries: [] };
  }

  const percent = Math.round(value * 100);
  const below = minCoverage != null && value < minCoverage;

  return {
    rule: 'coverage',
    severity: below ? 'error' : 'ok',
    summary: below
      ? `${percent}% of source-backed columns traced, below the ${Math.round(minCoverage * 100)}% required`
      : `${percent}% of source-backed columns traced to a physical column`,
    items: below
      ? model.columns.filter((c) => !c.physicalPath).map((c) => `${c.table}[${c.name}] — ${c.reason ?? 'unresolved'}`)
      : [],
    entries: [],
  };
}

/**
 * Visuals that are hidden and that no bookmark ever reveals.
 *
 * Hidden on its own means nothing: most hidden visuals are one button press from being
 * shown. Only the ones no named state brings back are genuinely dead, which is why this
 * needs bookmarks parsed to be worth reporting at all.
 */
function deadVisuals(model) {
  const entries = model.visuals
    .filter((visual) => visual.neverShown)
    .map((visual) => ({
      key: `dead-visuals|${visual.key ?? visual.ref ?? visual.id}`,
      text: `${visual.title || visual.type || visual.id} on page ${pageName(model, visual.page)}`,
    }));

  return finding('dead-visuals', entries, {
    severity: 'warn',
    none: 'Every hidden visual has a bookmark that reveals it',
    some: (n) => `${plural(n, 'hidden visual')} no bookmark reveals`,
  });
}

function pageName(model, pageId) {
  return model.pages.find((page) => page.id === pageId)?.name ?? pageId;
}

/**
 * Decide the exit code.
 * @param {Array} findings
 * @param {Set<string>} failOn - Rule names that should fail the build.
 */
export function exitCodeFor(findings, failOn = DEFAULT_FAIL_ON) {
  const failed = findings.some((finding) => finding.items.length > 0 && failOn.has(finding.rule));
  return failed ? 1 : 0;
}

/**
 * Checks across a workspace.
 *
 * Model-level rules — broken references, NAMEOF entries, unresolved columns, coverage —
 * run once per model however many reports read it, keyed by the model. Report-level rules
 * run per report, keyed by the report. `unused` is the exception: a measure one thin
 * report never shows may be the headline of another, so across a workspace a measure is
 * unused only if no report reading its model reaches it.
 *
 * @param {Array<object>} models - Viewer models, one per report (and per unused model).
 * @param {object} [options] - As runChecks().
 */
export function runEstateChecks(models, { minCoverage = null } = {}) {
  const groups = new Map();
  for (const model of models) {
    const key = model.meta?.modelKey ?? model.meta?.modelName ?? '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(model);
  }

  const collected = new Map(RULES.map((rule) => [rule, []]));
  const scoped = (scope, entries) => entries.map((entry) => ({
    key: `${scope}::${entry.key}`,
    text: `${scope}: ${entry.text}`,
  }));
  const coverageLines = [];
  let below = false;

  for (const [modelKey, group] of groups) {
    const first = group[0];
    const modelFindings = runChecks(first, { minCoverage });
    for (const rule of ['broken', 'broken-nameof', 'unresolved']) {
      collected.get(rule).push(...scoped(modelKey, modelFindings.find((f) => f.rule === rule).entries));
    }

    const cover = modelFindings.find((f) => f.rule === 'coverage');
    coverageLines.push(`${modelKey}: ${cover.summary}`);
    if (cover.severity === 'error') below = true;

    // Unused only where every report over this model agrees.
    const reports = group.filter((model) => model.meta?.reportKey);
    const unusedSets = (reports.length > 0 ? reports : [first])
      .map((model) => new Set(unreachableMeasures(model).map((measure) => measure.ref)));
    const unused = first.measures.filter((measure) => unusedSets.every((set) => set.has(measure.ref)));
    collected.get('unused').push(...scoped(modelKey, unused.map((measure) => ({
      key: `unused|${measure.ref}`,
      text: `${measure.table}[${measure.name}]`,
    }))));

    for (const report of reports) {
      const reportFindings = runChecks(report);
      for (const rule of ['dangling-visuals', 'dead-visuals']) {
        collected.get(rule).push(...scoped(report.meta.reportKey, reportFindings.find((f) => f.rule === rule).entries));
      }
    }
  }

  const template = new Map(runChecks({ tables: [], columns: [], measures: [], visuals: [], pages: [] })
    .map((f) => [f.rule, f]));
  const describe = {
    broken: (n) => plural(n, 'broken reference'),
    'broken-nameof': (n) => `${plural(n, 'field parameter entry', 'field parameter entries')} naming a field that does not exist`,
    'dangling-visuals': (n) => `${plural(n, 'visual reference')} to a measure that does not exist`,
    unused: (n) => `${plural(n, 'measure')} no report shows`,
    unresolved: (n) => `${plural(n, 'column')} whose source could not be traced`,
    'dead-visuals': (n) => `${plural(n, 'hidden visual')} no bookmark reveals`,
  };
  const severity = { broken: 'error', 'broken-nameof': 'error' };

  return RULES.map((rule) => {
    if (rule === 'coverage') {
      return {
        rule,
        severity: below ? 'error' : 'ok',
        summary: below ? 'Source coverage below the required minimum in at least one model' : 'Source coverage per model',
        items: below ? coverageLines : [],
        entries: [],
        details: coverageLines,
      };
    }
    return finding(rule, collected.get(rule), {
      severity: severity[rule] ?? 'warn',
      none: template.get(rule).summary,
      some: describe[rule],
    });
  });
}
