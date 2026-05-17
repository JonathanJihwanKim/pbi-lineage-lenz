import { useCallback } from "react";
import { useStore } from "../store";
import {
  buildMermaidInput,
  exportSvgBlob,
  toMermaidString,
  triggerDownload,
} from "../graph/export";

/** Shared export handlers used by both the model-view Header and the
 *  diff-view top bar. Reads canvas state from the store, writes results to
 *  the clipboard / triggers a file download, and surfaces success / failure
 *  via the existing info-toast queue. */
export function useExportHandlers() {
  const pushInfoToast = useStore((s) => s.pushInfoToast);

  const copyMermaid = useCallback(async () => {
    const s = useStore.getState();
    const input = buildMermaidInput({
      tables: s.tables,
      relationships: s.relationships,
      classFilter: s.classFilter,
      measureGraph: s.measureGraph,
      diffStatusByTable: s.diffStatusByTable,
      diffStatusByEdge: s.diffStatusByEdge,
    });
    if (input.nodes.length === 0) {
      pushInfoToast("Nothing to export — no visible tables.");
      return;
    }
    const text = toMermaidString(input);
    try {
      await navigator.clipboard.writeText(text);
      pushInfoToast(`Mermaid copied (${input.nodes.length} nodes, ${input.edges.length} edges)`);
    } catch {
      pushInfoToast("Clipboard write failed — copy from console");
      // eslint-disable-next-line no-console
      console.log(text);
    }
  }, [pushInfoToast]);

  const downloadSvg = useCallback(() => {
    const svg = document.querySelector<SVGSVGElement>("svg.bus-graph");
    if (!svg) {
      pushInfoToast("No graph to export.");
      return;
    }
    const bg =
      window.getComputedStyle(document.documentElement).getPropertyValue("--bg-0").trim() ||
      "#ffffff";
    const blob = exportSvgBlob(svg, bg);
    const s = useStore.getState();
    const stem = s.measureGraph
      ? `measure-${slug(s.measureGraph.measure.name)}`
      : s.diffMode
        ? "diff"
        : "overview";
    triggerDownload(blob, `model-lenz-${stem}.svg`);
    pushInfoToast("SVG downloaded");
  }, [pushInfoToast]);

  return { copyMermaid, downloadSvg };
}

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "untitled"
  );
}
