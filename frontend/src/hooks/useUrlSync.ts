import { useEffect, useRef } from "react";
import { useStore } from "../store";

/**
 * Two-way sync between the store's selection/depth and the URL query string.
 *
 * Selection-only URLs let teammates paste a link in Slack/PR and land on
 * the same measure or table at the same walk depth. Filesystem paths are
 * never encoded — the URL is portable across machines running model-lenz
 * against the same PBIP.
 *
 * Effect side: when selection or depth changes, replace the URL (no history
 * entries — back/forward should not retrace every click).
 * Hydration side: callers run `hydrateSelectionFromUrl` once after bootstrap.
 */
export function useUrlSync(): void {
  const selection = useStore((s) => s.selection);
  const depth = useStore((s) => s.depth);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
    }
    timerRef.current = window.setTimeout(() => {
      const params = new URLSearchParams();
      if (selection?.kind === "measure" && selection.table) {
        params.set("table", selection.table);
        params.set("measure", selection.name);
      } else if (selection?.kind === "table") {
        params.set("table", selection.name);
      }
      if (depth !== 2) {
        params.set("depth", String(depth));
      }
      const qs = params.toString();
      const next = `${window.location.pathname}${qs ? `?${qs}` : ""}${window.location.hash}`;
      const cur = window.location.pathname + window.location.search + window.location.hash;
      if (next !== cur) {
        window.history.replaceState({}, "", next);
      }
    }, 100);
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, [selection, depth]);
}

export interface ParsedSelectionUrl {
  table?: string;
  measure?: string;
  depth?: number;
}

export function parseSelectionUrl(
  search: string = window.location.search,
): ParsedSelectionUrl {
  const params = new URLSearchParams(search);
  const table = params.get("table") ?? undefined;
  const measure = params.get("measure") ?? undefined;
  const depthRaw = params.get("depth");
  const depthNum = depthRaw ? Number(depthRaw) : NaN;
  const depth =
    Number.isFinite(depthNum) && depthNum >= 1 && depthNum <= 5 ? depthNum : undefined;
  return { table, measure, depth };
}

/**
 * Apply a parsed URL to the store after bootstrap has populated the
 * measure/table lists. Validates the selection exists; surfaces a friendly
 * info toast and clears the URL params when the link points at something
 * the loaded model no longer contains.
 */
export async function hydrateSelectionFromUrl(parsed: ParsedSelectionUrl): Promise<void> {
  const state = useStore.getState();
  const { table, measure, depth } = parsed;

  if (depth && depth !== state.depth) {
    await state.setDepth(depth);
  }

  if (table && measure) {
    const exists = state.measures.some((m) => m.table === table && m.name === measure);
    if (exists) {
      await state.selectMeasure(table, measure);
    } else {
      state.pushInfoToast(
        `Measure '${measure}' on table '${table}' not in this model — link ignored.`,
      );
      clearSelectionParams();
    }
  } else if (table) {
    const exists = state.tables.some((t) => t.name === table);
    if (exists) {
      state.selectTable(table);
    } else {
      state.pushInfoToast(`Table '${table}' not in this model — link ignored.`);
      clearSelectionParams();
    }
  }
}

function clearSelectionParams(): void {
  const params = new URLSearchParams(window.location.search);
  params.delete("table");
  params.delete("measure");
  const qs = params.toString();
  const next = `${window.location.pathname}${qs ? `?${qs}` : ""}${window.location.hash}`;
  window.history.replaceState({}, "", next);
}
