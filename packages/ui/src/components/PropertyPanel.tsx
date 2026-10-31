import { useEffect, useMemo, useRef, useState } from "react";
import {
  addRelation,
  moveActivity,
  moveBuc,
  moveToContext,
  removeElement,
  removeFromBoard,
  removeRelation,
  setEdgeSides,
  setIssueTargets,
  updateElement,
} from "@untie/core/model/commands";
import { relationKindFor, relationLabel, relationRule, sameRelation } from "@untie/core/model/relations";
import { suggestContext } from "@untie/core/model/contexts";
import { lineage } from "@untie/core/model/lineage";
import { FIXED_LAYER_LABELS, fixedBoardId, fixedLayerOf, type FixedLayer } from "@untie/core/model/fixedBoards";
import { activityHours, defaultBucOf, formatHours, issueScope, issuesTargeting, listableElements } from "@untie/core/model/selectors";
import {
  DEFAULT_EDGE_SIDES,
  EDGE_SIDES,
  EDGE_SIDE_LABELS,
  ELEMENT_KIND_LABELS,
  isContextMemberKind,
  isIssueTargetKind,
  issueScopeOfKind,
  ISSUE_ANALYSIS_KEYS,
  ISSUE_ANALYSIS_LABELS,
  ISSUE_ANALYSIS_QUESTIONS,
  ISSUE_SCOPE_LABELS,
  ISSUE_SCOPE_TARGETS,
  OVERALL_ISSUE_TARGET_KINDS,
  SPECIFIC_ISSUE_TARGET_KINDS,
  type IssueTargetKind,
  type Activity,
  type Board,
  type Buc,
  type EdgeSide,
  type Element,
  type Issue,
  type Link,
  type Relation,
  type UntieModel,
  type Variation,
} from "@untie/core/model/types";
import { isAnalysisBoard, isFixedBoard, selectReadOnly, useUntieStore } from "../store";
import { createIssue, goToLayer, revealOnFixedBoard, selectAndReveal } from "./actions";
import { useAgentStore } from "../ai/agentStore";
import { getPlatform } from "../platform";
import { CommitField } from "./CommitField";
import { usePeersSelecting } from "./PeerMarks";
import { HoursField } from "./Hours";
import { GRANULARITY, isGuideKind } from "./granularity";

export function PropertyPanel() {
  const model = useUntieStore((s) => s.model);
  const selection = useUntieStore((s) => s.ui.selection);

  if (!selection) {
    return (
      <aside className="property-panel" aria-label="プロパティ">
        <h2 className="panel-title">プロパティ</h2>
        <p className="hint">要素や線を選ぶと、ここで内容を編集できます。</p>
      </aside>
    );
  }
  if (selection.type === "relation") {
    const relation = model.relations.find((r) => r.id === selection.id);
    return (
      <aside className="property-panel" aria-label="プロパティ">
        <h2 className="panel-title">プロパティ</h2>
        {relation ? <RelationEditor relation={relation} model={model} /> : null}
      </aside>
    );
  }
  const element = model.elements.find((e) => e.id === selection.id);
  return (
    <aside className="property-panel" aria-label="プロパティ">
      <h2 className="panel-title">プロパティ</h2>
      {element ? <ElementEditor key={element.id} element={element} model={model} /> : null}
    </aside>
  );
}

// ---------------------------------------------------------------- 線

function RelationEditor({ relation, model }: { relation: Relation; model: UntieModel }) {
  const boardId = useUntieStore((s) => s.ui.currentBoardId);
  const source = model.elements.find((e) => e.id === relation.sourceId);
  const target = model.elements.find((e) => e.id === relation.targetId);
  const rule = relationRule(relation.kind);
  const readOnly = useUntieStore(selectReadOnly);
  const sourceLabel = rule.undirected ? "両端" : "始点";
  const targetLabel = rule.undirected ? "もう一方" : "終点";
  // 自由ボードでは、線をどの辺から出してどの辺に入れるかをそのボードだけで変えられる
  const board = model.boards.find((b) => b.id === boardId);
  const onBoard = !!board && [relation.sourceId, relation.targetId].every((id) => board.nodes.some((n) => n.elementId === id));
  return (
    <div className="editor" data-testid="relation-editor">
      <div className="kind-line">関係</div>
      <div className="field">
        <span className="field-label">関係名</span>
        <div className="static-value">{relationLabel(relation.kind)}</div>
      </div>
      <div className="field">
        <span className="field-label">{sourceLabel}</span>
        {source && (
          <button type="button" className="link" onClick={() => selectAndReveal(source.id)}>
            {source.name}
          </button>
        )}
      </div>
      <div className="field">
        <span className="field-label">{targetLabel}</span>
        {target && (
          <button type="button" className="link" onClick={() => selectAndReveal(target.id)}>
            {target.name}
          </button>
        )}
      </div>
      {onBoard && <EdgeSidesEditor board={board} relation={relation} sourceLabel={sourceLabel} targetLabel={targetLabel} readOnly={readOnly} />}
      <p className="hint">関係の追加・削除は固定ボードで、要素を選んで行います。</p>
    </div>
  );
}

