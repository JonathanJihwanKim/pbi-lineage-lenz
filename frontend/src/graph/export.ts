/**
 * Mermaid + SVG export for the bus-layout canvas.
 *
 * Two destinations:
 *   - Mermaid (`graph LR` syntax) → copied to clipboard, pasteable into a
 *     PR description, design doc, or https://mermaid.live to render.
 *   - SVG → downloaded as a standalone file with computed styles inlined so
 *     it renders identically without the app's CSS.
 *
 * The Mermaid serializer reads the same store slices ForceGraph reads, so
 * the export always matches what the user is looking at — measure spotlight
 * if a measure is selected, diff status borders if /diff is active.
 */

import type {
  Cardinality,
  Crossfilter,
  DiffStatus,
  MeasureGraph,
  RelationshipItem,
  TableListItem,
} from "../api/types";

// --------------------------------------------------------------------------
// Mermaid
// --------------------------------------------------------------------------

export interface MermaidNode {
  /** Unsanitized semantic name; used for both the ID (after sanitization)
   *  and the label. */
  name: string;
  sourceLabel?: string | null;
  status?: DiffStatus;
}

export interface MermaidEdge {
  from: string;
  to: string;
  cardinality: Cardinality;
  crossfilter: Crossfilter;
  isActive: boolean;
  status?: DiffStatus;
}

export interface MermaidInput {
  nodes: MermaidNode[];
  edges: MermaidEdge[];
  /** Optional synthetic measure root with dashed edges to direct-ref tables.
   *  Used when exporting from a measure spotlight view. */
  measureRoot?: { name: string; directTables: string[] } | null;
  /** Header comment baked into the Mermaid output. */
  title?: string | null;
}

export function toMermaidString(input: MermaidInput): string {
  const lines: string[] = [];
  if (input.title) {
    lines.push(`%% ${input.title}`);
  }
  lines.push("graph LR");

  // Stable, dedup'd ID assignment. Two tables that differ only in non-alpha
  // chars would otherwise collide.
  const idFor = new Map<string, string>();
  const usedIds = new Set<string>();
  for (const n of input.nodes) {
    const id = uniqueId(mermaidId(n.name), usedIds);
    idFor.set(n.name, id);
    lines.push(`  ${id}["${mermaidLabel(n)}"]`);
  }

  // Track the 0-based index of every emitted edge (measureRoot edges + filtered
  // relationship edges), since Mermaid's `linkStyle N` references edges by the
  // order they appear in the source.
  let edgeIdx = 0;
  const linkStyleLines: string[] = [];

  if (input.measureRoot) {
    const rootId = uniqueId("MEASURE_" + mermaidId(input.measureRoot.name), usedIds);
    lines.push(
      `  ${rootId}(("${escapeMermaid(input.measureRoot.name)}"))`,
    );
    for (const target of input.measureRoot.directTables) {
      const targetId = idFor.get(target);
      if (!targetId) continue;
      lines.push(`  ${rootId} -.->|direct| ${targetId}`);
      edgeIdx++;
    }
    lines.push(`  style ${rootId} fill:#e6b41e,stroke:#7d5b00,color:#1a1a1a`);
  }

  for (const e of input.edges) {
    const fromId = idFor.get(e.from);
    const toId = idFor.get(e.to);
    if (!fromId || !toId) continue;
    const card = cardinalityLabel(e.cardinality);
    const flag = !e.isActive ? " inactive" : "";
    const arrow = mermaidArrow(e.crossfilter, e.isActive);
    lines.push(`  ${fromId} ${arrow}|${card}${flag}| ${toId}`);
    if (e.status) {
      const color = diffColor(e.status);
      const dash = e.status === "removed" ? ",stroke-dasharray: 4 3" : "";
      linkStyleLines.push(
        `  linkStyle ${edgeIdx} stroke:${color},stroke-width:2.5px${dash}`,
      );
    }
    edgeIdx++;
  }

  for (const n of input.nodes) {
    if (!n.status) continue;
    const id = idFor.get(n.name);
    if (!id) continue;
    const color = diffColor(n.status);
    const dash = n.status === "removed" ? ",stroke-dasharray: 4 3" : "";
    lines.push(`  style ${id} stroke:${color},stroke-width:2.5px${dash}`);
  }

  for (const ls of linkStyleLines) {
    lines.push(ls);
  }

  return lines.join("\n") + "\n";
}

