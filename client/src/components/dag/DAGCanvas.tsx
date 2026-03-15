/**
 * DAGCanvas — Phase 6.2
 *
 * Pure SVG-based DAG editor. No external graph library required.
 *
 * Features:
 * - Drag stages by clicking and dragging their header
 * - Click an edge to open condition dialog
 * - Click "connect" button on a stage to start drawing an edge, then click target
 * - Delete stages and edges
 * - Stage positions persisted in the DAG config
 */
import { useState, useRef, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Plus, Trash2, GitMerge, X } from "lucide-react";
import type { DAGCondition } from "./ConditionDialog";

export interface DAGStageNode {
  id: string;
  teamId: string;
  modelSlug: string;
  enabled: boolean;
  position: { x: number; y: number };
  label?: string;
}

export interface DAGEdgeData {
  id: string;
  from: string;
  to: string;
  condition?: DAGCondition | null;
  label?: string;
}

interface DAGCanvasProps {
  stages: DAGStageNode[];
  edges: DAGEdgeData[];
  onStagesChange: (stages: DAGStageNode[]) => void;
  onEdgesChange: (edges: DAGEdgeData[]) => void;
  onEdgeConditionClick: (edgeId: string, current?: DAGCondition | null) => void;
}

const NODE_WIDTH = 160;
const NODE_HEIGHT = 64;
const CANVAS_W = 900;
const CANVAS_H = 520;

/** Computes the center point of a node's right or left side for edge anchoring. */
function nodePort(
  stage: DAGStageNode,
  side: "left" | "right",
): { x: number; y: number } {
  const x = side === "right"
    ? stage.position.x + NODE_WIDTH
    : stage.position.x;
  return { x, y: stage.position.y + NODE_HEIGHT / 2 };
}

/** Computes an SVG cubic bezier path between two ports. */
function edgePath(
  from: { x: number; y: number },
  to: { x: number; y: number },
): string {
  const dx = Math.max(60, Math.abs(to.x - from.x) * 0.6);
  return `M ${from.x} ${from.y} C ${from.x + dx} ${from.y} ${to.x - dx} ${to.y} ${to.x} ${to.y}`;
}

/** Returns midpoint of a cubic bezier at t=0.5. */
function bezierMid(
  from: { x: number; y: number },
  to: { x: number; y: number },
): { x: number; y: number } {
  const dx = Math.max(60, Math.abs(to.x - from.x) * 0.6);
  const t = 0.5;
  const cx1 = from.x + dx;
  const cy1 = from.y;
  const cx2 = to.x - dx;
  const cy2 = to.y;
  const x =
    (1 - t) ** 3 * from.x +
    3 * (1 - t) ** 2 * t * cx1 +
    3 * (1 - t) * t ** 2 * cx2 +
    t ** 3 * to.x;
  const y =
    (1 - t) ** 3 * from.y +
    3 * (1 - t) ** 2 * t * cy1 +
    3 * (1 - t) * t ** 2 * cy2 +
    t ** 3 * to.y;
  return { x, y };
}

