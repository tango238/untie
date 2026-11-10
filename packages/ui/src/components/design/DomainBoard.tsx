import { Background, Controls, Handle, Position, ReactFlow, ReactFlowProvider, useReactFlow, type Node, type NodeProps } from "@xyflow/react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { cachedResolvedDomain } from "@untie/core/model/domainCache";
import { setDomainTerm } from "@untie/core/model/domainCommands";
import { applyDomainDraft, draftScopeContextIds } from "@untie/core/model/domainDraft";
import { DOMAIN_NOTICE_TITLES } from "@untie/core/model/domainNotices";
import { adoptDomainCandidates, normalizeDomainSelection, type ResolvedDomain } from "@untie/core/model/domainResolve";
import type { ScopedTerm } from "@untie/core/model/domainScope";
import { DESCRIPTION_MAX_LENGTH, ENGLISH_MAX_LENGTH } from "@untie/core/model/limits";
import { ELEMENT_KIND_LABELS, type DomainTerm } from "@untie/core/model/types";
import { useAgentStore } from "../../ai/agentStore";
import { describeChatError } from "../../ai/chat";
import { generateDomainDraft } from "../../ai/designDomain";
import { getApiKey } from "../../ai/keys";
import { PROVIDERS } from "../../ai/providers";
import { useUntieStore } from "../../store";
import { El, ElementClickContext } from "../analysis/analysisParts";
import { StormingTable } from "../analysis/StormingView";
import { CommitField } from "../CommitField";
import { ConfirmDialog } from "../ConfirmDialog";
import { useDomainEdit, useDomainElementClick } from "./domainElementClick";
import { buildAggregateFlow, buildBusinessFlow, type DomainBandData, type DomainFlowNode, type DomainNodeData, type DomainNodeKind } from "./domainFlow";

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

const onActivate = (select: () => void) => (e: React.KeyboardEvent) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    select();
  }
};

const NODE_KIND_LABELS: Record<DomainNodeKind, string> = {
  trigger: "きっかけ (外のイベント)",
  command: "コマンド",
  query: "問い合わせ",
  aggregate: "集約",
  event: "イベント",
  consumer: "受け手 (外の操作)",
  activity: "作業",
};

