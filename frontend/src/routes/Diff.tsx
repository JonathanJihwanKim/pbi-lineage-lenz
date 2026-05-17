/**
 * `/diff` route — the v0.3 PBIP diff view.
 *
 * Renders a structured list of every changed entity between the two PBIPs
 * the CLI was launched against. Measures, tables, and relationships each get
 * their own section with three sub-groups (added / modified / removed).
 * Modified measures show base and head DAX side by side; modified tables
 * show source-lineage and column deltas.
 *
 * Graph-canvas overlay is deferred to v0.3.x — for v0.3.0 this list view is
 * the MVP that covers the "what changed?" question end-to-end.
 */

import { useEffect, useMemo, useState } from "react";

import { api } from "../api/client";
import type {
  ColumnDiff,
  DiffPayload,
  DiffStatus,
  MeasureDiff,
  RelationshipDiff,
  TableDiff,
} from "../api/types";
import { useStore } from "../store";

export function DiffView() {
  const [payload, setPayload] = useState<DiffPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [swapped, setSwapped] = useState(false);

  useEffect(() => {
    api
      .diff()
      .then(setPayload)
      .catch((e: Error) => setError(e.message));
  }, []);

  const view = useMemo(
    () => (payload ? (swapped ? swapPayload(payload) : payload) : null),
    [payload, swapped],
  );

  return (
    <div className="diff-app">
      <DiffTopBar />
      {error && (
        <div className="overlay error">
          <strong>Diff failed:</strong> {error}
        </div>
      )}
      {!error && !view && <div className="overlay">Computing diff…</div>}
      {view && (
        <>
          <DiffHeader
            payload={view}
            swapped={swapped}
            onSwap={() => setSwapped((s) => !s)}
          />
          <main className="diff-body">
            <DiffMeasures items={view.measures} />
            <DiffTables items={view.tables} />
            <DiffRelationships items={view.relationships} />
            {view.measures.length === 0 &&
              view.tables.length === 0 &&
              view.relationships.length === 0 && (
                <div className="diff-empty">
                  <h3>No changes</h3>
                  <p className="muted">
                    BASE and HEAD parse to identical semantic models.
                  </p>
                </div>
              )}
          </main>
        </>
      )}
    </div>
  );
}

// --------------------------------------------------------------------------
// Top bar — reuses the brand chrome from the model view's <Header>
// --------------------------------------------------------------------------

function DiffTopBar() {
  const theme = useStore((s) => s.theme);
  const toggleTheme = useStore((s) => s.toggleTheme);
  return (
    <header className="header">
      <div className="header-brand">
        <span className="header-logo" aria-hidden>
          <svg viewBox="0 0 24 24" width="20" height="20">
            <circle
              cx="11"
              cy="11"
              r="6"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            />
            <line
              x1="16"
              y1="16"
              x2="20"
              y2="20"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
        </span>
        <span className="header-title">Model Lenz</span>
        <span className="header-pbip">Diff view</span>
      </div>
      <div />
      <div className="header-controls">
        <a className="link-back" href="/" title="Back to single-model view">
          ← Single model
        </a>
        <div className="control-group">
          <span className="control-label">Theme</span>
          <div className="seg-toggle" role="group" aria-label="Theme">
            <button
              aria-pressed={theme === "dark"}
              className={theme === "dark" ? "active" : ""}
              onClick={() => theme !== "dark" && toggleTheme()}
              title="Dark theme"
            >
              Dark
            </button>
            <button
              aria-pressed={theme === "light"}
              className={theme === "light" ? "active" : ""}
              onClick={() => theme !== "light" && toggleTheme()}
              title="Light theme"
            >
              Light
            </button>
          </div>
        </div>
      </div>
    </header>
  );
}

// --------------------------------------------------------------------------
// Diff header — BASE/HEAD pills, counts, swap
// --------------------------------------------------------------------------

