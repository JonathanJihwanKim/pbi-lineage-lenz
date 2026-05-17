/**
 * Bus Layout + Spotlight — the canvas component.
 *
 * Layout is deterministic (no force simulation). Dim/time tables go in the
 * top row, fact tables in the left column, disconnected tables in the right
 * column. Relationship edges are drawn as L-shaped paths with right-angle
 * bends, with cardinality glyphs (1 near dim, * near fact) and a filter
 * arrow always pointing toward the fact.
 *
 * Spotlight: when a measure is selected, a synthetic "measure" node appears
 * in the top-left corner (Tsui's "measures table" position) with solid edges
 * to every direct table reference. Tables NOT on the measure's dependency
 * path drop to ~15% opacity. Edges along the path are bolded; others fade.
 *
 * Pan/zoom via d3-zoom. Click a node to select it. Right-click to pin.
 */

import { useEffect, useMemo, useRef } from "react";
import { select } from "d3-selection";
import { zoom as d3zoom, zoomIdentity, type ZoomBehavior } from "d3-zoom";
// Side-effect import: extends d3-selection with .transition() so the
// auto-fit zoom call below can animate. d3-zoom calls .transition() on
// selections internally, but the method only exists once d3-transition has
// been loaded.
import "d3-transition";

import { useStore } from "../store";
import type { Cardinality, Confidence, RelationshipItem } from "../api/types";
import {
  cardinalityGlyphPosition,
  computeBusLayout,
  DEFAULT_LAYOUT,
  isAnomalousEdge,
  isDimZone,
  isFactZone,
  lShapedEdgePath,
  type NodePosition,
  type Orientation,
  type PositionableNode,
} from "./busLayout";
import { ConnectorGlyphSprite, connectorToGlyphId } from "./connectorGlyphs";

const CARD_W = DEFAULT_LAYOUT.cardWidth;
const CARD_H = DEFAULT_LAYOUT.cardHeight;
const SOURCE_LABEL_MAX = 22;

interface NodeView extends PositionableNode {
  sourceLabel: string | null;
  sourceConnector: string | null;
  sourceConfidence: Confidence | null;
  position: NodePosition;
  visible: boolean;
}

interface EdgeView {
  id: string;
  source: NodeView;
  target: NodeView;
  rel: RelationshipItem;
  path: string;
  anomalous: boolean;
  visible: boolean;
}

const SYNTHETIC_MEASURE_ID = "__synthetic_measure__";

