import { Background, Controls, Handle, Position, ReactFlow, ReactFlowProvider, useReactFlow, type NodeProps } from "@xyflow/react";
import { useEffect, useMemo } from "react";
import { useUntieStore } from "../../store";
import { cachedEntryNotes } from "./entryNotesCache";
import { buildSitemapFlow, type SitemapFlowNode } from "./sitemapFlow";

/** サイトマップの画面 1 つ。画面名、入口の印、入口の注記 (1 行) を出す */
function ScreenNode({ data }: NodeProps<SitemapFlowNode>) {
  return (
    <div
      className={`sitemap-node${data.selected ? " is-selected" : ""}${data.builtin ? " is-builtin" : ""}${data.entry ? " is-entry" : ""}`}
      data-sitemap-node={data.designScreenId}
      role="button"
      tabIndex={0}
      aria-label={data.entry ? `${data.name} (入口)` : data.name}
      aria-pressed={data.selected}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          useUntieStore.getState().selectDesignScreen(data.designScreenId);
        }
      }}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <div className="sitemap-node-head">
        <span className="sitemap-node-name">{data.name}</span>
        {data.entry && <span className="sitemap-entry-badge">入口</span>}
      </div>
      {data.note && (
        <div className="sitemap-node-note" title={data.note}>
          {data.note}
        </div>
      )}
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
}

const nodeTypes = { screen: ScreenNode };

function SitemapCanvasInner() {
  const model = useUntieStore((s) => s.model);
  const systemId = useUntieStore((s) => s.ui.designSystemId);
  const selectedId = useUntieStore((s) => s.ui.designScreenId);
  const selectedTransitionId = useUntieStore((s) => s.ui.designTransitionId);
  const selectDesignScreen = useUntieStore((s) => s.selectDesignScreen);
  const design = model.designs.find((d) => d.systemId === systemId);

  const notes = useMemo(() => (design && systemId ? cachedEntryNotes(model, systemId, design) : new Map<string, string[]>()), [model, systemId, design]);
  const flow = useMemo(
    () => (design ? buildSitemapFlow(model, design, notes, selectedId, selectedTransitionId) : { nodes: [], edges: [] }),
    [model, design, notes, selectedId, selectedTransitionId],
  );

  // 画面の集合か対象のシステムが変わったら、全体が見えるよう合わせ直す (選択や文言の変更では動かさない)
  const rf = useReactFlow();
  const fitKey = `${systemId}:${(design?.screens ?? []).map((s) => s.id).join(",")}`;
  useEffect(() => {
    const handle = window.requestAnimationFrame(() => void rf.fitView({ padding: 0.2, maxZoom: 1 }));
    return () => window.cancelAnimationFrame(handle);
  }, [fitKey, rf]);

  return (
    <ReactFlow
      nodes={flow.nodes}
      edges={flow.edges}
      nodeTypes={nodeTypes}
      nodesDraggable={false}
      nodesConnectable={false}
      nodesFocusable={false}
      edgesFocusable={false}
      elementsSelectable={false}
      fitView
      fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
      minZoom={0.2}
      proOptions={{ hideAttribution: true }}
      onNodeClick={(_, node) => selectDesignScreen(node.id)}
      onEdgeClick={(_, edge) => selectDesignScreen(edge.source, edge.id)}
      onPaneClick={() => selectDesignScreen(undefined)}
    >
      <Background />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}

/**
 * 設計モードのサイトマップ: 画面をノード、遷移をエッジに描く。位置は保存せず、入口の画面から層に分けて左から右へ並べる
 * (動かせない。ズーム・パンはできる)。画面が 1 つも無いときは案内を出す
 */
export function SitemapCanvas() {
  const systemId = useUntieStore((s) => s.ui.designSystemId);
  const count = useUntieStore((s) => s.model.designs.find((d) => d.systemId === systemId)?.screens.length ?? 0);
  if (count === 0) {
    return (
      <section className="design-board" aria-label="設計ボード: サイトマップ">
        <p>左の一覧で活動や作業を選ぶと、関連する画面が遷移と一緒に加わります</p>
      </section>
    );
  }
  return (
    <section className="sitemap-canvas" aria-label="設計ボード: サイトマップ">
      <ReactFlowProvider>
        <SitemapCanvasInner />
      </ReactFlowProvider>
    </section>
  );
}
