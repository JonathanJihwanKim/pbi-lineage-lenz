/**
 * Graph tab for `/diff` — the bus-layout canvas painted with diff borders.
 *
 * On mount: fetch BASE's tables + relationships (those endpoints serve BASE
 * when a diff session is active), augment with HEAD-only entities pulled from
 * the DiffPayload so removed AND added items both render, then push the union
 * into the store along with status maps. ForceGraph reads `diffMode`,
 * `diffStatusByTable`, and `diffStatusByEdge` and paints the overlay.
 *
 * Click-to-select is disabled in diff mode (see ForceGraph) because clicking
 * an added node would 404 against the BASE-side `/api/tables/{name}` route.
 */

import { useEffect, useState } from "react";

import { api } from "../api/client";
import type {
  Classification,
  DiffPayload,
  DiffStatus,
  RelationshipItem,
  Table as TableT,
  TableDiff,
  TableListItem,
} from "../api/types";
import { ForceGraph } from "../graph/ForceGraph";
import { Legend } from "../components/Legend";
import { useStore } from "../store";

export function DiffGraph({
  payload,
  onShowMeasures,
}: {
  payload: DiffPayload;
  onShowMeasures: () => void;
}) {
  const enterDiffMode = useStore((s) => s.enterDiffMode);
  const exitDiffMode = useStore((s) => s.exitDiffMode);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.tables(), api.relationships()])
      .then(([baseTables, baseRels]) => {
        if (cancelled) return;
        const { tables, relationships, statusByTable, statusByEdge } = buildDiffOverlay(
          baseTables,
          baseRels,
          payload,
        );
        enterDiffMode({ tables, relationships, statusByTable, statusByEdge });
        setReady(true);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
      exitDiffMode();
    };
  }, [payload, enterDiffMode, exitDiffMode]);

  if (error) {
    return (
      <div className="overlay error">
        <strong>Could not load graph:</strong> {error}
      </div>
    );
  }
  if (!ready) {
    return <div className="overlay">Building diff graph…</div>;
  }
  return (
    <div className="diff-graph-wrap">
      <DiffGraphLegend payload={payload} onShowMeasures={onShowMeasures} />
      <ForceGraph />
      <Legend />
    </div>
  );
}

/** Color-key strip pinned above the canvas. The first three chips count
 *  table + relationship changes (what the graph paints). The trailing chip
 *  surfaces measure-change count separately so the graph tab reconciles with
 *  the header's totals without making the user switch tabs to check — clicking
 *  it jumps to the List tab. */
function DiffGraphLegend({
  payload,
  onShowMeasures,
}: {
  payload: DiffPayload;
  onShowMeasures: () => void;
}) {
  const c = payload.counts;
  const trAdded = c.tables_added + c.relationships_added;
  const trModified = c.tables_modified + c.relationships_modified;
  const trRemoved = c.tables_removed + c.relationships_removed;
  const measureChanges = c.measures_added + c.measures_modified + c.measures_removed;
  return (
    <div className="diff-graph-legend" role="note" aria-label="Diff status legend">
      <span className="diff-graph-legend-group-label muted">Tables &amp; rels:</span>
      <span className="diff-graph-legend-chip diff-added">
        <span className="diff-summary-dot" aria-hidden /> added ({trAdded})
      </span>
      <span className="diff-graph-legend-chip diff-modified">
        <span className="diff-summary-dot" aria-hidden /> modified ({trModified})
      </span>
      <span className="diff-graph-legend-chip diff-removed">
        <span className="diff-summary-dot" aria-hidden /> removed ({trRemoved})
      </span>
      {measureChanges > 0 && (
        <>
          <span className="diff-graph-legend-sep" aria-hidden>
            │
          </span>
          <button
            type="button"
            className="diff-graph-legend-measures"
            onClick={onShowMeasures}
            title="Switch to the List tab to see measure changes"
          >
            +{measureChanges} measure {measureChanges === 1 ? "change" : "changes"} →
          </button>
        </>
      )}
    </div>
  );
}

interface DiffOverlay {
  tables: TableListItem[];
  relationships: RelationshipItem[];
  statusByTable: Map<string, DiffStatus>;
  statusByEdge: Map<string, DiffStatus>;
}

export function buildDiffOverlay(
  baseTables: TableListItem[],
  baseRels: RelationshipItem[],
  payload: DiffPayload,
): DiffOverlay {
  const statusByTable = new Map<string, DiffStatus>();
  const statusByEdge = new Map<string, DiffStatus>();

  for (const td of payload.tables) {
    statusByTable.set(td.name, td.status);
  }
  // Index BASE relationships by canonical key so we can flip from RelationshipDiff
  // (keyed by from_table.from_column->to_table.to_column) to RelationshipItem.id
  // (the key ForceGraph uses).
  const baseRelById = new Map(baseRels.map((r) => [relKey(r), r.id]));
  for (const rd of payload.relationships) {
    if (rd.status === "added") continue; // handled below with synthesized id
    const id = baseRelById.get(rd.key);
    if (id) statusByEdge.set(id, rd.status);
  }

  // Augment with HEAD-only tables and relationships so removed/added BOTH show.
  const baseTableNames = new Set(baseTables.map((t) => t.name));
  const addedTables: TableListItem[] = [];
  for (const td of payload.tables) {
    if (td.status !== "added" || !td.head) continue;
    if (baseTableNames.has(td.head.name)) continue; // belt-and-braces
    addedTables.push(toTableListItem(td.head, td));
  }

  const baseRelKeys = new Set(baseRels.map(relKey));
  const addedRels: RelationshipItem[] = [];
  for (const rd of payload.relationships) {
    if (rd.status !== "added" || !rd.head) continue;
    if (baseRelKeys.has(rd.key)) continue;
    addedRels.push(rd.head);
    statusByEdge.set(rd.head.id, "added");
  }

  return {
    tables: [...baseTables, ...addedTables],
    relationships: [...baseRels, ...addedRels],
    statusByTable,
    statusByEdge,
  };
}

function relKey(r: RelationshipItem): string {
  return `${r.from_table}.${r.from_column}->${r.to_table}.${r.to_column}`;
}

/** Project a full HEAD-side `Table` (with columns/measures/partitions) into
 *  the sidebar/list shape that ForceGraph reads. Picks the highest-confidence
 *  partition lineage for the source identifier, matching the backend's logic
 *  in `/api/tables`. */
function toTableListItem(t: TableT, _td: TableDiff): TableListItem {
  const best = bestLineage(t);
  return {
    name: t.name,
    classification: (t.classification ?? "other") as Classification,
    is_hidden: t.is_hidden,
    column_count: t.columns.length,
    measure_count: t.measures.length,
    source_table: best?.fully_qualified ?? best?.table ?? null,
    source_connector: best?.connector ?? null,
    source_confidence: best?.confidence ?? null,
  };
}

function bestLineage(t: TableT) {
  const rank = { high: 3, medium: 2, low: 1, none: 0 } as const;
  let best: TableT["partitions"][number]["source_lineage"] | null = null;
  for (const p of t.partitions) {
    const l = p.source_lineage;
    if (!l) continue;
    if (!best || (rank[l.confidence] ?? 0) > (rank[best.confidence] ?? 0)) {
      best = l;
    }
  }
  return best;
}