function DiffHeader({
  payload,
  swapped,
  onSwap,
}: {
  payload: DiffPayload;
  swapped: boolean;
  onSwap: () => void;
}) {
  const c = payload.counts;
  // The default-branch pin only follows BASE when we haven't swapped — if the
  // user swapped, neither side carries the "this is main" semantic anymore.
  const showPin = payload.base_is_default_branch && !swapped;
  return (
    <div className="diff-header">
      <div className="diff-pill diff-pill-base" title={payload.base_path}>
        <span className="diff-pill-kind">BASE</span>
        <span className="diff-pill-label">{payload.base_label}</span>
        {showPin && (
          <span
            className="diff-pin"
            title="Default branch (origin/HEAD)"
            aria-label="default branch"
          >
            ★
          </span>
        )}
      </div>
      <button className="diff-swap" onClick={onSwap} title="Swap BASE and HEAD">
        ⇄
      </button>
      <div className="diff-pill diff-pill-head" title={payload.head_path}>
        <span className="diff-pill-kind">HEAD</span>
        <span className="diff-pill-label">{payload.head_label}</span>
      </div>
      <div className="diff-summary">
        <SummaryChip kind="added" count={c.measures_added + c.tables_added + c.relationships_added} />
        <SummaryChip
          kind="modified"
          count={c.measures_modified + c.tables_modified + c.relationships_modified}
        />
        <SummaryChip
          kind="removed"
          count={c.measures_removed + c.tables_removed + c.relationships_removed}
        />
      </div>
    </div>
  );
}

function SummaryChip({ kind, count }: { kind: DiffStatus; count: number }) {
  return (
    <span className={`diff-summary-chip diff-${kind}`}>
      <span className="diff-summary-dot" aria-hidden />
      {count} {kind}
    </span>
  );
}

// --------------------------------------------------------------------------
// Measures
// --------------------------------------------------------------------------

function DiffMeasures({ items }: { items: MeasureDiff[] }) {
  if (items.length === 0) return null;
  const groups = groupByStatus(items);
  return (
    <section className="diff-section">
      <h2>
        Measures <span className="muted">({items.length})</span>
      </h2>
      <StatusGroup
        kind="added"
        items={groups.added}
        render={(m) => <MeasureRowAdded key={key(m)} m={m} />}
      />
      <StatusGroup
        kind="modified"
        items={groups.modified}
        render={(m) => <MeasureRowModified key={key(m)} m={m} />}
      />
      <StatusGroup
        kind="removed"
        items={groups.removed}
        render={(m) => <MeasureRowRemoved key={key(m)} m={m} />}
      />
    </section>
  );

  function key(m: MeasureDiff) {
    return `${m.table}::${m.name}`;
  }
}

function MeasureRowAdded({ m }: { m: MeasureDiff }) {
  return (
    <div className="diff-row diff-row-added">
      <div className="diff-row-head">
        <strong>{m.name}</strong>
        <span className="muted"> · {m.table}</span>
      </div>
      {m.head?.expression && <pre className="dax dax-added">{m.head.expression}</pre>}
    </div>
  );
}

function MeasureRowRemoved({ m }: { m: MeasureDiff }) {
  return (
    <div className="diff-row diff-row-removed">
      <div className="diff-row-head">
        <strong>{m.name}</strong>
        <span className="muted"> · {m.table}</span>
      </div>
      {m.before?.expression && (
        <pre className="dax dax-removed">{m.before.expression}</pre>
      )}
    </div>
  );
}

function MeasureRowModified({ m }: { m: MeasureDiff }) {
  return (
    <div className="diff-row diff-row-modified">
      <div className="diff-row-head">
        <strong>{m.name}</strong>
        <span className="muted"> · {m.table}</span>
        {m.dax_changed && <span className="badge mini">DAX</span>}
        {m.refs_changed && <span className="badge mini">refs</span>}
        {m.userel_changed && <span className="badge mini">USERELATIONSHIP</span>}
        {m.description_changed && <span className="badge mini">description</span>}
        {m.display_folder_changed && <span className="badge mini">display folder</span>}
        {m.format_string_changed && <span className="badge mini">format</span>}
        {m.is_hidden_changed && <span className="badge mini">hidden</span>}
      </div>
      {m.dax_changed && (
        <div className="diff-dax-pair">
          <div className="diff-dax-side">
            <div className="diff-dax-label diff-dax-label-base">BASE</div>
            <pre className="dax dax-base">{m.before?.expression ?? "(missing)"}</pre>
          </div>
          <div className="diff-dax-side">
            <div className="diff-dax-label diff-dax-label-head">HEAD</div>
            <pre className="dax dax-head">{m.head?.expression ?? "(missing)"}</pre>
          </div>
        </div>
      )}
      {m.description_changed && (
        <DescriptionPair before={m.before?.description} head={m.head?.description} />
      )}
      {m.display_folder_changed && (
        <ScalarPair
          label="Display folder"
          before={m.before?.display_folder}
          head={m.head?.display_folder}
        />
      )}
      {m.format_string_changed && (
        <ScalarPair
          label="Format"
          before={m.before?.format_string}
          head={m.head?.format_string}
        />
      )}
      {m.is_hidden_changed && (
        <ScalarPair
          label="Hidden"
          before={String(m.before?.is_hidden ?? false)}
          head={String(m.head?.is_hidden ?? false)}
        />
      )}
    </div>
  );
}

