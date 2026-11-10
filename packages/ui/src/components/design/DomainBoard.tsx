import { Background, Controls, Handle, Position, ReactFlow, ReactFlowProvider, useReactFlow, type NodeProps } from "@xyflow/react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { cachedDomainScope } from "@untie/core/model/domainCache";
import { DOMAIN_NOTICE_TITLES } from "@untie/core/model/domainNotices";
import type { DomainScope, DomainTerm } from "@untie/core/model/domainScope";
import { ELEMENT_KIND_LABELS, type Element } from "@untie/core/model/types";
import { useUntieStore } from "../../store";
import { revealOnFixedBoard } from "../actions";
import { El, ElementClickContext } from "../analysis/analysisParts";
import { StormingTable } from "../analysis/StormingView";
import { buildAggregateFlow, buildBusinessFlow, type DomainFlowNode } from "./domainFlow";

/** ドメインボードの中央の見せ方。端末ごとに覚える */
export type DomainView = "aggregates" | "flow" | "table" | "terms";
const DOMAIN_VIEWS: readonly [DomainView, string][] = [
  ["aggregates", "集約とイベント"],
  ["flow", "業務の流れ"],
  ["table", "表"],
  ["terms", "用語"],
];
const DOMAIN_VIEW_KEY = "untie.design.domainView";

function loadDomainView(): DomainView {
  try {
    const v = localStorage.getItem(DOMAIN_VIEW_KEY);
    return DOMAIN_VIEWS.some(([k]) => k === v) ? (v as DomainView) : "aggregates";
  } catch {
    return "aggregates";
  }
}

function saveDomainView(view: DomainView) {
  try {
    localStorage.setItem(DOMAIN_VIEW_KEY, view);
  } catch {
    // 覚えられなくても切り替えはできる
  }
}

/**
 * ボードの中で要素名を押したとき: しぼった範囲にある操作・情報・イベント・コンテキストなら、ボードの中で選ぶ。
 * それ以外 (作業・アクター・状態など) は、分析のその要素の固定ボードへ移る
 */
export function useDomainElementClick(scope: DomainScope): (element: Element) => void {
  const select = useUntieStore((s) => s.selectDesignDomain);
  return useCallback(
    (element: Element) => {
      if (element.kind === "usecase" && scope.commands.some((c) => c.usecase.id === element.id)) return select({ kind: "command", id: element.id });
      if (element.kind === "information" && scope.contexts.some((c) => c.aggregates.some((a) => a.candidate.information.id === element.id))) return select({ kind: "aggregate", id: element.id });
      if (element.kind === "event" && scope.events.some((e) => e.row.event.id === element.id)) return select({ kind: "event", id: element.id });
      if (element.kind === "context" && scope.contexts.some((c) => c.context?.id === element.id)) return select({ kind: "context", id: element.id });
      revealOnFixedBoard(element.id);
    },
    [scope, select],
  );
}

const onActivate = (select: () => void) => (e: React.KeyboardEvent) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    select();
  }
};

const NODE_KIND_LABELS: Record<DomainFlowNode["data"]["kind"], string> = {
  trigger: "きっかけ (外のイベント)",
  command: "コマンド",
  query: "問い合わせ",
  aggregate: "集約",
  event: "イベント",
  consumer: "受け手 (外の操作)",
  activity: "作業",
};