/** 線の付け根 (このボードだけ): 始点・終点それぞれ、要素のどの辺に付けるか */
function EdgeSidesEditor({
  board,
  relation,
  sourceLabel,
  targetLabel,
  readOnly,
}: {
  board: Board;
  relation: Relation;
  sourceLabel: string;
  targetLabel: string;
  readOnly: boolean;
}) {
  const dispatch = useUntieStore((s) => s.dispatch);
  const pushToast = useUntieStore((s) => s.pushToast);
  const edge = board.edges?.find((e) => e.relationId === relation.id);
  const sourceSide = edge?.sourceSide ?? DEFAULT_EDGE_SIDES.sourceSide;
  const targetSide = edge?.targetSide ?? DEFAULT_EDGE_SIDES.targetSide;
  const update = (patch: { sourceSide?: EdgeSide; targetSide?: EdgeSide }) => {
    const r = dispatch((m) => setEdgeSides(m, { boardId: board.id, relationId: relation.id, sourceSide, targetSide, ...patch }));
    if (!r.ok) pushToast(r.reason, "error");
  };
  const sideSelect = (label: string, value: EdgeSide, key: "sourceSide" | "targetSide") => (
    <label className="field">
      <span className="field-label">{label}</span>
      <select value={value} onChange={(e) => update({ [key]: e.target.value as EdgeSide })}>
        {EDGE_SIDES.map((side) => (
          <option key={side} value={side}>
            {EDGE_SIDE_LABELS[side]}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <fieldset className="edge-sides" disabled={readOnly}>
      <legend className="field-label">線の付け根 (このボードだけ)</legend>
      <div className="edge-sides-row">
        {sideSelect(`${sourceLabel}の辺`, sourceSide, "sourceSide")}
        {sideSelect(`${targetLabel}の辺`, targetSide, "targetSide")}
        <button
          type="button"
          title="始点と終点の辺を入れ替える"
          disabled={sourceSide === targetSide}
          onClick={() => update({ sourceSide: targetSide, targetSide: sourceSide })}
        >
          入れ替え
        </button>
      </div>
    </fieldset>
  );
}

// ---------------------------------------------------------------- 要素

function ElementEditor({ element, model }: { element: Element; model: UntieModel }) {
  const dispatch = useUntieStore((s) => s.dispatch);
  const boardId = useUntieStore((s) => s.ui.currentBoardId);
  const nameFocusNonce = useUntieStore((s) => s.ui.nameFocusNonce);
  const issueDraft = useUntieStore((s) => s.ui.issueDraft);
  const pushToast = useUntieStore((s) => s.pushToast);
  const setRightPanel = useUntieStore((s) => s.setRightPanel);
  const readOnly = useUntieStore(selectReadOnly);
  const peers = usePeersSelecting(element.id);
  const nameRef = useRef<HTMLInputElement>(null);
  // 所属・関係・要素の作成と削除は固定ボードだけで変えられる。自由ボードでは名前と説明だけ
  // 課題はどのボードにも出ないので、どこからでも重要度・対象の編集と削除ができる (課題一覧から作って紐解く)
  // 閲覧専用のファイルでは、どれも変えられない
  const structural = !readOnly && (isFixedBoard(boardId) || element.kind === "issue");

  // 「追加」直後に名前欄へフォーカスする。新しい要素の編集欄はマウントと同時にここへ来るので、
  // 処理済みの番号をモジュールに持ち、増えているときだけ発火する
  useEffect(() => {
    if (nameFocusNonce !== handledFocus.nonce) {
      handledFocus.nonce = nameFocusNonce;
      nameRef.current?.focus();
      nameRef.current?.select();
    }
  }, [nameFocusNonce]);

  const update = (patch: Parameters<typeof updateElement>[1]["patch"]) => {
    const r = dispatch((m) => updateElement(m, { id: element.id, patch }));
    if (!r.ok) pushToast(r.reason, "error");
  };

  const onBoard = !!model.boards.find((b) => b.id === boardId)?.nodes.some((n) => n.elementId === element.id);
  const relations = model.relations.filter((r) => r.sourceId === element.id || r.targetId === element.id);
  const issues = isIssueTargetKind(element.kind) ? issuesTargeting(model, element.id) : [];

  const addIssue = () => createIssue([element.id]);


  return (
    <div className={`editor kind-${element.kind}`} data-testid="element-editor">
      <div className="kind-line">
        <span className="kind-dot" />
        {ELEMENT_KIND_LABELS[element.kind]}
        {peers.length > 0 && (
          // 同時編集: 他の人が同じ要素を選んでいる (ロックはしない)
          <span className="peer-note" data-testid="peer-note">
            {/* 同じ人が複数のタブで選んでいても 1 回 */}
            {peers.filter((p, i) => peers.findIndex((q) => (q.userId ?? `c${q.clientId}`) === (p.userId ?? `c${p.clientId}`)) === i).map((p) => (
              <span key={p.clientId} className="peer-note-item">
                <span className="peer-dot" style={{ background: p.color }} aria-hidden="true" />
                {p.name}さんも選択中
              </span>
            ))}
          </span>
        )}
      </div>
      <CommitField label="名前" value={element.name} inputRef={nameRef} readOnly={readOnly} onCommit={(name) => update({ name })} />
      {isGuideKind(element.kind) && !(element.kind === "buc" && element.isDefault) && (
        <p className="hint name-hint">{GRANULARITY[element.kind].nameHint}</p>
      )}
      <CommitField
        label="説明"
        multiline
        value={element.description ?? ""}
        readOnly={readOnly}
        onCommit={(description) => update({ description })}
      />
      {(element.kind === "activity" || element.kind === "usecase") && (
        <>
          <HoursField value={element.hours} readOnly={readOnly} onCommit={(hours) => update({ hours })} onError={(r) => pushToast(r, "error")} />
          {element.kind === "activity" && <ActivityHoursBreakdown activityId={element.id} model={model} />}
          <LinksEditor links={element.links ?? []} readOnly={readOnly} onChange={(links) => update({ links })} />
        </>
      )}

      {readOnly ? (
        <p className="hint">閲覧専用のため、内容は変えられません。</p>
      ) : (
        !structural && (
          <p className="hint">
            {isAnalysisBoard(boardId) ? "分析ボード" : "自由ボード"}
            では名前・説明・時間・リンクだけを変えられます。所属・関係・削除は固定ボードで行います。
          </p>
        )
      )}
      <fieldset className="plain-fieldset" disabled={!structural}>
        {element.kind === "activity" && <ActivityFields activity={element} model={model} />}
        {element.kind === "buc" && !element.isDefault && <BucFields buc={element} model={model} />}
        {isContextMemberKind(element.kind) && <ContextField element={element} model={model} />}
        {element.kind === "state" && (
          <CommitField label="状態グループ" value={element.group ?? ""} onCommit={(group) => update({ group })} />
        )}
        {element.kind === "variation" && (
          <VariationValues variation={element} onChange={(values) => update({ values })} />
        )}
        {element.kind === "issue" && <IssueFields issue={element} model={model} />}
      </fieldset>

      <section className="subsection">
        <h3>関係</h3>
        {structural && <RelationAdder element={element} model={model} />}
        {relations.length === 0 ? (
          <p className="hint">この要素につながる線はありません。</p>
        ) : (
          <ul className="relation-list">
            {relations.map((r) => {
              const outgoing = r.sourceId === element.id;
              const otherId = outgoing ? r.targetId : r.sourceId;
              const other = model.elements.find((e) => e.id === otherId);
              return (
                <li key={r.id}>
                  <span className="relation-kind">{relationLabel(r.kind)}</span>
                  <span className="relation-dir" aria-hidden="true">
                    {relationRule(r.kind).undirected ? "↔" : outgoing ? "→" : "←"}
                  </span>
                  {other && (
                    <span className={`relation-layer kind-${other.kind}`}>
                      <span className="kind-dot" />
                      {ELEMENT_KIND_LABELS[other.kind]}
                    </span>
                  )}
                  <button type="button" className="link" onClick={() => other && selectAndReveal(other.id)}>
                    {other?.name || "(名前なし)"}
                  </button>
                  {structural && (
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`関係「${relationLabel(r.kind)} ${other?.name ?? ""}」を削除`}
                      onClick={() => dispatch((m) => removeRelation(m, { id: r.id }))}
                    >
                      ×
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <TraceSection element={element} model={model} />

      {isIssueTargetKind(element.kind) && (
        <section className="subsection">
          <h3>課題 ({ISSUE_SCOPE_LABELS[issueScopeOfKind(element.kind)]})</h3>
          {issues.length === 0 ? (
            <p className="hint">この要素を対象にした課題はありません。</p>
          ) : (
            <ul className="issue-link-list">
              {issues.map((i) => (
                <li key={i.id}>
                  <span className={`sev-chip sev-${i.severity}`}>{i.severity}</span>
                  <button type="button" className="link" onClick={() => selectAndReveal(i.id)}>
                    {i.name || "(名前なし)"}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {structural && (
            <button type="button" onClick={addIssue}>
              課題を追加
            </button>
          )}
        </section>
      )}

      <div className="actions">
        {!structural && !readOnly && onBoard && (
          <button
            type="button"
            onClick={() => dispatch((m) => removeFromBoard(m, { boardId, elementId: element.id }))}
          >
            ボードから外す
          </button>
        )}
        {structural && (
          <button
            type="button"
            className="danger"
            onClick={() => {
              const r = dispatch((m) => removeElement(m, { id: element.id }));
              if (!r.ok) {
                pushToast(r.reason, "error");
                return;
              }
              // 課題は課題一覧から作って紐解くので、消したら課題一覧へ戻る
              if (element.kind === "issue") setRightPanel("issues");
            }}
          >
            削除
          </button>
        )}
        {element.kind === "issue" &&
          (issueDraft?.id === element.id ? (
            // 追加フォーム: 書き出しを続けられるよう、同じ対象で次の課題を作る
            <button type="button" className="primary actions-end" onClick={() => createIssue(issueDraft.targetIds)}>
              次の課題を登録する
            </button>
          ) : (
            <button type="button" className="link actions-end" onClick={() => setRightPanel("issues")}>
              課題一覧に戻る
            </button>
          ))}
      </div>
    </div>
  );
}

const handledFocus = { nonce: 0 };

/** 1 つの行に最初から出す要素の数 (残りは「ほか N 件」で開く) */
const TRACE_VISIBLE = 6;

/**
 * トレース: 上 (担い手の側) と下 (詳細の側) へ、直接つながっていない要素まで辿ってレイヤーごとに並べる。
 * 行ごとに、そのレイヤーの固定ボードへ移るリンクを出す
 */
function TraceSection({ element, model }: { element: Element; model: UntieModel }) {
  const own = fixedLayerOf(element.kind);
  const boardId = useUntieStore((s) => s.ui.currentBoardId);
  const { up, down } = useMemo(() => lineage(model, element.id, { includeEmpty: true }), [model, element.id]);
  if (!own) return null;
  const rows = [
    ...up.map((r) => ({ ...r, dir: "up" as const })),
    { layer: own, elements: [element], dir: "own" as const },
    ...down.map((r) => ({ ...r, dir: "down" as const })),
  ];
  return (
    <section className="subsection">
      <h3>トレース</h3>
      {[...up, ...down].every((r) => r.elements.length === 0) && (
        <p className="hint">上下のレイヤーにつながる要素はありません。「移動」でそのレイヤーの固定ボードへ移って結べます。</p>
      )}
      <table className="trace-table">
        <thead>
          <tr>
            <th scope="col">レイヤー</th>
            <th scope="col">要素</th>
            <th scope="col">
              <span className="visually-hidden">移動</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <TraceRow
              key={`${r.dir}-${r.layer}`}
              dir={r.dir}
              layer={r.layer}
              elements={r.elements}
              currentId={element.id}
              current={boardId === fixedBoardId(r.layer)}
            />
          ))}
        </tbody>
      </table>
    </section>
  );
}

function TraceRow({
  dir,
  layer,
  elements,
  currentId,
  current,
}: {
  dir: "up" | "own" | "down";
  layer: FixedLayer;
  elements: Element[];
  currentId: string;
  current: boolean;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? elements : elements.slice(0, TRACE_VISIBLE);
  return (
    <tr className={`trace-tr is-${dir}`}>
      <th scope="row">
        <span className="trace-dir" aria-hidden="true">
          {dir === "up" ? "↑" : dir === "down" ? "↓" : "●"}
        </span>
        {FIXED_LAYER_LABELS[layer]}
      </th>
      <td>
        <span className="trace-els">
          {elements.length === 0 && <span className="trace-unset">(未設定)</span>}
          {shown.map((e) =>
            e.id === currentId ? (
              <span key={e.id} className={`trace-el is-self kind-${e.kind}`}>
                <span className="kind-dot" />
                {e.name || "(名前なし)"}
              </span>
            ) : (
              <button key={e.id} type="button" className={`trace-el kind-${e.kind}`} title={`${ELEMENT_KIND_LABELS[e.kind]}: ${e.name}`} onClick={() => selectAndReveal(e.id)}>
                <span className="kind-dot" />
                {e.name || "(名前なし)"}
              </button>
            ),
          )}
          {elements.length > TRACE_VISIBLE && (
            <button type="button" className="link-plain trace-more" onClick={() => setAll(!all)}>
              {all ? "たたむ" : `ほか ${elements.length - TRACE_VISIBLE} 件`}
            </button>
          )}
        </span>
      </td>
      <td>
        <button
          type="button"
          className="layer-link"
          disabled={current}
          aria-label={`固定ボード「${FIXED_LAYER_LABELS[layer]}」へ移る`}
          title={current ? "今開いているボードです" : `固定ボード「${FIXED_LAYER_LABELS[layer]}」へ移る (この要素を選んだまま)`}
          onClick={() => goToLayer(layer, currentId)}
        >
          移動
        </button>
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------- 種類固有

/** この要素と結べる要素を選んで関係を足す (両端の種類から関係が決まる)。固定ボードだけで出す */
function RelationAdder({ element, model }: { element: Element; model: UntieModel }) {
  const dispatch = useUntieStore((s) => s.dispatch);
  const pushToast = useUntieStore((s) => s.pushToast);
  const options: { value: string; group: string; label: string }[] = [];
  for (const other of model.elements) {
    if (other.id === element.id || (other.kind === "buc" && other.isDefault)) continue;
    // 自分が始点 → 相手が始点の順に調べ、同じ相手は 1 回だけ出す (無向の関連)
    for (const [sourceId, targetId, kind] of [
      [element.id, other.id, relationKindFor(element.kind, other.kind)],
      [other.id, element.id, relationKindFor(other.kind, element.kind)],
    ] as const) {
      if (!kind) continue;
      if (model.relations.some((r) => sameRelation(r, { kind, sourceId, targetId }))) break;
      const dir = relationRule(kind).undirected ? "↔" : sourceId === element.id ? "→" : "←";
      options.push({
        value: `${sourceId}>${targetId}`,
        group: `${relationLabel(kind)} ${dir} ${ELEMENT_KIND_LABELS[other.kind]}`,
        label: other.name || "(名前なし)",
      });
      break;
    }
  }
  if (options.length === 0) return null;
  const groups = [...new Set(options.map((o) => o.group))];
  return (
    <select
      aria-label="関係を追加"
      value=""
      onChange={(ev) => {
        const [sourceId, targetId] = ev.target.value.split(">");
        if (!sourceId || !targetId) return;
        const r = dispatch((m) => addRelation(m, { sourceId, targetId }));
        if (!r.ok) pushToast(r.reason, "error");
      }}
    >
      <option value="">関係を追加…</option>
      {groups.map((g) => (
        <optgroup key={g} label={g}>
          {options
            .filter((o) => o.group === g)
            .map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
        </optgroup>
      ))}
    </select>
  );
}

function ActivityFields({ activity, model }: { activity: Activity; model: UntieModel }) {
  const dispatch = useUntieStore((s) => s.dispatch);
  const pushToast = useUntieStore((s) => s.pushToast);
  const buc = activity.bucId ? (model.elements.find((e) => e.id === activity.bucId) as Buc | undefined) : undefined;
  const businessId = buc?.businessId ?? "";
  const businesses = model.elements.filter((e) => e.kind === "business");
  // 業務直下と活動は混ぜない: 活動のある業務では「(業務に直接)」を選ばせない (今そこにあるときだけ出す)
  const realBucsOf = (bizId: string) => model.elements.filter((e): e is Buc => e.kind === "buc" && e.businessId === bizId && !e.isDefault);
  const hasBucs = realBucsOf(businessId).length > 0;
  const bucs = model.elements.filter(
    (e): e is Buc => e.kind === "buc" && e.businessId === businessId && (!e.isDefault || !hasBucs || e.id === activity.bucId),
  );

  const move = (bucId: string | null) => {
    const r = dispatch((m) => moveActivity(m, { activityId: activity.id, bucId }));
    if (!r.ok) pushToast(r.reason, "error");
  };

  return (
    <>
      <label className="field">
        <span className="field-label">業務</span>
        <select
          aria-label="業務"
          value={businessId}
          onChange={(e) => {
            const bizId = e.target.value;
            if (!bizId) return move(null);
            // 活動のある業務へ移すときは最初の活動へ、無ければ業務に直接
            move(realBucsOf(bizId)[0]?.id ?? defaultBucOf(model, bizId)?.id ?? null);
          }}
        >
          <option value="">未所属</option>
          {businesses.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span className="field-label">活動</span>
        <select
          aria-label="活動"
          value={activity.bucId ?? ""}
          disabled={!businessId}
          onChange={(e) => move(e.target.value || null)}
        >
          {!businessId && <option value="">(業務を選ぶ)</option>}
          {bucs.map((b) => (
            <option key={b.id} value={b.id}>
              {b.isDefault ? (hasBucs ? "(業務に直接: 活動に移してください)" : "(業務に直接)") : b.name}
            </option>
          ))}
        </select>
      </label>
    </>
  );
}

function BucFields({ buc, model }: { buc: Buc; model: UntieModel }) {
  const dispatch = useUntieStore((s) => s.dispatch);
  const pushToast = useUntieStore((s) => s.pushToast);
  const businesses = model.elements.filter((e) => e.kind === "business");
  return (
    <label className="field">
      <span className="field-label">業務</span>
      <select
        aria-label="業務"
        value={buc.businessId}
        onChange={(e) => {
          const r = dispatch((m) => moveBuc(m, { bucId: buc.id, businessId: e.target.value }));
          if (!r.ok) pushToast(r.reason, "error");
        }}
      >
        {businesses.map((b) => (
          <option key={b.id} value={b.id}>
            {b.name}
          </option>
        ))}
      </select>
    </label>
  );
}

/** 情報・状態・条件・バリエーションの所属コンテキスト。関係から見た候補も出す */
function ContextField({ element, model }: { element: Element; model: UntieModel }) {
  const dispatch = useUntieStore((s) => s.dispatch);
  const pushToast = useUntieStore((s) => s.pushToast);
  const contexts = model.elements.filter((e) => e.kind === "context");
  const current = "contextId" in element ? element.contextId : null;
  const suggested = suggestContext(model, element.id);
  const suggestedName = suggested ? model.elements.find((e) => e.id === suggested)?.name || "(名前なし)" : "";
  const move = (contextId: string | null) => {
    const r = dispatch((m) => moveToContext(m, { elementId: element.id, contextId }));
    if (!r.ok) pushToast(r.reason, "error");
  };
  const byGroup = element.kind === "state" && element.group;
  return (
    <div className="field">
      <label className="field">
        <span className="field-label">コンテキスト{byGroup ? " (状態グループごと)" : ""}</span>
        <select aria-label="コンテキスト" value={current ?? ""} onChange={(e) => move(e.target.value || null)}>
          <option value="">未分類</option>
          {contexts.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name || "(名前なし)"}
            </option>
          ))}
        </select>
      </label>
      {suggested && suggested !== current && (
        <p className="hint context-suggest">
          つながりから見ると「{suggestedName}」が候補です。
          <button type="button" className="link-plain context-apply" onClick={() => move(suggested)}>
            「{suggestedName}」にする
          </button>
        </p>
      )}
    </div>
  );
}

/** 作業の時間の内訳。使う操作の時間の合計を、作業自身の時間とは分けて出す */
function ActivityHoursBreakdown({ activityId, model }: { activityId: string; model: UntieModel }) {
  const h = activityHours(model, activityId);
  if (h.usecases === undefined) return null;
  const ucIds = new Set(model.relations.filter((r) => r.kind === "activityUsecase" && r.sourceId === activityId).map((r) => r.targetId));
  const parts = model.elements.filter((e) => e.kind === "usecase" && ucIds.has(e.id) && e.hours !== undefined);
  return (
    <p className="hint hours-breakdown">
      操作の合計: {formatHours(h.usecases)} (
      {parts.map((u) => `${u.name} ${u.kind === "usecase" ? formatHours(u.hours!) : ""}`).join("、")})
    </p>
  );
}

/** マニュアルなどへのリンク (作業・操作)。名前をクリックすると既定のブラウザで開く */
function LinksEditor({ links, onChange, readOnly }: { links: Link[]; onChange: (links: Link[]) => void; readOnly?: boolean }) {
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const pushToast = useUntieStore((s) => s.pushToast);
  const add = () => {
    const u = url.trim();
    if (!u) return;
    if (!/^https?:\/\//.test(u)) {
      pushToast("URL は http:// か https:// で始めてください", "error");
      return;
    }
    onChange([...links, { title: title.trim() || u, url: u }]);
    setTitle("");
    setUrl("");
  };
  const move = (i: number, j: number) => {
    const next = [...links];
    [next[i], next[j]] = [next[j]!, next[i]!];
    onChange(next);
  };
  return (
    <section className="subsection">
      <h3>リンク</h3>
      {links.length === 0 ? (
        <p className="hint">マニュアルなどへのリンクはまだありません。</p>
      ) : (
        <ul className="link-list">
          {links.map((l, i) => (
            <li key={i}>
              <button type="button" className="link" title={l.url} onClick={() => void getPlatform().openExternalUrl(l.url)}>
                {l.title}
              </button>
              {!readOnly && (
                <>
                  <button type="button" className="icon-button" aria-label={`リンク「${l.title}」を上へ`} disabled={i === 0} onClick={() => move(i, i - 1)}>
                    ↑
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`リンク「${l.title}」を下へ`}
                    disabled={i === links.length - 1}
                    onClick={() => move(i, i + 1)}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`リンク「${l.title}」を削除`}
                    onClick={() => onChange(links.filter((_, k) => k !== i))}
                  >
                    ×
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {!readOnly && <div className="link-add">
        <input aria-label="リンクの表示名" placeholder="表示名 (例: 鍵の受け渡しマニュアル)" value={title} onChange={(e) => setTitle(e.target.value)} />
        <div className="inline-add">
          <input
            aria-label="リンクの URL"
            placeholder="https://..."
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") add();
            }}
          />
          <button type="button" onClick={add}>
            追加
          </button>
        </div>
      </div>}
    </section>
  );
}

function VariationValues({ variation, onChange }: { variation: Variation; onChange: (values: string[]) => void }) {
  const [adding, setAdding] = useState("");
  const values = variation.values;
  const swap = (i: number, j: number) => {
    const next = [...values];
    [next[i], next[j]] = [next[j]!, next[i]!];
    onChange(next);
  };
  const add = () => {
    const v = adding.trim();
    if (!v) return;
    onChange([...values, v]);
    setAdding("");
  };
  return (
    <section className="subsection">
      <h3>値の一覧</h3>
      <ul className="value-list">
        {values.map((v, i) => (
          <li key={i}>
            <CommitField
              label={`値 ${i + 1}`}
              value={v}
              onCommit={(nv) => {
                const t = nv.trim();
                if (t === v) return;
                onChange(values.map((x, k) => (k === i ? t : x)));
              }}
            />
            <button type="button" className="icon-button" aria-label={`値「${v}」を上へ`} disabled={i === 0} onClick={() => swap(i, i - 1)}>
              ↑
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label={`値「${v}」を下へ`}
              disabled={i === values.length - 1}
              onClick={() => swap(i, i + 1)}
            >
              ↓
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label={`値「${v}」を削除`}
              onClick={() => onChange(values.filter((_, k) => k !== i))}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      <div className="inline-add">
        <input
          aria-label="追加する値"
          value={adding}
          placeholder="新しい値"
          onChange={(e) => setAdding(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") add();
          }}
        />
        <button type="button" onClick={add}>
          追加
        </button>
      </div>
    </section>
  );
}

function IssueFields({ issue, model }: { issue: Issue; model: UntieModel }) {
  const dispatch = useUntieStore((s) => s.dispatch);
  const pushToast = useUntieStore((s) => s.pushToast);
  const scope = issueScope(model, issue);
  // 全体的な課題と具体的な課題は混ぜない。対象があれば同じ区分の候補だけを出す
  const groups: { label: string; kinds: readonly IssueTargetKind[] }[] = [
    ...(scope !== "specific" ? [{ label: "登場人物 (全体的な課題)", kinds: OVERALL_ISSUE_TARGET_KINDS }] : []),
    ...(scope !== "overall" ? SPECIFIC_ISSUE_TARGET_KINDS.map((k) => ({ label: `${ELEMENT_KIND_LABELS[k]} (具体的な課題)`, kinds: [k] })) : []),
  ];
  const candidates = listableElements(model).filter((e) => isIssueTargetKind(e.kind) && !issue.targetIds.includes(e.id));
  const setTargets = (targetIds: string[]) => {
    const r = dispatch((m) => setIssueTargets(m, { issueId: issue.id, targetIds }));
    if (!r.ok) pushToast(r.reason, "error");
  };
  return (
    <>
      <label className="field">
        <span className="field-label">重要度</span>
        <select
          aria-label="重要度"
          value={issue.severity}
          onChange={(e) => {
            const severity = Number(e.target.value);
            const r = dispatch((m) => updateElement(m, { id: issue.id, patch: { severity } }));
            if (!r.ok) pushToast(r.reason, "error");
          }}
        >
          {[1, 2, 3, 4, 5].map((n) => (
            <option key={n} value={n}>
              {n}
              {n === 1 ? " (低)" : n === 5 ? " (高)" : ""}
            </option>
          ))}
        </select>
      </label>
      <div className="field">
        <span className="field-label">区分</span>
        <span data-testid="issue-scope">
          {ISSUE_SCOPE_LABELS[scope]}
          <span className="hint-inline"> ({ISSUE_SCOPE_TARGETS[scope]})</span>
        </span>
      </div>
      <section className="subsection">
        <h3>対象</h3>
        {issue.targetIds.length === 0 ? (
          <p className="hint">対象はまだありません。登場人物を選ぶと全体的な課題、業務・作業・操作を選ぶと具体的な課題になります。</p>
        ) : (
          <ul className="target-list">
            {issue.targetIds.map((id) => {
              const t = model.elements.find((e) => e.id === id);
              return (
                <li key={id}>
                  <span className="relation-kind">{t ? ELEMENT_KIND_LABELS[t.kind] : ""}</span>
                  <button type="button" className="link" onClick={() => t && selectAndReveal(t.id)}>
                    {t?.name || "(名前なし)"}
                  </button>
                  {t && (
                    <button
                      type="button"
                      className="link"
                      title={`${ELEMENT_KIND_LABELS[t.kind]}の固定ボードへ移る`}
                      aria-label={`「${t.name}」の固定ボードへ移る`}
                      onClick={() => revealOnFixedBoard(t.id)}
                    >
                      移動
                    </button>
                  )}
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`対象「${t?.name ?? ""}」を外す`}
                    onClick={() => setTargets(issue.targetIds.filter((x) => x !== id))}
                  >
                    ×
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <label className="field">
          <span className="field-label">対象を追加</span>
          <select
            aria-label="対象を追加"
            value=""
            onChange={(e) => {
              if (e.target.value) setTargets([...issue.targetIds, e.target.value]);
            }}
          >
            <option value="">選んで追加…</option>
            {groups.map((g) => (
              <optgroup key={g.label} label={g.label}>
                {candidates
                  .filter((c) => (g.kinds as readonly string[]).includes(c.kind))
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {g.kinds.length > 1 ? `${ELEMENT_KIND_LABELS[c.kind]}: ` : ""}
                      {c.name}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
        </label>
        {issue.targetIds.length > 0 && (
          <p className="hint">
            {scope === "overall" ? "具体的な課題 (業務・作業・操作)" : "全体的な課題 (登場人物)"}
            に付け替えるときは、いまの対象をすべて外してから追加してください。
          </p>
        )}
      </section>
      <IssueAnalysisFields issue={issue} />
    </>
  );
}

/**
 * 課題の分析 (現象・所在・理由・影響)。AI との深掘りで埋まるが、手でも書ける。
 * 担当者が書いた説明 (原文) とは分けて持つ
 */
function IssueAnalysisFields({ issue }: { issue: Issue }) {
  const dispatch = useUntieStore((s) => s.dispatch);
  const pushToast = useUntieStore((s) => s.pushToast);
  const agentMode = useAgentStore((s) => s.mode);
  const agentRunning = useAgentStore((s) => s.running);
  const startGrill = useAgentStore((s) => s.startGrill);
  const readOnly = useUntieStore(selectReadOnly);
  const grilling = agentMode.kind === "grill" && agentMode.issueId === issue.id;
  return (
    <section className="subsection" aria-label="分析">
      <div className="subsection-head">
        <h3>分析</h3>
        {!readOnly && (
          <button type="button" className="link" onClick={() => void startGrill(issue.id)} disabled={grilling || agentRunning}>
            {grilling ? "深掘り中…" : "AI と深掘りする"}
          </button>
        )}
      </div>
      <p className="hint">困りごとがどこで、なぜ起きているかを突き止めた内容。AI の質問に答えて埋めるか、手で入力します。</p>
      {ISSUE_ANALYSIS_KEYS.map((key) => (
        <CommitField
          key={key}
          label={ISSUE_ANALYSIS_LABELS[key]}
          multiline
          placeholder={ISSUE_ANALYSIS_QUESTIONS[key]}
          readOnly={readOnly}
          value={issue.analysis?.[key] ?? ""}
          onCommit={(v) => {
            const r = dispatch((m) => updateElement(m, { id: issue.id, patch: { analysis: { [key]: v } } }));
            if (!r.ok) pushToast(r.reason, "error");
          }}
        />
      ))}
    </section>
  );
}