function mermaidId(s: string): string {
  // Mermaid IDs: alphanumeric + underscore. Replace everything else with `_`
  // and prefix when starting with a digit (Mermaid rejects leading digits).
  const sanitized = s.replace(/[^A-Za-z0-9]/g, "_");
  return /^[0-9]/.test(sanitized) ? `T_${sanitized}` : sanitized;
}

function uniqueId(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let n = 2;
  while (used.has(`${base}_${n}`)) n++;
  const out = `${base}_${n}`;
  used.add(out);
  return out;
}

function mermaidLabel(n: MermaidNode): string {
  const top = escapeMermaid(n.name);
  if (n.sourceLabel) {
    return `${top}<br/><small>${escapeMermaid(n.sourceLabel)}</small>`;
  }
  return top;
}

/** Quote-and-bracket-safe label content. Mermaid interprets `"` inside
 *  `["..."]` literally, so we replace with the HTML entity. */
function escapeMermaid(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\|/g, "&#124;")
    .replace(/\[/g, "&#91;")
    .replace(/\]/g, "&#93;")
    .replace(/\(/g, "&#40;")
    .replace(/\)/g, "&#41;");
}

function cardinalityLabel(c: Cardinality): string {
  return {
    many_to_one: "*:1",
    one_to_many: "1:*",
    one_to_one: "1:1",
    many_to_many: "*:*",
  }[c];
}

function mermaidArrow(crossfilter: Crossfilter, isActive: boolean): string {
  // Mermaid doesn't have a "dashed bidirectional" — bidi wins (it's the more
  // unusual semantic and worth surfacing), inactive falls back to dashed.
  if (crossfilter === "both") return "<-->";
  if (!isActive) return "-.->";
  return "-->";
}

function diffColor(status: DiffStatus): string {
  return status === "added" ? "#2faa6a" : status === "removed" ? "#d6452a" : "#d29420";
}

// --------------------------------------------------------------------------
// SVG export
// --------------------------------------------------------------------------

const VISUAL_PROPS = [
  "fill",
  "stroke",
  "stroke-width",
  "stroke-dasharray",
  "stroke-linecap",
  "stroke-linejoin",
  "opacity",
  "fill-opacity",
  "stroke-opacity",
  "font-family",
  "font-size",
  "font-weight",
  "text-anchor",
  "color",
  "visibility",
];

/** Build a standalone-SVG Blob from a live SVG element. Computed styles are
 *  inlined per element so the export renders identically without the app's
 *  CSS variables. The current pan/zoom transform on `.viewport` is preserved,
 *  so the exported SVG matches what the user sees on screen. */
export function exportSvgBlob(svgEl: SVGSVGElement, bgColor: string): Blob {
  const clone = svgEl.cloneNode(true) as SVGSVGElement;
  inlineStyles(svgEl, clone);

  // Ensure width/height attributes are concrete (the live element uses 100%).
  const rect = svgEl.getBoundingClientRect();
  clone.setAttribute("width", String(Math.round(rect.width)));
  clone.setAttribute("height", String(Math.round(rect.height)));
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");

  // Inject a background rect matching the active theme so the export reads on
  // either light or dark backgrounds (default SVG is transparent).
  const bg = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  bg.setAttribute("width", "100%");
  bg.setAttribute("height", "100%");
  bg.setAttribute("fill", bgColor);
  clone.insertBefore(bg, clone.firstChild);

  const xml = new XMLSerializer().serializeToString(clone);
  const decl = '<?xml version="1.0" encoding="UTF-8" standalone="no"?>';
  return new Blob([decl + xml], { type: "image/svg+xml;charset=utf-8" });
}