function DescriptionPair({
  before,
  head,
}: {
  before: string | null | undefined;
  head: string | null | undefined;
}) {
  return (
    <div className="diff-dax-pair">
      <div className="diff-dax-side">
        <div className="diff-dax-label diff-dax-label-base">DESCRIPTION (BASE)</div>
        <pre className="dax dax-base">{before ?? "(none)"}</pre>
      </div>
      <div className="diff-dax-side">
        <div className="diff-dax-label diff-dax-label-head">DESCRIPTION (HEAD)</div>
        <pre className="dax dax-head">{head ?? "(none)"}</pre>
      </div>
    </div>
  );
}

function ScalarPair({
  label,
  before,
  head,
}: {
  label: string;
  before: string | null | undefined;
  head: string | null | undefined;
}) {
  return (
    <div className="diff-row-detail">
      <span className="muted">{label}: </span>
      <span className="mono">
        {before ?? "(none)"} → {head ?? "(none)"}
      </span>
    </div>
  );
}

// --------------------------------------------------------------------------
// Tables
// --------------------------------------------------------------------------

function DiffTables({ items }: { items: TableDiff[] }) {
  if (items.length === 0) return null;
  const groups = groupByStatus(items);
  return (
    <section className="diff-section">
      <h2>
        Tables <span className="muted">({items.length})</span>
      </h2>
      <StatusGroup
        kind="added"
        items={groups.added}
        render={(t) => <TableRowAdded key={t.name} t={t} />}
      />
      <StatusGroup
        kind="modified"
        items={groups.modified}
        render={(t) => <TableRowModified key={t.name} t={t} />}
      />
      <StatusGroup
        kind="removed"
        items={groups.removed}
        render={(t) => <TableRowRemoved key={t.name} t={t} />}
      />
    </section>
  );
}

function TableRowAdded({ t }: { t: TableDiff }) {
  return (
    <div className="diff-row diff-row-added">
      <div className="diff-row-head">
        <strong>{t.name}</strong>
        {t.classification_head && (
          <span className={`chip on dot-${t.classification_head}`}>
            {t.classification_head}
          </span>
        )}
      </div>
      {t.columns_added.length > 0 && (
        <div className="diff-row-detail">
          <span className="muted">{t.columns_added.length} columns: </span>
          <span className="mono">{t.columns_added.join(", ")}</span>
        </div>
      )}
    </div>
  );
}

function TableRowRemoved({ t }: { t: TableDiff }) {
  return (
    <div className="diff-row diff-row-removed">
      <div className="diff-row-head">
        <strong>{t.name}</strong>
        {t.classification_before && (
          <span className={`chip on dot-${t.classification_before}`}>
            {t.classification_before}
          </span>
        )}
      </div>
      {t.columns_removed.length > 0 && (
        <div className="diff-row-detail">
          <span className="muted">{t.columns_removed.length} columns: </span>
          <span className="mono">{t.columns_removed.join(", ")}</span>
        </div>
      )}
    </div>
  );
}

