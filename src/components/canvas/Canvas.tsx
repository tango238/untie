import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  useReactFlow,
  type Connection,
  type Edge,
  type NodeChange,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useState, type DragEvent } from "react";
import { addRelation } from "../../model/commands";
import { relationKindFor } from "../../model/relations";
import { useUntieStore } from "../../store";
import { placeElement } from "../actions";
import { ELEMENT_DRAG_TYPE, canvasApi } from "./canvasApi";
import { CardNode } from "./CardNode";
import { applyDropDecision, decideDrop } from "./drop";
import { applyFlowChanges } from "./flowChanges";
import { FrameNode } from "./FrameNode";
import {
  buildFlowEdges,
  buildFlowNodes,
  CARD_SIZE,
  type FlowNode,
} from "./toFlow";

const nodeTypes = { frame: FrameNode, card: CardNode };

function CanvasInner() {
  const model = useUntieStore((s) => s.model);
  const boardId = useUntieStore((s) => s.ui.currentBoardId);
  const selection = useUntieStore((s) => s.ui.selection);
  const rf = useReactFlow();

  const selectedElementId = selection?.type === "element" ? selection.id : null;
  const selectedRelationId = selection?.type === "relation" ? selection.id : null;

  const built = useMemo(
    () => buildFlowNodes(model, boardId, { selectedElementId }),
    [model, boardId, selectedElementId],
  );
  const edges = useMemo(
    () => buildFlowEdges(model, boardId, { selectedRelationId }),
    [model, boardId, selectedRelationId],
  );

  // React Flow が測った寸法やドラッグ中の状態は手元の state に持ち、座標などはモデルから流し込む
  const [nodes, setNodes] = useState<FlowNode[]>(built);
  useEffect(() => {
    setNodes((prev) => {
      const prevById = new Map(prev.map((n) => [n.id, n]));
      return built.map((n) => {
        const p = prevById.get(n.id);
        return p ? ({ ...n, measured: p.measured, dragging: p.dragging } as FlowNode) : n;
      });
    });
  }, [built]);

  // ツールバー・要素一覧から使う操作を登録する
  useEffect(() => {
    canvasApi.getCenter = () => {
      const el = document.querySelector(".react-flow");
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return rf.screenToFlowPosition({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
    };
    canvasApi.focus = (elementId) => {
      const n = rf.getInternalNode(elementId);
      if (!n) return;
      const w = n.measured.width ?? CARD_SIZE.width;
      const h = n.measured.height ?? CARD_SIZE.height;
      const p = n.internals.positionAbsolute;
      void rf.setCenter(p.x + w / 2, p.y + h / 2, { zoom: rf.getZoom(), duration: 300 });
    };
    return () => {
      canvasApi.getCenter = undefined;
      canvasApi.focus = undefined;
    };
  }, [rf]);

  const onNodesChange = useCallback((changes: NodeChange<FlowNode>[]) => {
    const applicable = changes.filter((c) => c.type !== "remove");
    setNodes((ns) => applyNodeChanges(applicable, ns));
    // 最新のモデルに対して 1 回のコマンドで反映する (ドラッグ中は履歴に積まない)
    useUntieStore.getState().previewCommand((m) => applyFlowChanges(m, useUntieStore.getState().ui.currentBoardId, applicable));
  }, []);

  const onNodeDragStart = useCallback((_: unknown, node: FlowNode) => {
    useUntieStore.getState().select({ type: "element", id: node.id });
  }, []);

  const onNodeDragStop = useCallback((_: unknown, node: FlowNode) => {
    const st = useUntieStore.getState();
    const bid = st.ui.currentBoardId;
    const decision = decideDrop(st.model, bid, node.id);
    if (decision.type === "none") {
      st.commitDrag();
      return;
    }
    st.commitDrag((m) => applyDropDecision(m, bid, decision));
    if (decision.type === "clamp") st.pushToast("BUC は業務の枠の中に置いてください", "info");
  }, []);

  const onConnect = useCallback((c: Connection) => {
    if (!c.source || !c.target) return;
    const result = useUntieStore.getState().dispatch((m) => addRelation(m, { sourceId: c.source, targetId: c.target }));
    if (!result.ok) useUntieStore.getState().pushToast(result.reason, "error");
  }, []);

  const isValidConnection = useCallback((c: Connection | Edge) => {
    if (!c.source || !c.target || c.source === c.target) return false;
    const els = useUntieStore.getState().model.elements;
    const s = els.find((e) => e.id === c.source);
    const t = els.find((e) => e.id === c.target);
    return !!s && !!t && relationKindFor(s.kind, t.kind) !== null;
  }, []);

  const onDragOver = useCallback((e: DragEvent) => {
    if (!e.dataTransfer.types.includes(ELEMENT_DRAG_TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }, []);

  const onDrop = useCallback(
    (e: DragEvent) => {
      const elementId = e.dataTransfer.getData(ELEMENT_DRAG_TYPE);
      if (!elementId) return;
      e.preventDefault();
      const st = useUntieStore.getState();
      const el = st.model.elements.find((x) => x.id === elementId);
      if (!el) return;
      const p = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
      const isFrame = el.kind === "business" || el.kind === "buc";
      const position = isFrame ? p : { x: p.x - CARD_SIZE.width / 2, y: p.y - CARD_SIZE.height / 2 };
      const result = placeElement(elementId, position);
      if (!result.ok) st.pushToast(result.reason, "info");
      st.select({ type: "element", id: elementId });
    },
    [rf],
  );

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onNodeDragStart={onNodeDragStart}
      onNodeDragStop={onNodeDragStop}
      onConnect={onConnect}
      isValidConnection={isValidConnection}
      onNodeClick={(_, n) => {
        const st = useUntieStore.getState();
        st.select({ type: "element", id: n.id });
        st.setRightPanel("properties");
      }}
      onEdgeClick={(_, edge) => {
        const st = useUntieStore.getState();
        st.select({ type: "relation", id: edge.id });
        st.setRightPanel("properties");
      }}
      onPaneClick={() => useUntieStore.getState().select(null)}
      onDragOver={onDragOver}
      onDrop={onDrop}
      deleteKeyCode={null}
      elevateNodesOnSelect={false}
      disableKeyboardA11y
      selectionKeyCode={null}
      fitView
      fitViewOptions={{ padding: 0.08, maxZoom: 1 }}
      minZoom={0.1}
      maxZoom={2}
      elementsSelectable
      nodesConnectable
      zoomOnDoubleClick={false}
    >
      <Background gap={20} />
      <Controls showInteractive={false} />
      <MiniMap pannable zoomable nodeClassName={(n) => `mini-${(n.data as { kind?: string }).kind ?? "x"}`} />
    </ReactFlow>
  );
}

export function Canvas() {
  // ボードごとに作り直す (ローカルのノード state・表示位置を持ち越さない)
  const boardId = useUntieStore((s) => s.ui.currentBoardId);
  return (
    <ReactFlowProvider key={boardId}>
      <CanvasInner />
    </ReactFlowProvider>
  );
}
