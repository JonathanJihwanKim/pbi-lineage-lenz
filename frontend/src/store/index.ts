import { create } from "zustand";
import type {
  DiffStatus,
  MeasureGraph,
  MeasureListItem,
  ModelSummary,
  RelationshipItem,
  TableListItem,
} from "../api/types";
import { api } from "../api/client";

export type Theme = "light" | "dark";

export interface Selection {
  kind: "measure" | "table";
  name: string;
  table?: string;
}

interface State {
  // Reference data — loaded once on app boot.
  summary: ModelSummary | null;
  measures: MeasureListItem[];
  tables: TableListItem[];
  relationships: RelationshipItem[];
  loading: boolean;
  error: string | null;

  // The active PBIP path (seeded from /healthz on mount; updated by openPbip).
  pbipPath: string | null;
  openModalVisible: boolean;

  // UI state.
  theme: Theme;
  depth: number;
  search: string;
  classFilter: Set<string>; // selected table classifications
  expandedFolders: Set<string>; // explicitly expanded sidebar folders
  collapsedFolders: Set<string>; // explicitly collapsed (overrides default)

  // Selection.
  selection: Selection | null;
  /** Drill-down breadcrumb trail. Top of stack is the most recent ancestor;
   *  empty when the current selection was made fresh from the sidebar/canvas. */
  selectionHistory: Selection[];
  pinned: Selection[];
  measureGraph: MeasureGraph | null;
  measureGraphLoading: boolean;

  /** Ephemeral toast queue for non-error UI feedback ("Link copied", etc.).
   *  Auto-dismisses after a few seconds via the Toaster component. */
  infoToasts: { id: number; text: string }[];

  /** Diff overlay state — populated only on the /diff route's Graph tab.
   *  When `diffMode` is true the ForceGraph paints diff-status borders on
   *  table cards and edges, and disables click-to-select (clicks would 404
   *  on added items that exist only in HEAD). */
  diffMode: boolean;
  diffStatusByTable: Map<string, DiffStatus> | null;
  /** Keyed by RelationshipItem.id (matches the relationship in the store).
   *  RelationshipDiff carries a canonical from→to key; we re-key by id at
   *  enterDiffMode time so the ForceGraph lookup is O(1). */
  diffStatusByEdge: Map<string, DiffStatus> | null;

  // Actions.
  bootstrap: () => Promise<void>;
  setPbipPath: (p: string) => void;
  showOpenModal: () => void;
  hideOpenModal: () => void;
  /** Switch the server to a different PBIP and refresh all reference data. */
  openPbip: (path: string) => Promise<void>;
  toggleTheme: () => void;
  setDepth: (d: number) => Promise<void>;
  setSearch: (s: string) => void;
  toggleClassFilter: (c: string) => void;
  toggleFolder: (folder: string) => void;
  expandFolder: (folder: string) => void;
  /** Fresh selection — clears the breadcrumb trail. Use from sidebar/canvas. */
  selectMeasure: (table: string, name: string) => Promise<void>;
  /** Drill-down selection — pushes the current selection onto history. */
  drillIntoMeasure: (table: string, name: string) => Promise<void>;
  /** Pop the most recent ancestor and re-select it. */
  goBack: () => Promise<void>;
  selectTable: (name: string) => void;
  clearSelection: () => void;
  pinSelection: () => void;
  unpinSelection: (sel: Selection) => void;
  pushInfoToast: (text: string) => void;
  dismissInfoToast: (id: number) => void;
  /** Enter diff-overlay mode. Tables/relationships are augmented with the
   *  HEAD-only (added) items so the bus layout shows the union; class filter
   *  is opened up so non-backbone changes are visible. */
  enterDiffMode: (args: {
    tables: TableListItem[];
    relationships: RelationshipItem[];
    statusByTable: Map<string, DiffStatus>;
    statusByEdge: Map<string, DiffStatus>;
  }) => void;
  exitDiffMode: () => void;
}

let nextInfoToastId = 1;

const ALL_CLASSES = ["fact", "dim", "parameter", "time", "calculation_group", "other"];
const BACKBONE_CLASSES = ["fact", "dim", "time"];

const STORAGE_EXPANDED = "model-lenz-expanded-folders";
const STORAGE_COLLAPSED = "model-lenz-collapsed-folders";

function loadSet(key: string): Set<string> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