export default function DAGCanvas({
  stages,
  edges,
  onStagesChange,
  onEdgesChange,
  onEdgeConditionClick,
}: DAGCanvasProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [dragging, setDragging] = useState<{ id: string; offsetX: number; offsetY: number } | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null); // stage ID being connected FROM
  const [mousePos, setMousePos] = useState<{ x: number; y: number } | null>(null);

  // ── Stage dragging ────────────────────────────────────────────────────────

  const getSVGPoint = useCallback((e: React.MouseEvent): { x: number; y: number } => {
    const svg = svgRef.current;
    if (!svg) return { x: e.clientX, y: e.clientY };
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const svgPt = pt.matrixTransform(svg.getScreenCTM()?.inverse());
    return { x: svgPt.x, y: svgPt.y };
  }, []);

  const handleNodeMouseDown = useCallback(
    (e: React.MouseEvent, stageId: string) => {
      if (connecting) return; // don't drag while connecting
      e.stopPropagation();
      const pt = getSVGPoint(e);
      const stage = stages.find((s) => s.id === stageId);
      if (!stage) return;
      setDragging({
        id: stageId,
        offsetX: pt.x - stage.position.x,
        offsetY: pt.y - stage.position.y,
      });
    },
    [connecting, getSVGPoint, stages],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      const pt = getSVGPoint(e);
      setMousePos(pt);

      if (!dragging) return;
      const newX = Math.max(0, Math.min(CANVAS_W - NODE_WIDTH, pt.x - dragging.offsetX));
      const newY = Math.max(0, Math.min(CANVAS_H - NODE_HEIGHT, pt.y - dragging.offsetY));
      onStagesChange(
        stages.map((s) =>
          s.id === dragging.id ? { ...s, position: { x: newX, y: newY } } : s,
        ),
      );
    },
    [dragging, getSVGPoint, onStagesChange, stages],
  );

  const handleMouseUp = useCallback(() => {
    setDragging(null);
  }, []);

  // ── Edge connecting ────────────────────────────────────────────────────────

  const handleConnectStart = useCallback((e: React.MouseEvent, stageId: string) => {
    e.stopPropagation();
    setConnecting(stageId);
  }, []);

  const handleConnectTarget = useCallback(
    (e: React.MouseEvent, targetId: string) => {
      e.stopPropagation();
      if (!connecting || connecting === targetId) {
        setConnecting(null);
        return;
      }
      // Prevent duplicate edges
      const exists = edges.some((ed) => ed.from === connecting && ed.to === targetId);
      if (!exists) {
        onEdgesChange([
          ...edges,
          { id: `e-${crypto.randomUUID()}`, from: connecting, to: targetId },
        ]);
      }
      setConnecting(null);
    },
    [connecting, edges, onEdgesChange],
  );

  const handleCanvasClick = useCallback(() => {
    if (connecting) setConnecting(null);
  }, [connecting]);

  // ── Delete ──────────────────────────────────────────────────────────────────

  const deleteStage = useCallback(
    (stageId: string) => {
      onStagesChange(stages.filter((s) => s.id !== stageId));
      onEdgesChange(edges.filter((e) => e.from !== stageId && e.to !== stageId));
    },
    [edges, onEdgesChange, onStagesChange, stages],
  );

  const deleteEdge = useCallback(
    (edgeId: string) => {
      onEdgesChange(edges.filter((e) => e.id !== edgeId));
    },
    [edges, onEdgesChange],
  );

  // ── Add stage ──────────────────────────────────────────────────────────────

  const addStage = useCallback(() => {
    const newStage: DAGStageNode = {
      id: `stage-${crypto.randomUUID()}`,
      teamId: "planning",
      modelSlug: "mock",
      enabled: true,
      position: { x: 80 + stages.length * 40, y: 80 + (stages.length % 3) * 100 },
      label: `Stage ${stages.length + 1}`,
    };
    onStagesChange([...stages, newStage]);
  }, [onStagesChange, stages]);

  // ── Render ─────────────────────────────────────────────────────────────────

  const stageMap = new Map(stages.map((s) => [s.id, s]));

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={addStage}>
          <Plus className="h-3 w-3" /> Add Stage
        </Button>
        {connecting && (
          <Badge variant="secondary" className="text-xs gap-1">
            <GitMerge className="h-3 w-3" />
            Click a target stage to connect
            <button className="ml-1" onClick={() => setConnecting(null)}>
              <X className="h-3 w-3" />
            </button>
          </Badge>
        )}
      </div>

      <div
        className="border border-border rounded-lg overflow-hidden bg-muted/20"
        style={{ cursor: connecting ? "crosshair" : "default" }}
      >
        <svg
          ref={svgRef}
          width={CANVAS_W}
          height={CANVAS_H}
          viewBox={`0 0 ${CANVAS_W} ${CANVAS_H}`}
          className="w-full"
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onClick={handleCanvasClick}
        >
          <defs>
            <marker
              id="arrowhead"
              markerWidth="8"
              markerHeight="6"
              refX="6"
              refY="3"
              orient="auto"
            >
              <polygon points="0 0, 8 3, 0 6" className="fill-border" />
            </marker>
          </defs>

          {/* Render edges */}
          {edges.map((edge) => {
            const fromStage = stageMap.get(edge.from);
            const toStage = stageMap.get(edge.to);
            if (!fromStage || !toStage) return null;

            const fromPt = nodePort(fromStage, "right");
            const toPt = nodePort(toStage, "left");
            const mid = bezierMid(fromPt, toPt);
            const path = edgePath(fromPt, toPt);
            const hasCondition = !!edge.condition;

            return (
              <g key={edge.id}>
                {/* Wider invisible hit area */}
                <path
                  d={path}
                  fill="none"
                  stroke="transparent"
                  strokeWidth={12}
                  className="cursor-pointer"
                  onClick={(e) => {
                    e.stopPropagation();
                    onEdgeConditionClick(edge.id, edge.condition);
                  }}
                />
                {/* Visible edge */}
                <path
                  d={path}
                  fill="none"
                  className={hasCondition ? "stroke-primary" : "stroke-border"}
                  strokeWidth={hasCondition ? 2 : 1.5}
                  strokeDasharray={hasCondition ? "none" : undefined}
                  markerEnd="url(#arrowhead)"
                />
                {/* Condition label badge */}
                {hasCondition && edge.condition && (
                  <g
                    className="cursor-pointer"
                    onClick={(e) => {
                      e.stopPropagation();
                      onEdgeConditionClick(edge.id, edge.condition);
                    }}
                  >
                    <rect
                      x={mid.x - 32}
                      y={mid.y - 9}
                      width={64}
                      height={18}
                      rx={4}
                      className="fill-primary/10 stroke-primary"
                      strokeWidth={0.5}
                    />
                    <text
                      x={mid.x}
                      y={mid.y + 4}
                      textAnchor="middle"
                      className="fill-primary text-[9px]"
                      fontSize={9}
                    >
                      {edge.condition.field} {edge.condition.operator}
                    </text>
                  </g>
                )}
                {/* Delete edge button */}
                <g
                  className="cursor-pointer"
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteEdge(edge.id);
                  }}
                >
                  <circle cx={mid.x + 40} cy={mid.y} r={7} className="fill-destructive/80" />
                  <text
                    x={mid.x + 40}
                    y={mid.y + 4}
                    textAnchor="middle"
                    className="fill-white"
                    fontSize={10}
                    fontWeight="bold"
                  >
                    x
                  </text>
                </g>
              </g>
            );
          })}

          {/* Ghost edge while connecting */}
          {connecting && mousePos && (() => {
            const fromStage = stageMap.get(connecting);
            if (!fromStage) return null;
            const fromPt = nodePort(fromStage, "right");
            return (
              <path
                d={edgePath(fromPt, mousePos)}
                fill="none"
                className="stroke-primary/50"
                strokeWidth={1.5}
                strokeDasharray="5,3"
                pointerEvents="none"
              />
            );
          })()}

          {/* Render stages */}
          {stages.map((stage) => {
            const isConnecting = connecting === stage.id;
            const isTarget = connecting && connecting !== stage.id;

            return (
              <g key={stage.id}>
                {/* Stage node background */}
                <rect
                  x={stage.position.x}
                  y={stage.position.y}
                  width={NODE_WIDTH}
                  height={NODE_HEIGHT}
                  rx={6}
                  className={[
                    "fill-card stroke-border transition-colors",
                    isTarget ? "stroke-primary stroke-2 cursor-pointer" : "",
                    isConnecting ? "stroke-primary" : "",
                  ].join(" ")}
                  strokeWidth={isTarget || isConnecting ? 2 : 1}
                  onMouseDown={(e) => handleNodeMouseDown(e, stage.id)}
                  onClick={(e) => isTarget ? handleConnectTarget(e, stage.id) : undefined}
                />

                {/* Stage label */}
                <text
                  x={stage.position.x + NODE_WIDTH / 2}
                  y={stage.position.y + 20}
                  textAnchor="middle"
                  className="fill-foreground text-xs font-medium select-none pointer-events-none"
                  fontSize={11}
                  fontWeight={500}
                >
                  {(stage.label ?? stage.teamId).slice(0, 18)}
                </text>

                {/* Model slug */}
                <text
                  x={stage.position.x + NODE_WIDTH / 2}
                  y={stage.position.y + 36}
                  textAnchor="middle"
                  className="fill-muted-foreground select-none pointer-events-none"
                  fontSize={9}
                >
                  {stage.modelSlug.slice(0, 22)}
                </text>

                {/* Connect button */}
                <g
                  className="cursor-pointer"
                  onClick={(e) => handleConnectStart(e, stage.id)}
                >
                  <circle
                    cx={stage.position.x + NODE_WIDTH}
                    cy={stage.position.y + NODE_HEIGHT / 2}
                    r={7}
                    className="fill-primary/80 stroke-primary"
                    strokeWidth={1}
                  />
                  <text
                    x={stage.position.x + NODE_WIDTH}
                    y={stage.position.y + NODE_HEIGHT / 2 + 4}
                    textAnchor="middle"
                    className="fill-white select-none pointer-events-none"
                    fontSize={11}
                    fontWeight="bold"
                  >
                    +
                  </text>
                </g>

                {/* Delete button */}
                <g
                  className="cursor-pointer"
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteStage(stage.id);
                  }}
                >
                  <circle
                    cx={stage.position.x + NODE_WIDTH - 8}
                    cy={stage.position.y + 8}
                    r={6}
                    className="fill-destructive/70"
                  />
                  <text
                    x={stage.position.x + NODE_WIDTH - 8}
                    y={stage.position.y + 12}
                    textAnchor="middle"
                    className="fill-white select-none pointer-events-none"
                    fontSize={9}
                    fontWeight="bold"
                  >
                    x
                  </text>
                </g>
              </g>
            );
          })}
        </svg>
      </div>

      <p className="text-[10px] text-muted-foreground">
        Drag stages to reposition. Click the blue + button on a stage to draw an edge.
        Click any edge to add/edit a condition. Red x buttons delete stages or edges.
      </p>
    </div>
  );
}