function inlineStyles(liveRoot: Element, cloneRoot: Element): void {
  // Walk both trees in lockstep so we can read computed styles from the live
  // element (the clone has no layout / computed styles yet because it's not
  // in the document).
  const liveStack: Element[] = [liveRoot];
  const cloneStack: Element[] = [cloneRoot];
  while (liveStack.length) {
    const live = liveStack.pop()!;
    const clone = cloneStack.pop()!;
    if (live instanceof SVGElement || live instanceof HTMLElement) {
      const computed = window.getComputedStyle(live);
      let inline = "";
      for (const prop of VISUAL_PROPS) {
        const value = computed.getPropertyValue(prop);
        if (!value || value === "none" || value === "auto") continue;
        // Skip default fills for SVG groups — they have fill:rgb(0,0,0) by
        // default, which would override child fills.
        if (prop === "fill" && value === "rgb(0, 0, 0)" && live.tagName === "g") continue;
        inline += `${prop}:${value};`;
      }
      if (inline) {
        const existing = clone.getAttribute("style") ?? "";
        clone.setAttribute("style", existing + inline);
      }
    }
    const liveChildren = Array.from(live.children);
    const cloneChildren = Array.from(clone.children);
    for (let i = 0; i < liveChildren.length && i < cloneChildren.length; i++) {
      liveStack.push(liveChildren[i]);
      cloneStack.push(cloneChildren[i]);
    }
  }
}

export function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Free the object URL after the click has had time to fire.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// --------------------------------------------------------------------------
// Store → MermaidInput
// --------------------------------------------------------------------------

export interface BuildMermaidArgs {
  tables: TableListItem[];
  relationships: RelationshipItem[];
  classFilter: Set<string>;
  measureGraph: MeasureGraph | null;
  diffStatusByTable: Map<string, DiffStatus> | null;
  diffStatusByEdge: Map<string, DiffStatus> | null;
}

/** Snapshot the current canvas state as a Mermaid-ready payload. Mirrors
 *  ForceGraph's visibility rules: measure-spotlight subgraph if a measure
 *  is selected, otherwise the class-filter subset (which expands to all
 *  classes in diff mode). */
export function buildMermaidInput(args: BuildMermaidArgs): MermaidInput {
  const {
    tables,
    relationships,
    classFilter,
    measureGraph,
    diffStatusByTable,
    diffStatusByEdge,
  } = args;

  const tableByName = new Map(tables.map((t) => [t.name, t]));
  const visible = new Set<string>();

  if (measureGraph) {
    for (const name of measureGraph.direct_tables) visible.add(name);
    for (const it of measureGraph.indirect_tables) visible.add(it.table);
  } else {
    for (const t of tables) {
      if (classFilter.has(t.classification)) visible.add(t.name);
    }
  }

  const nodes: MermaidNode[] = [];
  for (const name of visible) {
    const t = tableByName.get(name);
    nodes.push({
      name,
      sourceLabel: t?.source_table ?? null,
      status: diffStatusByTable?.get(name),
    });
  }

  const edges: MermaidEdge[] = [];
  for (const r of relationships) {
    if (!visible.has(r.from_table) || !visible.has(r.to_table)) continue;
    edges.push({
      from: r.from_table,
      to: r.to_table,
      cardinality: r.cardinality,
      crossfilter: r.crossfilter,
      isActive: r.is_active,
      status: diffStatusByEdge?.get(r.id),
    });
  }

  const measureRoot = measureGraph
    ? {
        name: measureGraph.measure.name,
        directTables: measureGraph.direct_tables,
      }
    : null;

  const title = measureGraph
    ? `Model Lenz — measure: ${measureGraph.measure.name} (${measureGraph.measure.table})`
    : diffStatusByTable
      ? "Model Lenz — diff overlay"
      : "Model Lenz — model overview";

  return { nodes, edges, measureRoot, title };
}
