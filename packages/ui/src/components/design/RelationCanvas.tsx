import { Background, Controls, Handle, Position, ReactFlow, ReactFlowProvider, useReactFlow, type NodeProps } from "@xyflow/react";
import { useEffect, useMemo } from "react";
import { isDevMode } from "../../devMode";
import { useUntieStore } from "../../store";
import { cachedRelationGraph } from "./relationGraphCache";
import { buildRelationFlow, type RelationFlowNode } from "./relationFlow";

const onActivate = (select: () => void) => (e: React.KeyboardEvent) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    select();
  }
};

function InformationNode({ data }: NodeProps<Extract<RelationFlowNode, { type: "information" }>>) {
  const select = () => useUntieStore.getState().selectDesignRelation(data.selection);
  return (
    <div
      className={`nokey relation-node relation-info${data.selected ? " is-selected" : ""}${data.dim ? " is-dim" : ""}`}
      data-relation-node={`information:${data.informationId}`}
      role="button"
      tabIndex={0}
      aria-label={`情報 ${data.name}${data.unmapped ? " (未対応)" : ""}`}
      aria-pressed={data.selected}
      onKeyDown={onActivate(select)}
    >
      <span className="relation-node-name" title={data.name}>{data.name}</span>
      {data.unmapped && <span className="relation-badge is-error">未対応</span>}
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
}

function TableNode({ data }: NodeProps<Extract<RelationFlowNode, { type: "table" }>>) {
  const select = () => useUntieStore.getState().selectDesignRelation(data.selection);
  return (
    <div
      className={`nokey relation-node relation-table${data.selected ? " is-selected" : ""}${data.dim ? " is-dim" : ""}`}
      data-relation-node={`table:${data.databaseId}:${data.table}`}
      role="button"
      tabIndex={0}
      aria-label={`テーブル ${data.table}`}
      aria-pressed={data.selected}
      onKeyDown={onActivate(select)}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <div className="relation-table-head" title={data.table}>{data.table}</div>
      {data.rows.map((r) => (
        <div key={r.name} className="relation-row" data-column={r.name}>
          <span className="relation-row-name">{r.name}</span>
          <code className="relation-row-type">{r.type}</code>
          <Handle id={r.name} type="source" position={Position.Right} isConnectable={false} />
        </div>
      ))}
      {data.folded > 0 && <div className="relation-row is-folded">ほか {data.folded} 項目</div>}
    </div>
  );
}

function ScreenNode({ data }: NodeProps<Extract<RelationFlowNode, { type: "screen" }>>) {
  const select = () => useUntieStore.getState().selectDesignRelation(data.selection);
  return (
    <div
      className={`nokey relation-node relation-screen${data.selected ? " is-selected" : ""}${data.dim ? " is-dim" : ""}`}
      data-relation-node={`screen:${data.screenId}`}
      role="button"
      tabIndex={0}
      aria-label={`画面 ${data.name} (${data.hasView ? "UI あり" : "UI なし"}${data.unbound > 0 ? `、未対応の項目 ${data.unbound}` : ""})`}
      aria-pressed={data.selected}
      onKeyDown={onActivate(select)}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <span className="relation-node-name" title={data.name}>{data.name}</span>
      {data.unbound > 0 && <span className="relation-badge is-warn">未対応 {data.unbound}</span>}
      {data.hasView ? <span className="sitemap-ui-badge is-ui">UI あり</span> : <span className="sitemap-ui-badge is-no-ui">UI なし</span>}
    </div>
  );
}

/** 枠: データベース (2 つ以上のときだけ) と、集約 (ドメインモデルで決めた情報のまとまり) */
function FrameNode({ data }: NodeProps<Extract<RelationFlowNode, { type: "frame" }>>) {
  return (
    <div className="relation-frame" data-relation-frame>
      <div className="relation-frame-name" title={data.name}>{data.name}</div>
    </div>
  );
}

const nodeTypes = { information: InformationNode, table: TableNode, screen: ScreenNode, frame: FrameNode };

function RelationCanvasInner() {
  const model = useUntieStore((s) => s.model);
  const systemId = useUntieStore((s) => s.ui.designSystemId);
  const selected = useUntieStore((s) => s.ui.designRelation);
  const selectDesignRelation = useUntieStore((s) => s.selectDesignRelation);
  const graph = cachedRelationGraph(model, systemId);
  const flow = useMemo(() => buildRelationFlow(graph, selected, { aggregates: isDevMode() }), [graph, selected]);

  // 画面・情報・テーブルの集合か対象のシステムが変わったら、全体が見えるよう合わせ直す (選択では動かさない)
  const rf = useReactFlow();
  const fitKey = `${systemId}:${graph.informations.map((i) => `${i.id}${i.aggregate ? `@${i.aggregate.id}` : ""}`).join(",")}:${graph.databases.map((d) => `${d.id}[${d.tables.map((t) => t.name).join(",")}]`).join(",")}:${graph.screens.map((s) => s.id).join(",")}`;
  useEffect(() => {
    const handle = window.requestAnimationFrame(() => void rf.fitView({ padding: 0.2, maxZoom: 1 }));
    return () => window.cancelAnimationFrame(handle);
  }, [fitKey, rf]);

  return (
    <ReactFlow<RelationFlowNode>
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
      onNodeClick={(_, node) => selectDesignRelation(node.type === "frame" ? undefined : node.data.selection)}
      onPaneClick={() => selectDesignRelation(undefined)}
    >
      <Background />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}

/**
 * 設計モードの関連: 分析の情報 ↔ テーブル、テーブルの項目 ↔ 設計の画面の関連を 3 列の図で見せる (読み取り専用)。
 * 位置は保存せず毎回決め、動かせない (ズーム・パンはできる)
 */
export function RelationCanvas() {
  const model = useUntieStore((s) => s.model);
  const systemId = useUntieStore((s) => s.ui.designSystemId);
  const g = cachedRelationGraph(model, systemId);
  const empty = g.informations.length === 0 && g.databases.every((d) => d.tables.length === 0) && g.screens.length === 0;
  if (empty) {
    return (
      <section className="design-board" aria-label="設計ボード: 関連">
        <p>このシステムに結んだ情報も、テーブルも、画面もまだありません。サイトマップで画面を足し、データでテーブルを作ると、ここに関連が出ます</p>
      </section>
    );
  }
  return (
    <section className="relation-canvas" aria-label="設計ボード: 関連">
      <ReactFlowProvider>
        <RelationCanvasInner />
      </ReactFlowProvider>
    </section>
  );
}