export function ForceGraph() {
  const tables = useStore((s) => s.tables);
  const relationships = useStore((s) => s.relationships);
  const classFilter = useStore((s) => s.classFilter);
  const selection = useStore((s) => s.selection);
  const measureGraph = useStore((s) => s.measureGraph);
  const selectTable = useStore((s) => s.selectTable);
  const pinSelection = useStore((s) => s.pinSelection);
  const diffMode = useStore((s) => s.diffMode);
  const diffStatusByTable = useStore((s) => s.diffStatusByTable);
  const diffStatusByEdge = useStore((s) => s.diffStatusByEdge);

  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null);

  // Visibility — focused subgraph on selection.
  //
  // No selection: classFilter view (the model overview).
  // Measure selected: only direct + indirect tables of that measure.
  // Table selected: only that table + its 1-hop relationship neighbors.
  //
  // During measure-graph load `measureGraph` is briefly null; the
  // `if measureGraph` guard means we fall through to classFilter for that
  // tick, which avoids an empty canvas flash.
  const visibleNodeIds = useMemo(() => {
    if (selection?.kind === "measure" && measureGraph) {
      const ids = new Set<string>();
      for (const name of measureGraph.direct_tables) ids.add(`t:${name}`);
      for (const it of measureGraph.indirect_tables) ids.add(`t:${it.table}`);
      return ids;
    }
    if (selection?.kind === "table") {
      const ids = new Set<string>([`t:${selection.name}`]);
      for (const r of relationships) {
        if (r.from_table === selection.name) ids.add(`t:${r.to_table}`);
        if (r.to_table === selection.name) ids.add(`t:${r.from_table}`);
      }
      return ids;
    }
    const visible = new Set<string>();
    for (const t of tables) {
      if (classFilter.has(t.classification)) visible.add(`t:${t.name}`);
    }
    return visible;
  }, [tables, classFilter, selection, measureGraph, relationships]);

  // Orientation: when the visible subgraph is dim-heavy (more dims than
  // facts), swap so dims become the left column and facts the top row.
  // Avoids the wide-thin bbox that auto-fit would otherwise have to shrink
  // to illegibility. No-selection (overview) view keeps the default since
  // it shows the whole model.
  const orientation: Orientation = useMemo(() => {
    if (!selection) return "dims-row";
    let dimCount = 0;
    let factCount = 0;
    for (const t of tables) {
      if (!visibleNodeIds.has(`t:${t.name}`)) continue;
      if (isDimZone(t.classification)) dimCount++;
      else if (isFactZone(t.classification)) factCount++;
    }
    return dimCount > factCount ? "dims-col" : "dims-row";
  }, [tables, visibleNodeIds, selection]);

  const layout = useMemo(() => {
    const tableLookup = new Map(tables.map((t) => [t.name, t]));

    const nodes: PositionableNode[] = tables.map((t) => ({
      id: `t:${t.name}`,
      label: t.name,
      classification: t.classification,
    }));

    const edges = relationships
      .filter((r) => tableLookup.has(r.from_table) && tableLookup.has(r.to_table))
      .map((r) => ({
        id: `r:${r.id}`,
        source: `t:${r.from_table}`,
        target: `t:${r.to_table}`,
        rel: r,
      }));

    const positions = computeBusLayout(
      nodes,
      edges,
      visibleNodeIds,
      DEFAULT_LAYOUT,
      null,
      orientation,
    );

    const nodeViews: NodeView[] = tables.map((t) => {
      const id = `t:${t.name}`;
      const pos = positions.get(id)!;
      return {
        id,
        label: t.name,
        classification: t.classification,
        sourceLabel: t.source_table,
        sourceConnector: t.source_connector,
        sourceConfidence: t.source_confidence,
        position: pos,
        visible: pos.zone !== "hidden",
      };
    });
    const nodeById = new Map(nodeViews.map((n) => [n.id, n]));

    // Edges with at least one hidden endpoint don't render at all (instead of
    // rendering at opacity 0). Cuts DOM nodes for the unrelated subgraph.
    const edgeViews: EdgeView[] = edges
      .map((e) => {
        const s = nodeById.get(e.source)!;
        const t = nodeById.get(e.target)!;
        const path = lShapedEdgePath(s.position, t.position, CARD_W, CARD_H);
        return {
          id: e.id,
          source: s,
          target: t,
          rel: e.rel,
          path,
          anomalous: isAnomalousEdge(s.position, t.position),
          visible: s.visible && t.visible,
        };
      })
      .filter((e) => e.visible);

    return { nodes: nodeViews, edges: edgeViews, positions };
  }, [tables, relationships, visibleNodeIds, orientation]);

  // Spotlight: when a measure is selected and its graph is loaded, build
  // (a) a synthetic "measure" node in the top-left corner, and
  // (b) solid direct-ref edges from it to each direct-ref table.
  const spotlight = useMemo(() => {
    if (selection?.kind !== "measure" || !measureGraph) return null;
    const directIds = new Set(measureGraph.direct_tables.map((n) => `t:${n}`));
    const indirectIds = new Set(measureGraph.indirect_tables.map((it) => `t:${it.table}`));
    const highlightedRelIds = new Set<string>();
    for (const it of measureGraph.indirect_tables) {
      for (const path of it.paths) {
        for (const hop of path.hops) {
          highlightedRelIds.add(`r:${hop.relationship_id}`);
        }
      }
    }
    // Place the synthetic measure node in the top-left corner — Tsui's
    // "measures" table position. We use the layout's origin minus a small
    // offset so it sits in the corner.
    const measureNode = {
      id: SYNTHETIC_MEASURE_ID,
      label: measureGraph.measure.name,
      x: DEFAULT_LAYOUT.originX,
      y: DEFAULT_LAYOUT.originY,
    };
    // Direct-ref edges from the synthetic measure card to each direct table.
    // Bezier attaches to the side of the target that matches its zone:
    //   - row card (top row): attach to its LEFT edge, leave from measure's RIGHT
    //   - col card (left col): attach to its TOP edge, leave from measure's BOTTOM
    const directEdges = measureGraph.direct_tables
      .map((tname) => {
        const id = `t:${tname}`;
        const t = layout.nodes.find((n) => n.id === id);
        if (!t) return null;
        const targetInRow = t.position.zone === "dim-row" || t.position.zone === "fact-row";
        let fromX: number, fromY: number, toX: number, toY: number, ctrl: string;
        if (targetInRow) {
          fromX = measureNode.x + CARD_W / 2;
          fromY = measureNode.y;
          toX = t.position.x - CARD_W / 2;
          toY = t.position.y;
          const midX = (fromX + toX) / 2;
          ctrl = `${midX},${fromY} ${midX},${toY}`;
        } else {
          fromX = measureNode.x;
          fromY = measureNode.y + CARD_H / 2;
          toX = t.position.x;
          toY = t.position.y - CARD_H / 2;
          const midY = (fromY + toY) / 2;
          ctrl = `${fromX},${midY} ${toX},${midY}`;
        }
        return {
          id: `direct:${tname}`,
          path: `M ${fromX},${fromY} C ${ctrl} ${toX},${toY}`,
        };
      })
      .filter((e): e is { id: string; path: string } => e !== null);

    return {
      measureNode,
      directIds,
      indirectIds,
      highlightedRelIds,
      directEdges,
    };
  }, [selection, measureGraph, layout]);

  // Pan/zoom setup (run once).
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const z: ZoomBehavior<SVGSVGElement, unknown> = d3zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.2, 4])
      .on("zoom", (e) => {
        select(svg).select<SVGGElement>("g.viewport").attr("transform", e.transform.toString());
      });
    select(svg).call(z);
    zoomRef.current = z;
  }, []);

  // Auto-fit viewport when selection changes. With hide-unrelated, every
  // visible node IS a related node, so we just frame the bbox of layout's
  // visible set (plus the synthetic measure card for measure-mode).
  useEffect(() => {
    const svg = svgRef.current;
    const z = zoomRef.current;
    if (!svg || !z) return;
    if (!selection) return;
    if (selection.kind === "measure" && !measureGraph) return; // wait for load

    const positioned = layout.nodes.filter((n) => n.visible);
    const points: Array<{ x: number; y: number }> = positioned.map((n) => ({
      x: n.position.x,
      y: n.position.y,
    }));
    if (selection.kind === "measure") {
      points.push({ x: DEFAULT_LAYOUT.originX, y: DEFAULT_LAYOUT.originY });
    }
    if (points.length === 0) return;

    const pad = CARD_W; // breathing room around the bbox
    const minX = Math.min(...points.map((p) => p.x)) - pad;
    const maxX = Math.max(...points.map((p) => p.x)) + pad;
    const minY = Math.min(...points.map((p) => p.y)) - pad;
    const maxY = Math.max(...points.map((p) => p.y)) + pad;
    const w = maxX - minX;
    const h = maxY - minY;

    const rect = svg.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    // Scale to fit; clamp to the configured zoom range.
    const scale = Math.min(rect.width / w, rect.height / h, 1.2);
    const clampedScale = Math.max(0.2, Math.min(4, scale));
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const tx = rect.width / 2 - cx * clampedScale;
    const ty = rect.height / 2 - cy * clampedScale;

    select(svg)
      .transition()
      .duration(550)
      .call(z.transform, zoomIdentity.translate(tx, ty).scale(clampedScale));
  }, [selection, measureGraph, layout]);

  // Reset cursor styling on mount; nothing else needs imperative DOM.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {});
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  function showTooltip(e: React.MouseEvent, n: NodeView) {
    const el = tooltipRef.current;
    if (!el) return;
    const sourceLine = n.sourceLabel
      ? `<div class="tt-source">${n.sourceConnector ? `<span class="tt-connector">${escape(n.sourceConnector)}</span> ` : ""}${escape(n.sourceLabel)}${n.sourceConfidence ? ` <span class="tt-conf tt-conf-${n.sourceConfidence}">${n.sourceConfidence}</span>` : ""}</div>`
      : "";
    el.innerHTML = `
      <div class="tt-name">${escape(n.label)}</div>
      ${sourceLine}
      <div class="tt-class">${n.classification}</div>
    `;
    el.style.opacity = "1";
    el.style.left = `${e.clientX + 14}px`;
    el.style.top = `${e.clientY + 14}px`;
  }

  function hideTooltip() {
    const el = tooltipRef.current;
    if (el) el.style.opacity = "0";
  }

  // With hide-unrelated, every node in `layout.nodes.filter(visible)` is
  // already part of the focal subgraph — no need for a "dim unrelated"
  // case here. The `n.visible` check guards against off-canvas (parked)
  // nodes the layout still keeps in the array.
  function nodeOpacity(n: NodeView): number {
    return n.visible ? 1 : 0;
  }

  function edgeOpacity(e: EdgeView): number {
    if (!spotlight) return e.anomalous ? 0.7 : 0.4;
    // Highlighted = on the measure's filter path. Other visible edges
    // still render but more faintly so the path stands out.
    if (spotlight.highlightedRelIds.has(e.id)) return 0.95;
    return 0.4;
  }

  function edgeStroke(e: EdgeView): string {
    if (e.anomalous) return "var(--warn)";
    if (spotlight?.highlightedRelIds.has(e.id)) return "var(--text-1)";
    return "var(--edge-rel)";
  }

  function edgeStrokeWidth(e: EdgeView): number {
    if (spotlight?.highlightedRelIds.has(e.id)) return 1.8;
    return 1.0;
  }

  function edgeDash(e: EdgeView): string | undefined {
    if (e.rel.is_active) return undefined;
    return "3 4";
  }

  return (
    <div ref={containerRef} className="graph-container">
      <svg
        ref={svgRef}
        className="graph-svg bus-graph"
        width="100%"
        height="100%"
        role="img"
        aria-label="Model relationship graph (bus layout)"
      >
        <defs>
          <ConnectorGlyphSprite />
          <marker
            id="arrow-fact"
            viewBox="0 -5 10 10"
            refX={9}
            refY={0}
            markerWidth={6}
            markerHeight={6}
            orient="auto"
          >
            <path d="M 0,-5 L 10,0 L 0,5 Z" fill="var(--edge-rel)" />
          </marker>
          <marker
            id="arrow-fact-hot"
            viewBox="0 -5 10 10"
            refX={9}
            refY={0}
            markerWidth={6}
            markerHeight={6}
            orient="auto"
          >
            <path d="M 0,-5 L 10,0 L 0,5 Z" fill="var(--text-1)" />
          </marker>
          <marker
            id="arrow-anomaly"
            viewBox="0 -5 10 10"
            refX={9}
            refY={0}
            markerWidth={6}
            markerHeight={6}
            orient="auto"
          >
            <path d="M 0,-5 L 10,0 L 0,5 Z" fill="var(--warn)" />
          </marker>
          <marker
            id="arrow-direct"
            viewBox="0 -5 10 10"
            refX={9}
            refY={0}
            markerWidth={7}
            markerHeight={7}
            orient="auto"
          >
            <path d="M 0,-5 L 10,0 L 0,5 Z" fill="var(--accent)" />
          </marker>
        </defs>

        <g className="viewport">
          {/* Edges first so cards render on top */}
          <g className="edges">
            {layout.edges.map((e) => {
              const diffStatus = diffStatusByEdge?.get(e.rel.id) ?? null;
              return (
                <g
                  key={e.id}
                  className={`edge${diffStatus ? ` diff-${diffStatus}` : ""}`}
                  style={{ opacity: edgeOpacity(e) }}
                >
                  <path
                    d={e.path}
                    fill="none"
                    stroke={diffStatus ? diffStrokeFor(diffStatus) : edgeStroke(e)}
                    strokeWidth={diffStatus ? 2 : edgeStrokeWidth(e)}
                    strokeDasharray={diffStatus === "removed" ? "5 4" : edgeDash(e)}
                    markerEnd={
                      e.anomalous
                        ? "url(#arrow-anomaly)"
                        : spotlight?.highlightedRelIds.has(e.id)
                          ? "url(#arrow-fact-hot)"
                          : "url(#arrow-fact)"
                    }
                  />
                  <CardinalityGlyph edge={e} kind="dim" />
                  <CardinalityGlyph edge={e} kind="fact" />
                </g>
              );
            })}
          </g>

          {/* Spotlight: direct-ref edges from synthetic measure node */}
          {spotlight && (
            <g className="direct-edges">
              {spotlight.directEdges.map((e) => (
                <path
                  key={e.id}
                  d={e.path}
                  fill="none"
                  stroke="var(--accent)"
                  strokeWidth={2}
                  markerEnd="url(#arrow-direct)"
                  opacity={0.85}
                />
              ))}
            </g>
          )}

          {/* Table cards */}
          <g className="nodes">
            {layout.nodes.map((n) => {
              const diffStatus = diffStatusByTable?.get(n.label) ?? null;
              return (
                <g
                  key={n.id}
                  className={`node node-${n.classification}${
                    diffStatus ? ` diff-${diffStatus}` : ""
                  }`}
                  style={{
                    // CSS transform (not SVG attribute) so the .bus-graph .node
                    // transition rule animates Pack-mode reshuffles smoothly.
                    transform: `translate(${n.position.x}px, ${n.position.y}px)`,
                    opacity: nodeOpacity(n),
                    cursor: diffMode ? "default" : "pointer",
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (diffMode) return; // added items 404 in BASE; disable
                    selectTable(n.label);
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    if (!diffMode) pinSelection();
                  }}
                  onMouseEnter={(e) => showTooltip(e, n)}
                  onMouseMove={(e) => showTooltip(e, n)}
                  onMouseLeave={hideTooltip}
                >
                  <rect
                    x={-CARD_W / 2}
                    y={-CARD_H / 2}
                    width={CARD_W}
                    height={CARD_H}
                    rx={4}
                    className="card-rect"
                  />
                  <NodeLabels node={n} />
                </g>
              );
            })}
          </g>

          {/* Spotlight measure node */}
          {spotlight && (
            <g
              className="node node-measure"
              transform={`translate(${spotlight.measureNode.x}, ${spotlight.measureNode.y})`}
            >
              <rect
                x={-CARD_W / 2}
                y={-CARD_H / 2}
                width={CARD_W}
                height={CARD_H}
                rx={4}
                className="card-rect measure-rect"
              />
              <text
                className="card-label measure-label"
                x={0}
                y={-2}
                textAnchor="middle"
                pointerEvents="none"
              >
                {spotlight.measureNode.label}
              </text>
              <text
                className="card-source"
                x={0}
                y={11}
                textAnchor="middle"
                pointerEvents="none"
                opacity={0.75}
              >
                DAX measure
              </text>
              <text
                x={0}
                y={-CARD_H / 2 - 4}
                textAnchor="middle"
                className="zone-tag-measure"
              >
                MEASURE
              </text>
            </g>
          )}

          {/* Zone labels — flip when orientation swaps. */}
          {orientation === "dims-row" ? (
            <>
              <ZoneLabel
                text="DIMENSIONS / TIME"
                x={DEFAULT_LAYOUT.originX + DEFAULT_LAYOUT.factToFirstDimGap - 30}
                y={DEFAULT_LAYOUT.originY - 36}
              />
              <ZoneLabel
                text="FACTS"
                x={DEFAULT_LAYOUT.originX - 50}
                y={DEFAULT_LAYOUT.originY + DEFAULT_LAYOUT.dimToFirstFactGap - 8}
                rotate={-90}
              />
            </>
          ) : (
            <>
              <ZoneLabel
                text="FACTS"
                x={DEFAULT_LAYOUT.originX + DEFAULT_LAYOUT.factToFirstDimGap - 30}
                y={DEFAULT_LAYOUT.originY - 36}
              />
              <ZoneLabel
                text="DIMENSIONS / TIME"
                x={DEFAULT_LAYOUT.originX - 50}
                y={DEFAULT_LAYOUT.originY + DEFAULT_LAYOUT.dimToFirstFactGap - 8}
                rotate={-90}
              />
            </>
          )}
        </g>
      </svg>
      <div ref={tooltipRef} className="graph-tooltip" />
    </div>
  );
}

