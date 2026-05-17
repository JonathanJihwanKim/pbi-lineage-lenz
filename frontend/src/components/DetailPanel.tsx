import { useEffect, useState } from "react";
import hljs from "highlight.js/lib/core";
import sql from "highlight.js/lib/languages/sql";

import { api } from "../api/client";
import type { Confidence, GraphNode, TableDetail } from "../api/types";
import { useStore } from "../store";
import { cardinalityGlyph } from "../graph/edgeStyles";
import { connectorToGlyphId } from "../graph/connectorGlyphs";

hljs.registerLanguage("sql", sql);

export function DetailPanel() {
  const selection = useStore((s) => s.selection);
  const selectionHistory = useStore((s) => s.selectionHistory);
  const measureGraph = useStore((s) => s.measureGraph);
  const measureGraphLoading = useStore((s) => s.measureGraphLoading);
  const clearSelection = useStore((s) => s.clearSelection);
  const pinSelection = useStore((s) => s.pinSelection);
  const goBack = useStore((s) => s.goBack);
  const depth = useStore((s) => s.depth);
  const pushInfoToast = useStore((s) => s.pushInfoToast);

  if (!selection) return null;

  async function copyMarkdown() {
    if (!selection) return;
    try {
      const md =
        selection.kind === "measure" && selection.table
          ? await api.measureMarkdown(selection.table, selection.name, depth)
          : await api.tableMarkdown(selection.name);
      await navigator.clipboard.writeText(md);
      pushInfoToast("Markdown copied");
    } catch (e) {
      pushInfoToast(`Copy failed: ${(e as Error).message}`);
    }
  }

  return (
    <aside className="detail-panel">
      <ResizeHandle />
      {selectionHistory.length > 0 && (
        <Breadcrumbs history={selectionHistory} current={selection.name} />
      )}
      <div className="detail-header">
        <div>
          <div className="detail-kind">
            {selection.kind === "measure" ? "Measure" : "Table"}
          </div>
          <div className="detail-name">{selection.name}</div>
          {selection.table && <div className="detail-sub">{selection.table}</div>}
        </div>
        <div className="detail-actions">
          {selectionHistory.length > 0 && (
            <button onClick={() => void goBack()} title="Back to previous selection">
              ← Back
            </button>
          )}
          <button onClick={pinSelection} title="Pin to compare with another selection">
            Pin
          </button>
          <button
            onClick={() => void copyMarkdown()}
            title="Copy a Markdown handoff card for PR / Jira / Slack"
          >
            Copy MD
          </button>
          <button onClick={clearSelection} aria-label="Close" className="icon-btn">
            ×
          </button>
        </div>
      </div>

      {selection.kind === "measure" && (
        <MeasureDetails loading={measureGraphLoading} graph={measureGraph} />
      )}
      {selection.kind === "table" && <TableDetailsLoader name={selection.name} />}
    </aside>
  );
}

/** Inline source-identifier chip: connector glyph + truncated source path +
 *  optional confidence badge. Used in the detail panel's direct/indirect lists
 *  so each row carries both the semantic name (above, by the caller) and the
 *  data-engineer view (this component, beneath). */
function SourceIdentifier({
  label,
  connector,
  confidence,
}: {
  label: string;
  connector: string | null;
  confidence: Confidence | null;
}) {
  const glyphId = connectorToGlyphId(connector);
  return (
    <div className="source-id" title={connector ? `${connector} · ${label}` : label}>
      <svg className="source-id-glyph" viewBox="0 0 14 14" width="11" height="11" aria-hidden>
        <use href={`#${glyphId}`} />
      </svg>
      <span className="source-id-text mono">{label}</span>
      {confidence && (
        <span className={`badge mini conf-${confidence}`} title={`Confidence: ${confidence}`}>
          {confidence}
        </span>
      )}
    </div>
  );
}

/** Renders a measure-graph table row: semantic name on top, inline source-id
 *  beneath if one was resolved. Pure presentation — extracted so both Direct
 *  and Indirect lists render the dual-name UX consistently. */
function TableRowWithSource({
  semantic,
  meta,
  badges,
}: {
  semantic: string;
  meta?: { source_label: string | null; source_connector: string | null; source_confidence: Confidence | null };
  badges?: React.ReactNode;
}) {
  return (
    <div className="dual-table-row">
      <div className="dual-table-name">
        <strong>{semantic}</strong>
        {badges}
      </div>
      {meta?.source_label && (
        <SourceIdentifier
          label={meta.source_label}
          connector={meta.source_connector}
          confidence={meta.source_confidence}
        />
      )}
    </div>
  );
}