function TableRowModified({ t }: { t: TableDiff }) {
  return (
    <div className="diff-row diff-row-modified">
      <div className="diff-row-head">
        <strong>{t.name}</strong>
        {t.classification_before && t.classification_head && (
          <span className="muted">
            {t.classification_before} → {t.classification_head}
          </span>
        )}
        {t.source_lineage_changed && <span className="badge mini">source changed</span>}
        {t.description_changed && <span className="badge mini">description</span>}
        {t.is_hidden_changed && <span className="badge mini">hidden</span>}
      </div>
      {t.columns_added.length > 0 && (
        <div className="diff-row-detail">
          <span className="diff-tag-added">+ {t.columns_added.length} cols</span>
          <span className="mono">{t.columns_added.join(", ")}</span>
        </div>
      )}
      {t.columns_removed.length > 0 && (
        <div className="diff-row-detail">
          <span className="diff-tag-removed">- {t.columns_removed.length} cols</span>
          <span className="mono">{t.columns_removed.join(", ")}</span>
        </div>
      )}
      {t.source_lineage_changed && (
        <div className="diff-row-detail">
          <span className="muted">Source: </span>
          <span className="mono">
            {sourceLabel(t.before)} → {sourceLabel(t.head)}
          </span>
        </div>
      )}
      {t.description_changed && (
        <DescriptionPair before={t.before?.description} head={t.head?.description} />
      )}
      {t.is_hidden_changed && (
        <ScalarPair
          label="Hidden"
          before={String(t.before?.is_hidden ?? false)}
          head={String(t.head?.is_hidden ?? false)}
        />
      )}
      {t.columns_modified.length > 0 && (
        <div className="diff-columns-modified">
          <div className="diff-row-detail">
            <span className="muted">{t.columns_modified.length} column(s) modified:</span>
          </div>
          {t.columns_modified.map((c) => (
            <ColumnDiffRow key={c.name} c={c} />
          ))}
        </div>
      )}
    </div>
  );
}

function ColumnDiffRow({ c }: { c: ColumnDiff }) {
  return (
    <div className="diff-row diff-row-modified diff-row-nested">
      <div className="diff-row-head">
        <span className="mono">{c.name}</span>
        {c.description_changed && <span className="badge mini">description</span>}
        {c.data_type_changed && <span className="badge mini">data type</span>}
        {c.is_hidden_changed && <span className="badge mini">hidden</span>}
        {c.is_key_changed && <span className="badge mini">key</span>}
        {c.source_column_changed && <span className="badge mini">source column</span>}
        {c.expression_changed && <span className="badge mini">DAX</span>}
      </div>
      {c.data_type_changed && (
        <ScalarPair label="Data type" before={c.before?.data_type} head={c.head?.data_type} />
      )}
      {c.source_column_changed && (
        <ScalarPair
          label="Source column"
          before={c.before?.source_column}
          head={c.head?.source_column}
        />
      )}
      {c.is_hidden_changed && (
        <ScalarPair
          label="Hidden"
          before={String(c.before?.is_hidden ?? false)}
          head={String(c.head?.is_hidden ?? false)}
        />
      )}
      {c.is_key_changed && (
        <ScalarPair
          label="Key"
          before={String(c.before?.is_key ?? false)}
          head={String(c.head?.is_key ?? false)}
        />
      )}
      {c.description_changed && (
        <DescriptionPair before={c.before?.description} head={c.head?.description} />
      )}
      {c.expression_changed && (
        <div className="diff-dax-pair">
          <div className="diff-dax-side">
            <div className="diff-dax-label diff-dax-label-base">BASE</div>
            <pre className="dax dax-base">{c.before?.expression ?? "(none)"}</pre>
          </div>
          <div className="diff-dax-side">
            <div className="diff-dax-label diff-dax-label-head">HEAD</div>
            <pre className="dax dax-head">{c.head?.expression ?? "(none)"}</pre>
          </div>
        </div>
      )}
    </div>
  );
}

function sourceLabel(tbl: TableDiff["before"]): string {
  if (!tbl) return "—";
  const partition = tbl.partitions[0];
  const lineage = partition?.source_lineage;
  if (!lineage) return "—";
  return lineage.fully_qualified ?? lineage.table ?? "—";
}

// --------------------------------------------------------------------------
// Relationships
// --------------------------------------------------------------------------