function DomainNode({ data }: NodeProps<DomainFlowNode>) {
  const select = () => {
    if (data.selection) useUntieStore.getState().selectDesignDomain(data.selection);
  };
  return (
    <div
      className={`nokey domain-node is-${data.kind}${data.selected ? " is-selected" : ""}${data.dim ? " is-dim" : ""}`}
      role={data.selection ? "button" : undefined}
      tabIndex={data.selection ? 0 : undefined}
      aria-label={`${NODE_KIND_LABELS[data.kind]} ${data.label}${data.badges.length > 0 ? ` (${data.badges.join("、")})` : ""}${data.questions > 0 ? `、問い ${data.questions}` : ""}`}
      aria-pressed={data.selection ? data.selected : undefined}
      onKeyDown={data.selection ? onActivate(select) : undefined}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <div className="domain-node-head">
        <span className="domain-node-name" title={data.label}>
          {data.label}
        </span>
        {data.questions > 0 && <span className="relation-badge is-question">問い {data.questions}</span>}
      </div>
      <div className="domain-node-sub">
        {data.badges.map((b) => (
          <span key={b} className="domain-node-badge">
            {b}
          </span>
        ))}
        {data.sub && <span className="domain-node-text" title={data.sub}>{data.sub}</span>}
      </div>
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
}

const nodeTypes = { domain: DomainNode };

function DomainCanvasInner({ view, scope }: { view: "aggregates" | "flow"; scope: DomainScope }) {
  const model = useUntieStore((s) => s.model);
  const selected = useUntieStore((s) => s.ui.designDomain);
  const selectDesignDomain = useUntieStore((s) => s.selectDesignDomain);
  const flow = useMemo(() => (view === "aggregates" ? buildAggregateFlow(scope, selected) : buildBusinessFlow(model, scope, selected)), [view, model, scope, selected]);
  // 見せ方・対象のシステム・ノードの集合が変わったら、全体が見えるよう合わせ直す (選択では動かさない)
  const rf = useReactFlow();
  const fitKey = `${view}:${scope.systemId}:${flow.nodes.map((n) => n.id).join(",")}`;
  useEffect(() => {
    const handle = window.requestAnimationFrame(() => void rf.fitView({ padding: 0.15, maxZoom: 1 }));
    return () => window.cancelAnimationFrame(handle);
  }, [fitKey, rf]);
  return (
    <ReactFlow<DomainFlowNode>
      nodes={flow.nodes}
      edges={flow.edges}
      nodeTypes={nodeTypes}
      nodesDraggable={false}
      nodesConnectable={false}
      nodesFocusable={false}
      edgesFocusable={false}
      elementsSelectable={false}
      fitView
      fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
      minZoom={0.15}
      proOptions={{ hideAttribution: true }}
      onNodeClick={(_, node) => selectDesignDomain(node.data.selection)}
      onPaneClick={() => selectDesignDomain(undefined)}
    >
      <Background />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}

const COLUMN_HINTS: Record<"aggregates" | "flow", string> = {
  aggregates: "左から、きっかけ (別のところで発生するイベント) → コマンド → 集約 → イベント → 受け手 (このシステムの外の操作・イベントを起点にする作業)。破線はポリシー (イベントをきっかけに動く操作)",
  flow: "操作とイベントを「次に」「発生」「きっかけ」でつなぎ、始まりから順に左から右へ並べます。つながりの無いものは右端の列",
};

function TermsTable({ terms }: { terms: DomainTerm[] }) {
  if (terms.length === 0) return <p className="hint">用語がありません。</p>;
  return (
    <table className="an-table domain-terms" aria-label="用語">
      <thead>
        <tr>
          <th>用語</th>
          <th>種類</th>
          <th>コンテキスト</th>
          <th>説明 (定義)</th>
        </tr>
      </thead>
      <tbody>
        {terms.map((t) => (
          <tr key={t.element.id} data-testid={`term-${t.element.id}`}>
            <th scope="row">
              <El element={t.element} />
              {t.homonym && (
                <span className="an-note level-question" title={DOMAIN_NOTICE_TITLES.homonym}>
                  同じ語が別の文脈に
                </span>
              )}
            </th>
            <td>{t.kind === "usecase" ? "操作" : ELEMENT_KIND_LABELS[t.kind]}</td>
            <td>{t.context?.name ?? <span className="an-sub">未分類</span>}</td>
            <td>
              {t.description || <span className="an-empty">— (定義なし)</span>}
              {t.values.length > 0 && <span className="an-sub">値: {t.values.join("・")}</span>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * 設計モードのドメイン: 分析から導いたドメインモデル (DDD) の候補を、対象のシステムにしぼって見せる (読み取り専用。段階 1b)。
 * 見せ方は 4 つ (集約とイベントの図、業務の流れの図、イベントストーミングの表、用語)。位置は保存せず毎回決める
 */
export function DomainBoard() {
  const model = useUntieStore((s) => s.model);
  const systemId = useUntieStore((s) => s.ui.designSystemId);
  const scope = cachedDomainScope(model, systemId);
  const onElementClick = useDomainElementClick(scope);
  const [view, setView] = useState<DomainView>(loadDomainView);
  const switchView = (next: DomainView) => {
    setView(next);
    saveDomainView(next);
  };
  const empty = scope.commands.length === 0 && scope.queries.length === 0 && scope.events.length === 0;
  let body: ReactNode;
  if (empty) {
    body = <p className="hint domain-empty">このシステムを対象にした操作も、このシステムが発生させるイベントもまだありません。分析で操作の対象 (このシステムか、その画面) を結ぶと、ここに候補が出ます</p>;
  } else if (view === "aggregates" || view === "flow") {
    body = (
      <div className="domain-canvas">
        <ReactFlowProvider>
          <DomainCanvasInner view={view} scope={scope} />
        </ReactFlowProvider>
      </div>
    );
  } else {
    body = (
      <div className="domain-scroll an-storming">
        {view === "table" ? <StormingTable commands={scope.splitCommands} events={scope.events.map((e) => e.row)} notices={scope.notices} /> : <TermsTable terms={scope.terms} />}
      </div>
    );
  }
  return (
    <section className="domain-board" aria-label="設計ボード: ドメイン">
      <div className="dsl-toolbar domain-toolbar">
        <h2 className="dsl-title">ドメインモデルの候補</h2>
        <div className="segmented" role="group" aria-label="見せ方">
          {DOMAIN_VIEWS.map(([v, label]) => (
            <button key={v} type="button" className={view === v ? "is-active" : undefined} aria-pressed={view === v} onClick={() => switchView(v)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <p className="hint domain-hint">
        分析から導いた候補です (保存はしません)。{!empty && (view === "aggregates" || view === "flow") ? COLUMN_HINTS[view] : "要素名を押すと、ボードの中で選ぶか、分析のボードへ移ります"}
      </p>
      <ElementClickContext.Provider value={onElementClick}>{body}</ElementClickContext.Provider>
    </section>
  );
}