/** Drill-down trail. Each crumb is clickable; we pop goBack repeatedly until
 *  we land on the chosen ancestor. */
function Breadcrumbs({
  history,
  current,
}: {
  history: import("../store").Selection[];
  current: string;
}) {
  const goBack = useStore((s) => s.goBack);
  const jumpTo = async (targetIdx: number) => {
    const popsNeeded = history.length - targetIdx;
    for (let i = 0; i < popsNeeded; i++) await goBack();
  };
  return (
    <div className="detail-breadcrumbs" aria-label="Drill-down trail">
      {history.map((h, i) => (
        <span key={`${h.kind}-${h.table ?? ""}-${h.name}-${i}`}>
          <button onClick={() => void jumpTo(i)} title={`Back to ${h.name}`}>
            {h.name}
          </button>
          <span className="crumb-sep"> › </span>
        </span>
      ))}
      <span className="crumb-current">{current}</span>
    </div>
  );
}

/** Drag handle on the left edge of the detail panel. Updates a CSS variable
 *  on document root and persists the chosen width to localStorage. */
function ResizeHandle() {
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      const w = Math.min(720, Math.max(360, window.innerWidth - e.clientX));
      document.documentElement.style.setProperty("--right-panel-width", `${w}px`);
    };
    const onUp = () => {
      setDragging(false);
      const cur = document.documentElement.style.getPropertyValue("--right-panel-width");
      const px = cur.replace("px", "").trim();
      if (px) localStorage.setItem("model-lenz-right-panel-width", px);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
  }, [dragging]);

  return (
    <div
      className={`resize-handle${dragging ? " dragging" : ""}`}
      onMouseDown={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      title="Drag to resize"
    />
  );
}