function DomainNode({ data }: NodeProps<Node<DomainNodeData, "domain">>) {
  const select = () => {
    if (data.selection) useUntieStore.getState().selectDesignDomain(data.selection);
  };
  return (
    <div
      className={`nokey domain-node is-${data.kind}${data.selected ? " is-selected" : ""}${data.dim ? " is-dim" : ""}${data.candidate ? " is-candidate" : ""}`}
      data-candidate={data.candidate ? "true" : undefined}
      role={data.selection ? "button" : "group"}
      tabIndex={data.selection ? 0 : undefined}
      aria-label={`${NODE_KIND_LABELS[data.kind]} ${data.label}${data.candidate ? " (候補)" : ""}${data.badges.length > 0 ? ` (${data.badges.join("、")})` : ""}${data.questions > 0 ? `、問い ${data.questions}` : ""}`}
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

/** コンテキストの帯 (図の行のまとまり。選べない) */
function BandNode({ data }: NodeProps<Node<DomainBandData, "band">>) {
  return (
    <div className="domain-band" data-domain-band>
      <div className="domain-band-name" title={data.label}>
        {data.label}
      </div>
    </div>
  );
}

const nodeTypes = { domain: DomainNode, band: BandNode };

/** 図の最初の倍率の下限。これより小さくしないと全体が入らないときは、左上から見せて残りはスクロール (パン) で見る */
const MIN_INITIAL_ZOOM = 0.75;

function DomainCanvasInner({ view, r }: { view: "aggregates" | "flow"; r: ResolvedDomain }) {
  const model = useUntieStore((s) => s.model);
  const stored = useUntieStore((s) => s.ui.designDomain);
  const selectDesignDomain = useUntieStore((s) => s.selectDesignDomain);
  const flow = useMemo(() => {
    const selected = normalizeDomainSelection(r, stored);
    return view === "aggregates" ? buildAggregateFlow(r, selected) : buildBusinessFlow(model, r, selected);
  }, [view, model, r, stored]);
  // 見せ方・対象のシステム・ノードの集合が変わったら、全体が見えるよう合わせ直す (選択では動かさない)
  const rf = useReactFlow();
  const fitKey = `${view}:${r.systemId}:${flow.nodes.map((n) => n.id).join(",")}`;
  useEffect(() => {
    const handle = window.requestAnimationFrame(() => {
      void rf.fitView({ padding: 0.15, maxZoom: 1 }).then(() => {
        // 小さくなりすぎて字が読めないときは、読める倍率で左上から見せる
        if (rf.getZoom() < MIN_INITIAL_ZOOM) void rf.setViewport({ x: 24, y: 16, zoom: MIN_INITIAL_ZOOM });
      });
    });
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
      onNodeClick={(_, node) => {
        // 選べないノード (帯・外の受け手・作業) を押しても、いまの選択は外さない
        if (node.type === "domain" && node.data.selection) selectDesignDomain(node.data.selection);
      }}
      onPaneClick={() => selectDesignDomain(undefined)}
    >
      <Background />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}

const COLUMN_HINTS: Record<"aggregates" | "flow", string> = {
  aggregates:
    "左から、きっかけ (別のところで発生するイベント) → コマンド → 集約 → イベント → 受け手 (このシステムの外の操作・イベントを起点にする作業)。行はコンテキストごとの帯。破線はポリシー (イベントをきっかけに動く操作) と外の受け手",
  flow: "操作とイベントを「次に」「発生」「きっかけ」でつなぎ、始まりから順に左から右へ並べます (破線はきっかけ = ポリシー)。つながりの無いものは右端の列",
};

/** 用語: 分析の要素から導いた行に、保存した英語名・定義 (ユビキタス言語) を重ねる。定義を入れなければ、分析の説明がそのまま定義になる */
function TermsTable({ terms, saved }: { terms: ScopedTerm[]; saved: readonly DomainTerm[] }) {
  const { readOnly, run } = useDomainEdit();
  if (terms.length === 0) return <p className="hint">用語がありません。</p>;
  const byElement = new Map(saved.flatMap((t) => (t.elementId ? [[t.elementId, t] as const] : [])));
  return (
    <table className="an-table domain-terms" aria-label="用語">
      <thead>
        <tr>
          <th>用語</th>
          <th>種類</th>
          <th>コンテキスト</th>
          <th>英語名</th>
          <th>定義 (空なら分析の説明)</th>
        </tr>
      </thead>
      <tbody>
        {terms.map((t) => {
          const term = byElement.get(t.element.id);
          return (
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
              <td className="domain-term-english">
                <CommitField label={`${t.element.name} の英語名`} value={term?.english ?? ""} maxLength={ENGLISH_MAX_LENGTH} readOnly={readOnly} onCommit={(v) => v.trim() !== (term?.english ?? "") && run((m) => setDomainTerm(m, { elementId: t.element.id, english: v }))} />
              </td>
              <td>
                <CommitField
                  label={`${t.element.name} の定義`}
                  value={term?.definition ?? ""}
                  placeholder={t.description || "— (定義なし)"}
                  multiline
                  maxLength={DESCRIPTION_MAX_LENGTH}
                  readOnly={readOnly}
                  onCommit={(v) => v.trim() !== (term?.definition ?? "") && run((m) => setDomainTerm(m, { elementId: t.element.id, definition: v }))}
                />
                {t.values.length > 0 && <span className="an-sub">値: {t.values.join("・")}</span>}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/**
 * 設計モードのドメイン: 分析から導いたドメインモデル (DDD) の候補に、保存した判断 (境界づけられたコンテキスト・集約・名前・あるべき姿) を重ねて、対象のシステムにしぼって見せる。
 * 見せ方は 4 つ (集約とイベントの図、業務の流れの図、イベントストーミングの表、用語)。位置は保存せず毎回決める。編集は左右のペインと用語の表でする
 */
export function DomainBoard() {
  const model = useUntieStore((s) => s.model);
  const systemId = useUntieStore((s) => s.ui.designSystemId);
  const pushToast = useUntieStore((s) => s.pushToast);
  const r = cachedResolvedDomain(model, systemId);
  const scope = r.scope;
  const onElementClick = useDomainElementClick(r);
  const edit = useDomainEdit();
  const [view, setView] = useState<DomainView>(loadDomainView);
  const switchView = (next: DomainView) => {
    setView(next);
    saveDomainView(next);
  };
  const empty = r.commands.length === 0 && scope.queries.length === 0 && r.events.length === 0 && r.aggregates.length === 0;
  // 集約とイベントの図は、コマンドもイベントも無いと空になる (問い合わせだけのシステム)
  const noAggregateFlow = view === "aggregates" && r.commands.length === 0 && r.events.length === 0;
  const unadopted = r.unadopted.contexts + r.unadopted.aggregates;
  const adoptAll = () => {
    if (!systemId) return;
    const done = edit.run((m) => adoptDomainCandidates(m, { systemId }));
    if (done) pushToast(done.contexts + done.aggregates === 0 ? "保存できる候補はありませんでした" : `候補から、コンテキスト ${done.contexts}・集約 ${done.aggregates} を作りました`, "info");
  };

  // AI で下書き (データボードの「情報から作る (AI)」と同じ流儀)
  const provider = useAgentStore((s) => s.settings.provider);
  const aiModels = useAgentStore((s) => s.settings.models);
  const settingsOpen = useAgentStore((s) => s.settingsOpen);
  const setSettingsOpen = useAgentStore((s) => s.setSettingsOpen);
  const startDomainTalk = useAgentStore((s) => s.startDomainTalk);
  const agentRunning = useAgentStore((s) => s.running);
  const [hasKey, setHasKey] = useState<boolean | undefined>(undefined);
  const [confirmAi, setConfirmAi] = useState(false);
  const [generating, setGenerating] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  // マウントした文書の世代。別のファイルを開いたあとに、前のファイルの下書きを書かないために覚える
  const docSeq = useRef(useUntieStore.getState().docSeq);
  useEffect(() => {
    let alive = true;
    setHasKey(undefined);
    getApiKey(provider).then(
      (k) => alive && setHasKey(!!k),
      () => alive && setHasKey(false),
    );
    return () => {
      alive = false;
    };
  }, [provider, settingsOpen]);
  useEffect(() => () => abortRef.current?.abort(), []);
  const replaced = systemId ? draftScopeContextIds(model, systemId).length : 0;
  const generate = async () => {
    if (!systemId) return;
    let apiKey: string | null;
    try {
      apiKey = await getApiKey(provider);
    } catch {
      apiKey = null;
    }
    if (!apiKey) {
      pushToast("API キーが設定されていません。「AI の設定」で入れてください", "error");
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setGenerating(true);
    try {
      const result = await generateDomainDraft(useUntieStore.getState().model, systemId, { provider, model: aiModels[provider] || PROVIDERS[provider].defaultModel, apiKey, signal: controller.signal });
      // 生成のあいだに別の文書を開いていたら、結果は捨てる
      if (useUntieStore.getState().docSeq !== docSeq.current) return;
      // 生成のあいだに変わったモデル (同時編集など) に当て直す
      const r = useUntieStore.getState().dispatch((m) => applyDomainDraft(m, { systemId, draft: result.draft }));
      if (!r.ok) pushToast(`下書きを保存できませんでした (作っているあいだに、分析かドメインモデルが変わりました): ${r.reason.split("\n")[0]}`, "error");
      else {
        const n = r.summary;
        // 置き換えたコンテキストに結ばれていた関係・ポリシーのうち、同じ英語名のものが無くて付け直せなかったものを知らせる
        const lost = n.lost.length > 0 ? `。付け直せずに消えたもの: ${n.lost.slice(0, 5).join("、")}${n.lost.length > 5 ? ` ほか ${n.lost.length - 5} 件` : ""} (元に戻すで戻せます)` : "";
        pushToast(`下書きを作りました (コンテキスト ${n.contexts}・集約 ${n.aggregates}・コマンド ${n.commands}・イベント ${n.events})。名前と境界を確かめて、直してください${lost}`, n.lost.length > 0 ? "error" : "info");
      }
    } catch (e) {
      pushToast(describeChatError(e), "error");
    } finally {
      abortRef.current = null;
      setGenerating(false);
    }
  };
  const requestGenerate = () => {
    if (replaced > 0) setConfirmAi(true);
    else void generate();
  };
  const aiDisabled = edit.readOnly || !systemId || generating || hasKey !== true || empty;

  let body: ReactNode;
  if (empty) {
    body = <p className="hint domain-empty">このシステムを対象にした操作も、このシステムが発生させるイベントもまだありません。分析で操作の対象 (このシステムか、その画面) を結ぶと、ここに候補が出ます</p>;
  } else if (noAggregateFlow) {
    body = (
      <p className="hint domain-empty">
        このシステムには、情報を書く操作 (コマンド) もイベントもありません。問い合わせ {scope.queries.length} 件は「業務の流れ」と「用語」で見られます
      </p>
    );
  } else if (view === "aggregates" || view === "flow") {
    body = (
      <div className="domain-canvas">
        <ReactFlowProvider>
          <DomainCanvasInner view={view} r={r} />
        </ReactFlowProvider>
      </div>
    );
  } else {
    body = (
      <div className="domain-scroll an-storming">
        {view === "table" ? (
          <StormingTable commands={scope.splitCommands} events={scope.events.filter((e) => e.origin === "inside").map((e) => e.row)} notices={scope.notices} />
        ) : (
          <TermsTable terms={scope.terms} saved={model.domain.terms} />
        )}
      </div>
    );
  }
  const savedCount = r.contexts.filter((c) => c.saved).length + r.aggregates.filter((a) => a.saved).length + r.commands.filter((c) => c.saved).length + r.events.filter((e) => e.saved).length;
  return (
    <section className="domain-board" aria-label="設計ボード: ドメイン">
      <div className="dsl-toolbar domain-toolbar">
        <h2 className="dsl-title">ドメインモデル</h2>
        <div className="segmented" role="group" aria-label="見せ方">
          {DOMAIN_VIEWS.map(([v, label]) => (
            <button key={v} type="button" className={view === v ? "is-active" : undefined} aria-pressed={view === v} onClick={() => switchView(v)}>
              {label}
            </button>
          ))}
        </div>
        <span className="domain-toolbar-actions">
          {!edit.readOnly && unadopted > 0 && (
            <button type="button" onClick={adoptAll} disabled={generating} title="このシステムが書く情報のある分析のコンテキストを境界づけられたコンテキストに、書く情報を 1 情報 1 集約にして保存する (AI は使わない)">
              候補から作る
            </button>
          )}
          {!edit.readOnly && (
            <button
              type="button"
              onClick={() => systemId && void startDomainTalk(systemId)}
              disabled={!systemId || generating || agentRunning || hasKey !== true || empty}
              title={hasKey === false ? "「AI の設定」で API キーを入れると使えます" : "AI の質問に答えながら、コンテキスト・集約・名前を 1 つずつ決めて保存する (分析は変えない)"}
            >
              AI と決める
            </button>
          )}
          {!edit.readOnly && (
            <button
              type="button"
              onClick={requestGenerate}
              disabled={aiDisabled}
              title={hasKey === false ? "「AI の設定」で API キーを入れると使えます" : "候補と気づきから、コンテキスト・集約と不変条件・コマンドとイベントの名前と英語名の下書きを作る (分析は変えない)"}
            >
              {generating ? "作っています…" : "AI で下書き"}
            </button>
          )}
        </span>
      </div>
      {hasKey === false && !edit.readOnly && (
        <p className="hint domain-hint">
          「AI と決める」「AI で下書き」を使うには、
          <button type="button" className="link" onClick={() => setSettingsOpen(true)}>
            AI の設定
          </button>
          で API キーを入れてください
        </p>
      )}
      <p className="hint domain-hint">
        {savedCount === 0 ? "分析から導いた候補です (破線。まだ保存していません)。" : "実線は保存したもの、破線は分析から導いた候補です。"}
        {view === "table"
          ? "表は分析から導いた候補です (現状)。要素名を押すと、ボードの中で選びます (「↗」の付いた名前は、分析のボードへ移ります)"
          : view === "terms"
            ? "英語名と定義は、ここで決めて保存します (ユビキタス言語)。定義を空にすると、分析の説明を使います"
            : !empty && !noAggregateFlow
              ? COLUMN_HINTS[view]
              : ""}
      </p>
      <ElementClickContext.Provider value={onElementClick}>{body}</ElementClickContext.Provider>
      {confirmAi && (
        <ConfirmDialog
          title="AI で下書き"
          message={`このシステムだけが実装する境界づけられたコンテキスト ${replaced} つ (と、その集約・コマンド・イベント・関係) を、AI が作った下書きに置き換えます。ほかのシステムのコンテキストと、分析は変えません。ほかのコンテキストとの関係やポリシーは、下書きに同じ英語名のものがあれば付け直します (無ければ消えます)。`}
          confirmLabel="置き換える"
          danger
          onCancel={() => setConfirmAi(false)}
          onConfirm={() => {
            setConfirmAi(false);
            void generate();
          }}
        />
      )}
    </section>
  );
}
