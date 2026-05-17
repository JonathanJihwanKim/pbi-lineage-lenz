/**
 * `/diff` route — v0.3.x.
 *
 * Two tabs: **Graph** (bus layout with diff borders, default) and **List**
 * (the v0.3.0 structured-list view). The shell handles fetching the
 * DiffPayload + swap once; each tab consumes the same payload.
 *
 * The list view is preserved because some review workflows (DAX-only reads,
 * column-level audits) read better as text than as a canvas overlay.
 */

import { useEffect, useMemo, useState } from "react";

import { api } from "../api/client";
import type { DiffPayload, DiffStatus } from "../api/types";
import { useStore } from "../store";
import { useExportHandlers } from "../hooks/useExportHandlers";
import { DiffGraph } from "./DiffGraph";
import { DiffList } from "./DiffList";

type Tab = "graph" | "list";
const TAB_STORAGE_KEY = "model-lenz-diff-tab";

export function DiffView() {
  const [payload, setPayload] = useState<DiffPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [swapped, setSwapped] = useState(false);
  const [tab, setTab] = useState<Tab>(() => loadTab());

  useEffect(() => {
    api
      .diff()
      .then(setPayload)
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(TAB_STORAGE_KEY, tab);
    } catch {
      // private mode — fail silently.
    }
  }, [tab]);

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
          <DiffTabs tab={tab} setTab={setTab} />
          {tab === "graph" ? (
            <main className="diff-body diff-body-graph">
              <DiffGraph payload={view} onShowMeasures={() => setTab("list")} />
            </main>
          ) : (
            <main className="diff-body">
              <DiffList payload={view} />
            </main>
          )}
        </>
      )}
    </div>
  );
}

function loadTab(): Tab {
  try {
    const raw = localStorage.getItem(TAB_STORAGE_KEY);
    if (raw === "list") return "list";
  } catch {
    // ignore
  }
  return "graph";
}

// --------------------------------------------------------------------------
// Tab switcher
// --------------------------------------------------------------------------

function DiffTabs({ tab, setTab }: { tab: Tab; setTab: (t: Tab) => void }) {
  return (
    <div className="diff-tabs" role="tablist" aria-label="Diff view mode">
      <button
        role="tab"
        aria-selected={tab === "graph"}
        className={`diff-tab${tab === "graph" ? " active" : ""}`}
        onClick={() => setTab("graph")}
      >
        Graph
      </button>
      <button
        role="tab"
        aria-selected={tab === "list"}
        className={`diff-tab${tab === "list" ? " active" : ""}`}
        onClick={() => setTab("list")}
      >
        List
      </button>
    </div>
  );
}

// --------------------------------------------------------------------------
// Top bar — reuses the brand chrome from the model view's <Header>
// --------------------------------------------------------------------------

function DiffTopBar() {
  const theme = useStore((s) => s.theme);
  const toggleTheme = useStore((s) => s.toggleTheme);
  const { copyMermaid, downloadSvg } = useExportHandlers();
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
        <button
          className="header-open-btn"
          onClick={() => void copyMermaid()}
          title="Copy the diff graph as Mermaid (includes status colors)"
        >
          Copy Mermaid
        </button>
        <button
          className="header-open-btn"
          onClick={downloadSvg}
          title="Download the diff graph as an SVG"
        >
          Download SVG
        </button>
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