// --------------------------------------------------------------------------- //
// Sub-components
// --------------------------------------------------------------------------- //

function CardinalityGlyph({ edge, kind }: { edge: EdgeView; kind: "dim" | "fact" }) {
  const pos = cardinalityGlyphPosition(
    edge.source.position,
    edge.target.position,
    CARD_W,
    CARD_H,
    kind,
  );
  if (!pos) return null;
  // Determine which end is the dim (always shows "1") and which is the fact.
  const sourceIsDim = isDimZone(edge.source.classification);
  const sourceIsFact = isFactZone(edge.source.classification);
  let glyph = "";
  if (kind === "dim") {
    glyph = oneSideGlyph(edge.rel.cardinality, sourceIsDim);
  } else {
    glyph = manySideGlyph(edge.rel.cardinality, sourceIsFact);
  }
  return (
    <text
      x={pos.x}
      y={pos.y}
      className="card-glyph"
      pointerEvents="none"
    >
      {glyph}
    </text>
  );
}

function ZoneLabel({
  text,
  x,
  y,
  rotate = 0,
}: {
  text: string;
  x: number;
  y: number;
  rotate?: number;
}) {
  return (
    <text
      x={x}
      y={y}
      className="zone-label"
      transform={rotate ? `rotate(${rotate}, ${x}, ${y})` : undefined}
      pointerEvents="none"
    >
      {text}
    </text>
  );
}