function MeasureDetails({
  loading,
  graph,
}: {
  loading: boolean;
  graph: ReturnType<typeof useStore.getState>["measureGraph"];
}) {
  if (loading || !graph) return <p className="muted">Loading…</p>;

  const metaByTable = new Map<string, GraphNode>(
    graph.direct_table_meta.map((m) => [m.label, m]),
  );

  return (
    <div className="detail-body">
      <Section title="DAX expression">
        <pre className="dax">{graph.measure.expression || "(empty)"}</pre>
        <div className="meta-row">
          {graph.measure.formatString && (
            <Meta label="Format" value={graph.measure.formatString} />
          )}
          {graph.measure.displayFolder && (
            <Meta label="Folder" value={graph.measure.displayFolder} />
          )}
        </div>
      </Section>

      <Section title={`Direct tables (${graph.direct_tables.length})`}>
        {graph.direct_tables.length === 0 && <p className="muted">None</p>}
        <ul className="list table-list">
          {graph.direct_tables.map((t) => {
            const viaSeed = isReferencedBySeed(t, graph);
            const viaRefs = referencingMeasures(t, graph.referenced_measures, "direct");
            const meta = metaByTable.get(t);
            return (
              <li key={t} className="table-row">
                <TableRowWithSource
                  semantic={t}
                  meta={
                    meta
                      ? {
                          source_label: meta.source_label,
                          source_connector: meta.source_connector,
                          source_confidence: meta.source_confidence,
                        }
                      : undefined
                  }
                  badges={
                    <>
                      {viaSeed && <span className="badge mini direct-self">in this DAX</span>}
                      {viaRefs.map((r) => (
                        <span key={r} className="badge mini via">
                          via {r}
                        </span>
                      ))}
                    </>
                  }
                />
              </li>
            );
          })}
        </ul>
      </Section>

      {graph.referenced_measures.length > 0 && (
        <Section title={`Referenced measures (${graph.referenced_measures.length})`}>
          <ul className="list ref-measure-list">
            {graph.referenced_measures.map((m) => (
              <li
                key={`${m.table}::${m.name}`}
                className="ref-measure-item"
                onClick={() => void useStore.getState().drillIntoMeasure(m.table, m.name)}
                title={`Open ${m.name}`}
              >
                <div className="ref-measure-head">
                  <strong>{m.name}</strong>
                  <span className="muted"> · {m.table}</span>
                </div>
                {m.expression && (
                  <pre className="dax dax-mini">{trimDax(m.expression)}</pre>
                )}
                <div className="ref-measure-counts">
                  <span className="badge mini">→ {m.direct_table_count} direct</span>
                  <span className="badge mini">→ {m.indirect_table_count} indirect</span>
                  <span className="muted">click to drill in</span>
                </div>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {graph.userel_hints.length > 0 && (
        <Section title="USERELATIONSHIP overrides">
          <ul className="list">
            {graph.userel_hints.map((h, i) => (
              <li key={i}>
                <code className="mono">{h.from}</code> → <code className="mono">{h.to}</code>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title={`Indirect tables (${graph.indirect_tables.length})`}>
        {graph.indirect_tables.length === 0 && (
          <p className="muted">No tables reachable through relationships.</p>
        )}
        <ul className="list indirect-list">
          {graph.indirect_tables.map((it) => {
            const viaRefs = referencingMeasures(
              it.table,
              graph.referenced_measures,
              "indirect",
            );
            return (
            <li key={it.table}>
              <div className="indirect-head">
                <TableRowWithSource
                  semantic={it.table}
                  meta={{
                    source_label: it.source_label,
                    source_connector: it.source_connector,
                    source_confidence: it.source_confidence,
                  }}
                  badges={
                    <>
                      <span className="badge">d{it.depth}</span>
                      {it.ambiguous && <span className="badge ambiguous">ambiguous</span>}
                      {it.crosses_fact && <span className="badge warn">crosses fact</span>}
                      {viaRefs.map((r) => (
                        <span key={r} className="badge mini via">
                          via {r}
                        </span>
                      ))}
                    </>
                  }
                />
              </div>
              {it.paths.map((p, i) => (
                <div key={i} className="path">
                  {p.hops.map((h, j) => (
                    <span key={j}>
                      <code className="mono">
                        {h.from_table}[{h.from_column}]
                      </code>
                      <span className="path-arrow">
                        {" "}
                        →({cardinalityGlyph(h.cardinality)}){h.crossfilter === "both" ? "↔" : ""}{" "}
                        {!h.is_active && "(inactive) "}
                      </span>
                      {j === p.hops.length - 1 && (
                        <code className="mono">
                          {h.to_table}[{h.to_column}]
                        </code>
                      )}
                    </span>
                  ))}
                </div>
              ))}
            </li>
            );
          })}
        </ul>
      </Section>

      {graph.warnings.length > 0 && (
        <Section title="Warnings">
          <ul className="list warn-list">
            {graph.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}

function TableDetailsLoader({ name }: { name: string }) {
  const [detail, setDetail] = useState<TableDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDetail(null);
    setError(null);
    api.tableDetail(name).then(setDetail).catch((e) => setError(String(e)));
  }, [name]);

  if (error) return <p className="muted">Error: {error}</p>;
  if (!detail) return <p className="muted">Loading…</p>;

  const t = detail.table;
  const lineage = t.partitions[0]?.source_lineage;

  return (
    <div className="detail-body">
      <ViewBanner kind="pbi" />
      <Section title="Classification">
        <span className={`chip on dot-${t.classification}`}>{t.classification}</span>
        {t.is_hidden && <span className="badge">hidden</span>}
      </Section>

      <ViewBanner kind="de" />
      {lineage ? (
        <Section title="Source lineage">
          <div className="lineage-card">
            <div className="lineage-row">
              <span className="muted">Connector</span>
              <span>{lineage.connector ?? "—"}</span>
            </div>
            <div className="lineage-row">
              <span className="muted">Schema</span>
              <span>{lineage.schema ?? "—"}</span>
            </div>
            <div className="lineage-row">
              <span className="muted">Table</span>
              <span>{lineage.table ?? "—"}</span>
            </div>
            <div className="lineage-row">
              <span className="muted">Confidence</span>
              <span className={`badge conf-${lineage.confidence}`}>{lineage.confidence}</span>
            </div>
            {lineage.upstream_expressions.length > 0 && (
              <div className="lineage-row">
                <span className="muted">Upstream</span>
                <span>{lineage.upstream_expressions.join(" → ")}</span>
              </div>
            )}
            {lineage.sql && (
              <pre
                className="sql"
                dangerouslySetInnerHTML={{
                  __html: hljs.highlight(lineage.sql, { language: "sql" }).value,
                }}
              />
            )}
            {lineage.transformed_steps.length > 0 && (
              <div className="lineage-row">
                <span className="muted">Steps</span>
                <span>{lineage.transformed_steps.join(" → ")}</span>
              </div>
            )}
          </div>
        </Section>
      ) : (
        <Section title="Source lineage">
          <p className="muted">
            No source detected — this is likely a calculated table, a manually
            entered table, or a parameter.
          </p>
        </Section>
      )}

      <ViewBanner kind="pbi" />
      <Section title={`Columns (${t.columns.length})`}>
        <ul className="list compact">
          {t.columns.slice(0, 20).map((c) => (
            <li key={c.name}>
              <strong>{c.name}</strong>
              <span className="muted"> · {c.data_type ?? "?"}</span>
              {c.is_fk && <span className="badge mini">FK</span>}
              {c.is_hidden && <span className="badge mini">hidden</span>}
              {c.expression && <span className="badge mini">calc</span>}
            </li>
          ))}
          {t.columns.length > 20 && (
            <li className="muted">… {t.columns.length - 20} more</li>
          )}
        </ul>
      </Section>

      {t.measures.length > 0 && (
        <Section title={`Measures hosted (${t.measures.length})`}>
          <ul className="list compact">
            {t.measures.slice(0, 12).map((m) => (
              <li key={m.name}>{m.name}</li>
            ))}
            {t.measures.length > 12 && (
              <li className="muted">… {t.measures.length - 12} more</li>
            )}
          </ul>
        </Section>
      )}

      <Section title={`Relationships (${detail.relationships.length})`}>
        <ul className="list compact">
          {detail.relationships.map((r) => (
            <li key={r.id}>
              <code className="mono">
                {r.from_table}[{r.from_column}]
              </code>{" "}
              →({cardinalityGlyph(r.cardinality)}){r.crossfilter === "both" ? "↔" : ""}{" "}
              <code className="mono">
                {r.to_table}[{r.to_column}]
              </code>
              {!r.is_active && <span className="badge mini">inactive</span>}
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}

/** Small horizontal banner labeling the next set of sections as either the
 *  Power BI developer view (semantic-model-side info) or the data engineer
 *  view (source-system-side info). Helps both audiences orient themselves
 *  without a stateful toggle. */
function ViewBanner({ kind }: { kind: "pbi" | "de" }) {
  if (kind === "pbi") {
    return (
      <div className="view-banner view-banner-pbi">
        <span className="view-banner-dot" aria-hidden />
        Power BI developer view
      </div>
    );
  }
  return (
    <div className="view-banner view-banner-de">
      <span className="view-banner-dot" aria-hidden />
      Data engineer view
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="detail-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <span className="meta-pill">
      <span className="muted">{label}:</span> {value}
    </span>
  );
}

function trimDax(expr: string): string {
  // Show at most the first 6 lines so the inline preview stays compact.
  const lines = expr.trim().split("\n");
  if (lines.length <= 6) return lines.join("\n");
  return lines.slice(0, 6).join("\n") + "\n…";
}

/** Did the seed measure's own DAX directly mention this table?
 *
 * We can't ask "is `table` in graph.measure.expression?" because table names
 * containing brackets/quotes need a parser. Instead infer it: a table appears
 * in `direct_tables` either because the seed mentions it directly OR because
 * a referenced measure mentions it. If at least one referenced measure has
 * the table in its `direct_tables`, AND nothing else differentiates, we can't
 * be 100% sure - but we approximate: a table is "in this DAX" iff it does NOT
 * appear in any referenced measure's direct_tables.
 *
 * This isn't perfect (a table could appear in BOTH the seed and a ref) but
 * the badge is informational, not load-bearing - the goal is to flag
 * "this came in via a sub-measure" cases for the user.
 */
function isReferencedBySeed(
  table: string,
  graph: ReturnType<typeof useStore.getState>["measureGraph"],
): boolean {
  if (!graph) return false;
  const refIntroduced = graph.referenced_measures.some((m) =>
    m.direct_tables.includes(table),
  );
  return !refIntroduced;
}

/** Names of referenced measures whose direct (or indirect) tables include this table. */
function referencingMeasures(
  table: string,
  refs: import("../api/types").MeasureRef[],
  kind: "direct" | "indirect",
): string[] {
  const list = refs.filter((m) =>
    kind === "direct"
      ? m.direct_tables.includes(table)
      : m.indirect_tables.includes(table),
  );
  return list.map((m) => m.name);
}
