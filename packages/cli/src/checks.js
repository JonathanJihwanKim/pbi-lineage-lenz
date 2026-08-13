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
export const RULES = ['broken', 'dangling-visuals', 'unused', 'coverage', 'dead-visuals'];

/** Rules that fail the build unless told otherwise. */
export const DEFAULT_FAIL_ON = new Set(['broken']);

/**
 * @param {object} model - Viewer model.
 * @param {object} [options]
 * @param {number|null} [options.minCoverage] - Fraction 0..1.
 * @returns {{rule: string, severity: string, summary: string, items: string[]}[]}
 */
export function runChecks(model, { minCoverage = null } = {}) {
  return [
    brokenReferences(model),
    danglingVisualRefs(model),
    unusedMeasures(model),
    coverage(model, minCoverage),
    deadVisuals(model),
  ];
}

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

  const items = [];
  for (const measure of model.measures) {
    const from = `${measure.table}[${measure.name}]`;

    for (const ref of measure.dependsOn.columns) {
      if (qualified.has(fold(ref)) || bareNames.has(nameOf(ref))) continue;
      items.push(`${from} reads ${ref}, which does not exist`);
    }

    for (const ref of measure.dependsOn.measures) {
      if (qualified.has(fold(ref)) || bareNames.has(nameOf(ref))) continue;
      items.push(`${from} calls ${ref}, which does not exist`);
    }

    for (const table of measure.dependsOn.tables) {
      if (!tables.has(fold(table))) items.push(`${from} reads table ${table}, which does not exist`);
    }
  }

  return {
    rule: 'broken',
    severity: items.length > 0 ? 'error' : 'ok',
    summary: items.length === 0
      ? 'No broken references'
      : `${items.length} broken reference${items.length === 1 ? '' : 's'}`,
    items,
  };
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
  const items = [];
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
      items.push(line);
    }
  }

  return {
    rule: 'dangling-visuals',
    severity: items.length > 0 ? 'warn' : 'ok',
    summary: items.length === 0
      ? 'Every measure a visual references exists'
      : `${items.length} visual reference${items.length === 1 ? '' : 's'} to a measure that does not exist`,
    items,
  };
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
  const items = unreachableMeasures(model).map((measure) => `${measure.table}[${measure.name}]`);

  return {
    rule: 'unused',
    severity: items.length > 0 ? 'warn' : 'ok',
    summary: items.length === 0
      ? 'Every measure is shown somewhere'
      : `${items.length} measure${items.length === 1 ? '' : 's'} no visual shows`,
    items,
  };
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
  // form is the common one. Names are unique across a model, so a name index resolves it.
  const byName = new Map();
  for (const measure of model.measures) {
    if (!byName.has(measure.name)) byName.set(measure.name, measure);
  }

  const resolve = (reference) => {
    const direct = byRef.get(`measure:${reference}`);
    if (direct) return direct;
    const bare = /\[(.*)\]$/.exec(reference)?.[1] ?? reference;
    return byName.get(bare) ?? null;
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
    return { rule: 'coverage', severity: 'ok', summary: 'Source coverage not measured', items: [] };
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
  const items = model.visuals
    .filter((visual) => visual.neverShown)
    .map((visual) => `${visual.title || visual.type || visual.id} on page ${pageName(model, visual.page)}`);

  return {
    rule: 'dead-visuals',
    severity: items.length > 0 ? 'warn' : 'ok',
    summary: items.length === 0
      ? 'Every hidden visual has a bookmark that reveals it'
      : `${items.length} hidden visual${items.length === 1 ? '' : 's'} no bookmark reveals`,
    items,
  };
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