// --------------------------------------------------------------------------- //
// Helpers
// --------------------------------------------------------------------------- //

/** Two-line label inside a table card: semantic name on top, source identifier
 *  with connector glyph below. Glyph + text are centered as a unit; long source
 *  paths truncate via middle-ellipsis with the full string accessible through
 *  the floating tooltip (the parent <g> handles mouse events). */
function NodeLabels({ node }: { node: NodeView }) {
  const truncated = node.sourceLabel
    ? middleEllipsis(node.sourceLabel, SOURCE_LABEL_MAX)
    : null;
  const glyphId = node.classification === "calculation_group"
    ? "glyph-calc-group"
    : node.sourceLabel
      ? connectorToGlyphId(node.sourceConnector)
      : null;

  // Approximate centering of (glyph + text). Average glyph width 11px + 3px
  // gap + text width. Text width ~5.2px per char at 10px font.
  const textWidth = truncated ? truncated.length * 5.2 : 0;
  const groupWidth = glyphId ? 11 + 3 + textWidth : textWidth;
  const glyphX = -groupWidth / 2;
  const textStartX = glyphX + (glyphId ? 11 + 3 : 0);

  return (
    <>
      <text
        className="card-label"
        x={0}
        y={-2}
        textAnchor="middle"
        pointerEvents="none"
      >
        {node.label}
      </text>
      {truncated && (
        <>
          {glyphId && (
            <use
              href={`#${glyphId}`}
              x={glyphX}
              y={3}
              width={10}
              height={10}
              className="card-source-glyph"
              pointerEvents="none"
            />
          )}
          <text
            className="card-source"
            x={textStartX}
            y={11}
            textAnchor="start"
            pointerEvents="none"
          >
            {truncated}
          </text>
        </>
      )}
      {node.classification === "calculation_group" && !truncated && (
        <>
          <use
            href="#glyph-calc-group"
            x={-groupWidth / 2 - 6}
            y={3}
            width={10}
            height={10}
            className="card-source-glyph"
            pointerEvents="none"
          />
          <text
            className="card-source"
            x={4}
            y={11}
            textAnchor="middle"
            pointerEvents="none"
            opacity={0.8}
          >
            calculation group
          </text>
        </>
      )}
    </>
  );
}

/** Truncate a string longer than `max` to first-half + ellipsis + last-half so
 *  the most informative ends of a long path stay visible. */
function middleEllipsis(s: string, max: number): string {
  if (s.length <= max) return s;
  const headLen = Math.ceil((max - 1) / 2);
  const tailLen = Math.floor((max - 1) / 2);
  return s.slice(0, headLen) + "…" + s.slice(s.length - tailLen);
}

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}

/** Stroke color for an edge under diff overlay. Falls back to CSS variables
 *  so the dark/light themes can override the hue if needed. */
function diffStrokeFor(status: "added" | "removed" | "modified"): string {
  if (status === "added") return "var(--diff-added, #2faa6a)";
  if (status === "removed") return "var(--diff-removed, #d6452a)";
  return "var(--diff-modified, #d29420)";
}

/** Glyph for the "one side" of a relationship. */
function oneSideGlyph(card: Cardinality, _sourceIsDim: boolean): string {
  if (card === "many_to_many") return "*";
  return "1";
}

/** Glyph for the "many side" of a relationship. */
function manySideGlyph(card: Cardinality, _sourceIsFact: boolean): string {
  if (card === "one_to_one") return "1";
  return "*";
}