function DiffRelationships({ items }: { items: RelationshipDiff[] }) {
  if (items.length === 0) return null;
  const groups = groupByStatus(items);
  return (
    <section className="diff-section">
      <h2>
        Relationships <span className="muted">({items.length})</span>
      </h2>
      <StatusGroup
        kind="added"
        items={groups.added}
        render={(r) => <RelationshipRow key={r.key} r={r} />}
      />
      <StatusGroup
        kind="modified"
        items={groups.modified}
        render={(r) => <RelationshipRow key={r.key} r={r} />}
      />
      <StatusGroup
        kind="removed"
        items={groups.removed}
        render={(r) => <RelationshipRow key={r.key} r={r} />}
      />
    </section>
  );
}

function RelationshipRow({ r }: { r: RelationshipDiff }) {
  return (
    <div className={`diff-row diff-row-${r.status}`}>
      <div className="diff-row-head">
        <span className="mono">{r.key}</span>
        {r.is_active_changed && (
          <span className="badge mini">
            active: {r.before?.is_active ? "✓" : "✗"} → {r.head?.is_active ? "✓" : "✗"}
          </span>
        )}
        {r.cardinality_changed && (
          <span className="badge mini">
            cardinality: {r.before?.cardinality} → {r.head?.cardinality}
          </span>
        )}
        {r.crossfilter_changed && (
          <span className="badge mini">
            crossfilter: {r.before?.crossfilter} → {r.head?.crossfilter}
          </span>
        )}
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------
// Generic status grouping
// --------------------------------------------------------------------------

interface StatusGroups<T> {
  added: T[];
  modified: T[];
  removed: T[];
}

function groupByStatus<T extends { status: DiffStatus }>(items: T[]): StatusGroups<T> {
  const groups: StatusGroups<T> = { added: [], modified: [], removed: [] };
  for (const item of items) {
    groups[item.status].push(item);
  }
  return groups;
}

function StatusGroup<T>({
  kind,
  items,
  render,
}: {
  kind: DiffStatus;
  items: T[];
  render: (item: T) => React.ReactNode;
}) {
  if (items.length === 0) return null;
  return (
    <div className={`diff-status-group diff-${kind}-group`}>
      <h3 className={`diff-status-heading diff-${kind}`}>
        <span className="diff-summary-dot" aria-hidden />
        {kind} ({items.length})
      </h3>
      <div className="diff-rows">{items.map(render)}</div>
    </div>
  );
}

// --------------------------------------------------------------------------
// Client-side swap — flips BASE ↔ HEAD without a server round-trip.
// --------------------------------------------------------------------------

function swapPayload(d: DiffPayload): DiffPayload {
  return {
    ...d,
    base_label: d.head_label,
    head_label: d.base_label,
    base_path: d.head_path,
    head_path: d.base_path,
    // After swap we no longer know if the *new* BASE is the default branch.
    // Drop the pin to avoid lying.
    base_is_default_branch: false,
    counts: {
      measures_added: d.counts.measures_removed,
      measures_removed: d.counts.measures_added,
      measures_modified: d.counts.measures_modified,
      tables_added: d.counts.tables_removed,
      tables_removed: d.counts.tables_added,
      tables_modified: d.counts.tables_modified,
      relationships_added: d.counts.relationships_removed,
      relationships_removed: d.counts.relationships_added,
      relationships_modified: d.counts.relationships_modified,
    },
    measures: d.measures.map((m) => ({
      ...m,
      status: flipStatus(m.status),
      before: m.head,
      head: m.before,
    })),
    tables: d.tables.map((t) => ({
      ...t,
      status: flipStatus(t.status),
      before: t.head,
      head: t.before,
      columns_added: t.columns_removed,
      columns_removed: t.columns_added,
      columns_modified: t.columns_modified.map((c) => ({
        ...c,
        before: c.head,
        head: c.before,
      })),
      classification_before: t.classification_head,
      classification_head: t.classification_before,
    })),
    relationships: d.relationships.map((r) => ({
      ...r,
      status: flipStatus(r.status),
      before: r.head,
      head: r.before,
    })),
  };
}

function flipStatus(s: DiffStatus): DiffStatus {
  if (s === "added") return "removed";
  if (s === "removed") return "added";
  return "modified";
}