function saveSet(key: string, s: Set<string>): void {
  try {
    localStorage.setItem(key, JSON.stringify([...s]));
  } catch {
    // localStorage can throw in private mode — fail silently.
  }
}

/** Shared graph loader used by selectMeasure, drillIntoMeasure, goBack, and
 *  setDepth. Caller is responsible for setting `selection` and any history
 *  changes BEFORE calling. We only commit the graph if the user hasn't
 *  navigated away while the request was in flight. */
async function loadMeasureGraph(
  set: (partial: Partial<State>) => void,
  get: () => State,
  table: string,
  name: string,
): Promise<void> {
  try {
    const g = await api.measureGraph(table, name, get().depth);
    const sel = get().selection;
    if (sel && sel.kind === "measure" && sel.name === name && sel.table === table) {
      set({ measureGraph: g, measureGraphLoading: false });
    }
  } catch (e) {
    set({ error: (e as Error).message, measureGraphLoading: false });
  }
}

export const useStore = create<State>((set, get) => ({
  summary: null,
  measures: [],
  tables: [],
  relationships: [],
  loading: false,
  error: null,

  pbipPath: null,
  openModalVisible: false,

  theme: (localStorage.getItem("model-lenz-theme") as Theme) || "dark",
  depth: 2,
  search: "",
  // Default: only the structural backbone is visible. Param tables, calc
  // groups, and "other" tables are revealed on demand (or by toggling chips).
  classFilter: new Set(BACKBONE_CLASSES),
  expandedFolders: loadSet(STORAGE_EXPANDED),
  collapsedFolders: loadSet(STORAGE_COLLAPSED),

  selection: null,
  selectionHistory: [],
  pinned: [],
  measureGraph: null,
  measureGraphLoading: false,
  infoToasts: [],
  diffMode: false,
  diffStatusByTable: null,
  diffStatusByEdge: null,

  bootstrap: async () => {
    set({ loading: true, error: null });
    try {
      const [summary, measures, tables, relationships] = await Promise.all([
        api.modelSummary(),
        api.measures(),
        api.tables(),
        api.relationships(),
      ]);
      set({ summary, measures, tables, relationships, loading: false });
    } catch (e) {
      set({ loading: false, error: (e as Error).message });
    }
  },

  setPbipPath: (p) => set({ pbipPath: p }),
  showOpenModal: () => set({ openModalVisible: true }),
  hideOpenModal: () => set({ openModalVisible: false }),
  openPbip: async (path) => {
    // Lets the caller's try/catch surface the server's 400/409 message inline
    // (modal validation). On success: reset selection + ephemeral UI state so
    // nothing carries over from the previous model, then re-bootstrap.
    const res = await api.openPbip(path);
    set({
      pbipPath: res.path,
      summary: res.summary,
      selection: null,
      selectionHistory: [],
      pinned: [],
      measureGraph: null,
      measureGraphLoading: false,
      search: "",
      openModalVisible: false,
    });
    await get().bootstrap();
  },

  toggleTheme: () => {
    const next: Theme = get().theme === "dark" ? "light" : "dark";
    localStorage.setItem("model-lenz-theme", next);
    set({ theme: next });
  },
  setDepth: async (d) => {
    set({ depth: d });
    const sel = get().selection;
    if (sel?.kind !== "measure" || !sel.table) return;
    // Re-fetch the graph at the new depth without disturbing the breadcrumb
    // trail (which selectMeasure would clear).
    set({ measureGraph: null, measureGraphLoading: true });
    try {
      const g = await api.measureGraph(sel.table, sel.name, d);
      const cur = get().selection;
      if (cur && cur.kind === "measure" && cur.name === sel.name && cur.table === sel.table) {
        set({ measureGraph: g, measureGraphLoading: false });
      }
    } catch (e) {
      set({ error: (e as Error).message, measureGraphLoading: false });
    }
  },
  setSearch: (s) => set({ search: s }),
  toggleClassFilter: (c) => {
    const cur = new Set(get().classFilter);
    if (cur.has(c)) cur.delete(c);
    else cur.add(c);
    set({ classFilter: cur });
  },

  toggleFolder: (folder) => {
    // Default is closed; presence in `expandedFolders` flips it open.
    // collapsedFolders is unused under the new scheme but kept on the type
    // for backward compatibility with existing localStorage entries.
    const expanded = new Set(get().expandedFolders);
    if (expanded.has(folder)) expanded.delete(folder);
    else expanded.add(folder);
    saveSet(STORAGE_EXPANDED, expanded);
    set({ expandedFolders: expanded });
  },

  expandFolder: (folder) => {
    const expanded = new Set(get().expandedFolders);
    const collapsed = new Set(get().collapsedFolders);
    if (collapsed.has(folder)) collapsed.delete(folder);
    expanded.add(folder);
    saveSet(STORAGE_EXPANDED, expanded);
    saveSet(STORAGE_COLLAPSED, collapsed);
    set({ expandedFolders: expanded, collapsedFolders: collapsed });
  },

  selectMeasure: async (table, name) => {
    // Fresh selection from sidebar/canvas — drop the breadcrumb trail.
    set({
      selection: { kind: "measure", name, table },
      selectionHistory: [],
      measureGraph: null,
      measureGraphLoading: true,
    });
    await loadMeasureGraph(set, get, table, name);
  },

  drillIntoMeasure: async (table, name) => {
    const cur = get().selection;
    const history = get().selectionHistory;
    // Push the current selection onto history (no-op if there is none, or if
    // the user clicks the same measure they're already on).
    const nextHistory =
      cur && !(cur.kind === "measure" && cur.name === name && cur.table === table)
        ? [...history, cur]
        : history;
    set({
      selection: { kind: "measure", name, table },
      selectionHistory: nextHistory,
      measureGraph: null,
      measureGraphLoading: true,
    });
    await loadMeasureGraph(set, get, table, name);
  },

  goBack: async () => {
    const history = get().selectionHistory;
    if (history.length === 0) return;
    const prev = history[history.length - 1];
    const nextHistory = history.slice(0, -1);
    set({ selection: prev, selectionHistory: nextHistory, measureGraph: null });
    if (prev.kind === "measure" && prev.table) {
      set({ measureGraphLoading: true });
      await loadMeasureGraph(set, get, prev.table, prev.name);
    }
  },

  selectTable: (name) =>
    set({
      selection: { kind: "table", name },
      selectionHistory: [],
      measureGraph: null,
    }),

  clearSelection: () =>
    set({ selection: null, selectionHistory: [], measureGraph: null }),

  pinSelection: () => {
    const sel = get().selection;
    if (!sel) return;
    const exists = get().pinned.find(
      (p) => p.kind === sel.kind && p.name === sel.name && p.table === sel.table,
    );
    if (!exists) set({ pinned: [...get().pinned, sel] });
  },
  unpinSelection: (sel) =>
    set({
      pinned: get().pinned.filter(
        (p) => !(p.kind === sel.kind && p.name === sel.name && p.table === sel.table),
      ),
    }),

  pushInfoToast: (text) =>
    set({ infoToasts: [...get().infoToasts, { id: nextInfoToastId++, text }] }),
  dismissInfoToast: (id) =>
    set({ infoToasts: get().infoToasts.filter((t) => t.id !== id) }),

  enterDiffMode: ({ tables, relationships, statusByTable, statusByEdge }) =>
    set({
      diffMode: true,
      tables,
      relationships,
      diffStatusByTable: statusByTable,
      diffStatusByEdge: statusByEdge,
      // Show every classification on the diff canvas — without a Sidebar
      // there's no way to expand the filter, and parameter / calc-group
      // changes are review-worthy too.
      classFilter: new Set(ALL_CLASSES),
    }),
  exitDiffMode: () =>
    set({
      diffMode: false,
      diffStatusByTable: null,
      diffStatusByEdge: null,
    }),
}));

export const ALL_CLASSIFICATIONS = ALL_CLASSES;
export const DEFAULT_VISIBLE_CLASSIFICATIONS = BACKBONE_CLASSES;

/** True iff the folder should appear open right now.
 *
 * Default is **collapsed** for every folder so the sidebar reads consistently
 * regardless of folder size. Two things override that default:
 *   - the folder appears in `expandedFolders` (user explicitly opened it,
 *     or `expandFolder` was called for it when its measure was selected)
 *   - search is active (every matching folder is revealed)
 */
export function isFolderOpen(
  folderName: string,
  expandedFolders: Set<string>,
  searchActive: boolean,
): boolean {
  if (searchActive) return true;
  return expandedFolders.has(folderName);
}
