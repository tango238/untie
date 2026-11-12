import { isDevMode } from "../devMode";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  addRelation,
  moveActivity,
  moveBuc,
  moveToContext,
  moveToSystem,
  removeElement,
  removeFromBoard,
  removeRelation,
  setEdgeSides,
  setIssueTargets,
  setPersona,
  setEventTiming,
  setRelationAccess,
  setScreenUsecase,
  setUsecaseTarget,
  isUsecaseTargetKind,
  updateElement,
} from "@untie/core/model/commands";
import { relationKindFor, relationLabel, relationRule, sameRelation } from "@untie/core/model/relations";
import { suggestContext } from "@untie/core/model/contexts";
import { lineage } from "@untie/core/model/lineage";
import { informationPlaces, PLACE_ROLE_LABELS, placeInformations, screenInformations, type Derived } from "@untie/core/model/placement";
import { ANALYSIS_MAX_LENGTH, DESCRIPTION_MAX_LENGTH, LIMITS, GROUP_MAX_LENGTH, LINK_TITLE_MAX_LENGTH, LINK_URL_MAX_LENGTH, NAME_MAX_LENGTH, truncateText, VALUE_MAX_LENGTH, VERIFICATION_MAX_LENGTH, TRIGGER_NOTE_MAX_LENGTH } from "@untie/core/model/limits";
import { FIXED_LAYER_LABELS, fixedBoardId, fixedLayerOf, type FixedLayer } from "@untie/core/model/fixedBoards";
import { domainReferences } from "@untie/core/model/domain";
import { activitiesTriggeredBy, activityHours, activityTriggers, defaultBucOf, designReferences, formatHours, issueScope, issuesTargeting, listableElements } from "@untie/core/model/selectors";
import {
  DEFAULT_EDGE_SIDES,
  EDGE_SIDES,
  EDGE_SIDE_LABELS,
  ELEMENT_KIND_LABELS,
  INFORMATION_ACCESS_BOTH_LABEL,
  INFORMATION_ACCESS_LABELS,
  INFORMATION_ACCESSES,
  type InformationAccess,
  isContextMemberKind,
  isIssueTargetKind,
  isSystemMemberKind,
  NFR_CATEGORIES,
  NFR_CATEGORY_LABELS,
  type NfrCategory,
  issueScopeOfKind,
  ISSUE_ANALYSIS_KEYS,
  ISSUE_ANALYSIS_LABELS,
  ISSUE_ANALYSIS_QUESTIONS,
  ISSUE_SCOPE_LABELS,
  ISSUE_SCOPE_TARGETS,
  OVERALL_ISSUE_TARGET_KINDS,
  PERSONA_FIELD_LABELS,
  PERSONA_IT_SKILL_LABELS,
  type Persona,
  describeEventTiming,
  EVENT_TIMING_EVERIES,
  EVENT_TIMING_EVERY_LABELS,
  EVENT_TIMING_TYPES,
  EVENT_TIMING_TYPE_LABELS,
  type EventTiming,
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
import { isAnalysisBoard, isFixedBoard, isSimpleBoard, selectReadOnly, useUntieStore } from "../store";
import { impactLines, isWorkflowElement, isWorkflowLayer, relationRemovalImpact, removalImpact, workflowKindLabel } from "@untie/core/model/workflow";
import { createIssue, goToLayer, revealOnFixedBoard, selectAndReveal } from "./actions";
import { useAgentStore } from "../ai/agentStore";
import { HEARING_ANSWERER_LABELS, type HearingAnswerer } from "../ai/hearing";
import { getApiKey } from "../ai/keys";
import { PROVIDERS } from "../ai/providers";
import { getPlatform } from "../platform";
import { CommitField } from "./CommitField";
import { ConfirmDialog } from "./ConfirmDialog";
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
  // 設計データが一緒に消える要素を消すときの確認 (消える設計データの要約)
  // 簡易モード (ワークフロー) では、子も一緒に確かめる: impact は子の巻き込まれ方、refs は消える設計データ
  const [confirmRemove, setConfirmRemove] = useState<{ impact: string[]; refs: string[] } | null>(null);
  // 主担当の登場人物を外すとき、その業務に子があれば確かめる (簡易モード)。外す関係の id
  const [confirmUnlink, setConfirmUnlink] = useState<string | null>(null);
  // 所属・関係・要素の作成と削除は固定ボードだけで変えられる。自由ボードでは名前と説明だけ
  // 課題はどのボードにも出ないので、どこからでも重要度・対象の編集と削除ができる (課題一覧から作って紐解く)
  // 閲覧専用のファイルでは、どれも変えられない
  // 分析（簡易）のワークフローボードも、固定ボードと同じに所属・関係・削除を扱える
  // ただし直せるのはワークフローの種類 (登場人物・業務・活動・作業) だけ。システム・操作などは、巻き込まれるものを確かめる手立てが無いので、詳細で直す
  const simple = isSimpleBoard(boardId);
  const structural = !readOnly && (isFixedBoard(boardId) || (simple && isWorkflowElement(element)) || element.kind === "issue");
  // 簡易モードでは、アクター・外部アクターをボードと同じ「登場人物」「外部の登場人物」と呼ぶ
  const kindLabel = (k: Element["kind"]) => (simple ? workflowKindLabel(k) : ELEMENT_KIND_LABELS[k]);

  // 「追加」直後に名前欄へフォーカスする。新しい要素の編集欄はマウントと同時にここへ来るので、
  // 処理済みの番号をモジュールに持ち、増えているときだけ発火する
  useEffect(() => {
    if (nameFocusNonce !== handledFocus.nonce) {
      handledFocus.nonce = nameFocusNonce;
      nameRef.current?.focus();
      nameRef.current?.select();
    }
  }, [nameFocusNonce]);

  const removeSelected = () => {
    const r = dispatch((m) => removeElement(m, { id: element.id }));
    if (!r.ok) {
      pushToast(r.reason, "error");
      return;
    }
    // 課題は課題一覧から作って紐解くので、消したら課題一覧へ戻る
    if (element.kind === "issue") setRightPanel("issues");
  };

  const update = (patch: Parameters<typeof updateElement>[1]["patch"]) => {
    const r = dispatch((m) => updateElement(m, { id: element.id, patch }));
    if (!r.ok) pushToast(r.reason, "error");
  };

  const onBoard = !!model.boards.find((b) => b.id === boardId)?.nodes.some((n) => n.elementId === element.id);
  // 作業の起点は「起点」の節で扱う。操作の対象 (システム・帳票・画面) は上の「対象」の欄で選ぶので、操作では一覧に重ねて出さない
  const relations = model.relations.filter(
    (r) => (r.sourceId === element.id || r.targetId === element.id) && !isTriggerKind(r.kind) && !(element.kind === "usecase" && isUsecaseTargetKind(r.kind)),
  );
  const issues = isIssueTargetKind(element.kind) ? issuesTargeting(model, element.id) : [];

  const addIssue = () => createIssue([element.id]);


  return (
    <div className={`editor kind-${element.kind}`} data-testid="element-editor">
      <div className="kind-line">
        <span className="kind-dot" />
        {kindLabel(element.kind)}
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
      <CommitField label="名前" maxLength={NAME_MAX_LENGTH} value={element.name} inputRef={nameRef} readOnly={readOnly} onCommit={(name) => update({ name })} />
      {isGuideKind(element.kind) && !(element.kind === "buc" && element.isDefault) && (
        <p className="hint name-hint">{GRANULARITY[element.kind].nameHint}</p>
      )}
      <CommitField
        label="説明"
        multiline
        maxLength={DESCRIPTION_MAX_LENGTH}
        value={element.description ?? ""}
        readOnly={readOnly}
        onCommit={(description) => update({ description })}
      />
      {(element.kind === "actor" || element.kind === "externalActor") && <PersonaSection actor={element} />}
      {element.kind === "event" && <EventTimingSection event={element} />}
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
        !structural &&
        !(simple && element.kind === "buc" && element.isDefault) && (
          <p className="hint">
            {simple
              ? "この種類は、ワークフローでは名前・説明・時間・リンクだけを変えられます。所属・関係・削除は分析（詳細）で直せます。"
              : `${isAnalysisBoard(boardId) ? "分析ボード" : "自由ボード"}では名前・説明・時間・リンクだけを変えられます。所属・関係・削除は固定ボードで行います。`}
          </p>
        )
      )}
      {element.kind === "activity" && <TriggerSection activity={element} model={model} structural={structural} update={update} />}
      <fieldset className="plain-fieldset" disabled={!structural}>
        {element.kind === "activity" && <ActivityFields activity={element} model={model} />}
        {element.kind === "buc" && !element.isDefault && <BucFields buc={element} model={model} />}
        {isContextMemberKind(element.kind) && <ContextField element={element} model={model} />}
        {isSystemMemberKind(element.kind) && <SystemField element={element} model={model} />}
        {element.kind === "screen" && <ScreenUsecaseField screenId={element.id} model={model} />}
        {element.kind === "usecase" && <UsecaseTargetField usecaseId={element.id} model={model} />}
        {element.kind === "nfr" && (
          <>
            <label className="field">
              <span className="field-label">分類</span>
              <select
                aria-label="分類"
                value={element.category ?? ""}
                onChange={(e) => update({ category: (e.target.value || null) as NfrCategory | null })}
              >
                <option value="">未分類</option>
                {NFR_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {NFR_CATEGORY_LABELS[c]}
                  </option>
                ))}
              </select>
            </label>
            <CommitField
              label="検証方法"
              multiline
              maxLength={VERIFICATION_MAX_LENGTH}
              value={element.verification ?? ""}
              onCommit={(verification) => update({ verification })}
            />
            <p className="hint">求める人 (アクター・外部アクター) は、下の「関係を追加」の「求める」で結びます。</p>
          </>
        )}
        {element.kind === "state" && (
          <CommitField label="状態グループ" maxLength={GROUP_MAX_LENGTH} value={element.group ?? ""} onCommit={(group) => update({ group })} />
        )}
        {element.kind === "variation" && (
          <VariationValues variation={element} onChange={(values) => update({ values })} />
        )}
        {element.kind === "issue" && <IssueFields issue={element} model={model} />}
      </fieldset>

      <section className="subsection">
        <h3>関係</h3>
        {structural && <RelationAdder element={element} model={model} simple={simple} />}
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
                      {kindLabel(other.kind)}
                    </span>
                  )}
                  <button type="button" className="link" onClick={() => other && selectAndReveal(other.id)}>
                    {other?.name || "(名前なし)"}
                  </button>
                  {r.kind === "usecaseInformation" && <AccessSelect relation={r} other={other} structural={structural} />}
                  {structural && (
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`関係「${relationLabel(r.kind)} ${other?.name ?? ""}」を削除`}
                      onClick={() => {
                        // 簡易モードで主担当を外すと、業務の子 (活動・作業) が「担当が決まっていない業務」にぶら下がることがあるので確かめる
                        if (simple && relationRemovalImpact(model, r.id).length > 0) setConfirmUnlink(r.id);
                        else dispatch((m) => removeRelation(m, { id: r.id }));
                      }}
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

      <DerivedSection element={element} model={model} />

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
              // 設計データが一緒に消えるときは、消えるものを見せて確かめる
              // 内部のドメインモデルから消える・外れるものは、開発モードでなければ 1 行にまとめる (集約などの言葉を出さない)
              const internal = domainReferences(model, element.id);
              const refs = [...designReferences(model, element.id), ...(isDevMode() ? internal : internal.length > 0 ? ["実装のための内部の設計 (この要素を使っているところ)"] : [])];
              const impact = simple ? impactLines(removalImpact(model, element.id)) : [];
              if (refs.length > 0 || impact.length > 0) setConfirmRemove({ impact, refs });
              else removeSelected();
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
      {confirmRemove && (
        <ConfirmDialog
          title="削除の確認"
          message={
            confirmRemove.impact.length > 0
              ? `「${element.name || "(名前なし)"}」を削除します。つながっているものは次のとおりです。${confirmRemove.refs.length > 0 ? "このほか、次の設計データも一緒に消えます。" : ""}`
              : `「${element.name || "(名前なし)"}」を削除すると、次の設計データも一緒に消えます。`
          }
          details={confirmRemove.impact.length > 0 && confirmRemove.refs.length > 0 ? confirmRemove.impact : [...confirmRemove.impact, ...confirmRemove.refs]}
          detailGroups={confirmRemove.impact.length > 0 && confirmRemove.refs.length > 0 ? [{ title: "消える設計データ", items: confirmRemove.refs }] : undefined}
          confirmLabel="削除する"
          danger
          onCancel={() => setConfirmRemove(null)}
          onConfirm={() => {
            setConfirmRemove(null);
            removeSelected();
          }}
        />
      )}
      {confirmUnlink && (
        <ConfirmDialog
          title="主担当を外す確認"
          message={(() => {
            const rel = model.relations.find((r) => r.id === confirmUnlink);
            const name = (id?: string) => model.elements.find((e) => e.id === id)?.name || "(名前なし)";
            return `主担当の結び付き (${name(rel?.sourceId)} → ${name(rel?.targetId)}) を外します。この業務につながっているものは次のとおりです。`;
          })()}
          details={impactLines(relationRemovalImpact(model, confirmUnlink))}
          confirmLabel="外す"
          danger
          onCancel={() => setConfirmUnlink(null)}
          onConfirm={() => {
            const id = confirmUnlink;
            setConfirmUnlink(null);
            dispatch((m) => removeRelation(m, { id }));
          }}
        />
      )}
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
  // 簡易モードでは、ワークフローに統合された 4 つのレイヤー (登場人物・業務・活動・作業) の固定ボードへは移らない
  const simple = isSimpleBoard(boardId);
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
        <p className="hint">{simple ? "上下のレイヤーにつながる要素はありません。" : "上下のレイヤーにつながる要素はありません。「移動」でそのレイヤーの固定ボードへ移って結べます。"}</p>
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
              canMove={!(simple && isWorkflowLayer(r.layer))}
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
  canMove,
}: {
  dir: "up" | "own" | "down";
  layer: FixedLayer;
  elements: Element[];
  currentId: string;
  current: boolean;
  /** 「移動」ボタンを出すか (出さなくてもセルは残して、列を崩さない) */
  canMove: boolean;
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
        {canMove && <button
          type="button"
          className="layer-link"
          disabled={current}
          aria-label={`固定ボード「${FIXED_LAYER_LABELS[layer]}」へ移る`}
          title={current ? "今開いているボードです" : `固定ボード「${FIXED_LAYER_LABELS[layer]}」へ移る (この要素を選んだまま)`}
          onClick={() => goToLayer(layer, currentId)}
        >
          移動
        </button>}
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------- 種類固有

/** 操作が情報をどう扱うか (取得・保存)。関係一覧の「扱う」の行に出す。省略は取得も保存も */
function AccessSelect({ relation, other, structural }: { relation: Relation; other: Element | undefined; structural: boolean }) {
  const dispatch = useUntieStore((s) => s.dispatch);
  const pushToast = useUntieStore((s) => s.pushToast);
  const label = `「${other?.name ?? ""}」をどう扱うか`;
  if (!structural) {
    return <span className="access-chip">{relation.access ? INFORMATION_ACCESS_LABELS[relation.access] : INFORMATION_ACCESS_BOTH_LABEL}</span>;
  }
  return (
    <select
      className="access-select"
      aria-label={label}
      title="取得 (読む)・保存 (書く) の区別。置き場所の取得元・保存先はこれで決まります"
      value={relation.access ?? ""}
      onChange={(e) => {
        const r = dispatch((m) => setRelationAccess(m, { id: relation.id, access: (e.target.value || null) as InformationAccess | null }));
        if (!r.ok) pushToast(r.reason, "error");
      }}
    >
      <option value="">{INFORMATION_ACCESS_BOTH_LABEL}</option>
      {INFORMATION_ACCESSES.map((a) => (
        <option key={a} value={a}>
          {INFORMATION_ACCESS_LABELS[a]}
        </option>
      ))}
    </select>
  );
}

/**
 * 操作から導いたもの (0.4.0 から関係には持たない):
 * - 情報: 置き場所 (取得元・保存先のシステム・帳票)
 * - システム・帳票: そこにある情報 (取得元・保存先)
 * - 画面: 扱う情報
 * どれも「扱う操作」から決まるので、変えるには操作のプロパティ欄で扱う情報・取得・保存・対象を直す
 */
function DerivedSection({ element, model }: { element: Element; model: UntieModel }) {
  const derived = useMemo(() => {
    if (element.kind === "information") return { title: "置き場所", list: informationPlaces(model).get(element.id) ?? [], hint: "扱う操作の対象 (画面ならそのシステム) と、取得・保存の区別から導いています。変えるには、操作のプロパティ欄で扱う情報と対象を直してください。" };
    if (element.kind === "system" || element.kind === "ledger") return { title: "ここにある情報", list: placeInformations(model).get(element.id) ?? [], hint: "このシステム・帳票を対象にした操作が扱う情報から導いています。変えるには、操作のプロパティ欄で扱う情報と対象を直してください。" };
    if (element.kind === "screen") return { title: "扱う情報", list: screenInformations(model).get(element.id) ?? [], hint: "この画面を使う操作が扱う情報から導いています。変えるには、操作のプロパティ欄で扱う情報と対象を直してください。" };
    return null;
  }, [element, model]);
  if (!derived) return null;
  const nameOf = (id: string) => model.elements.find((e) => e.id === id);
  const roles = (d: Derived) => d.roles.map((r) => PLACE_ROLE_LABELS[r]).join("・");
  return (
    <section className="subsection" data-testid="derived-section">
      <h3>{derived.title}</h3>
      {derived.list.length === 0 ? (
        <p className="hint">まだありません。{derived.hint}</p>
      ) : (
        <>
          <ul className="relation-list derived-list">
            {derived.list.map((d) => {
              const other = nameOf(d.id);
              if (!other) return null;
              return (
                <li key={d.id}>
                  <span className="relation-kind">{roles(d)}</span>
                  <span className={`relation-layer kind-${other.kind}`}>
                    <span className="kind-dot" />
                    {ELEMENT_KIND_LABELS[other.kind]}
                  </span>
                  <button type="button" className="link" onClick={() => selectAndReveal(other.id)}>
                    {other.name || "(名前なし)"}
                  </button>
                  <span className="derived-via">
                    {d.usecaseIds.map((ucId, i) => {
                      const uc = nameOf(ucId);
                      return (
                        <span key={ucId}>
                          {i > 0 && "、"}
                          <button type="button" className="link muted" onClick={() => selectAndReveal(ucId)}>
                            {uc?.name || "(名前なし)"}
                          </button>
                        </span>
                      );
                    })}
                  </span>
                </li>
              );
            })}
          </ul>
          <p className="hint">{derived.hint}</p>
        </>
      )}
    </section>
  );
}

/** この要素と結べる要素を選んで関係を足す (両端の種類から関係が決まる)。固定ボードだけで出す */
const isTriggerKind = (kind: string) => kind === "activityTrigger" || kind === "eventActivity";

function RelationAdder({ element, model, simple = false }: { element: Element; model: UntieModel; simple?: boolean }) {
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
      // 操作の対象 (システム・帳票・画面) は 1 つだけなので、操作のプロパティ欄の「対象」で選ぶ
      if (isUsecaseTargetKind(kind)) break;
      // 作業の起点は、作業の「起点」の節で足す
      if (isTriggerKind(kind)) break;
      if (model.relations.some((r) => sameRelation(r, { kind, sourceId, targetId }))) break;
      const dir = relationRule(kind).undirected ? "↔" : sourceId === element.id ? "→" : "←";
      options.push({
        value: `${sourceId}>${targetId}`,
        group: `${relationLabel(kind)} ${dir} ${simple ? workflowKindLabel(other.kind) : ELEMENT_KIND_LABELS[other.kind]}`,
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

/** 作業の候補を選ぶときの区別用の見出し (「業務」、活動があれば「業務 / 活動」)。未所属は「未所属」 */
function activityGroupLabel(model: UntieModel, activity: Activity): string {
  const buc = activity.bucId ? model.elements.find((e) => e.id === activity.bucId) : undefined;
  if (!buc || buc.kind !== "buc") return "未所属";
  const biz = model.elements.find((e) => e.id === buc.businessId);
  const bizName = biz?.name || "(名前なし)";
  return buc.isDefault ? bizName : `${bizName} / ${buc.name || "(名前なし)"}`;
}

/** 作業の起点。起点の作業・イベントを足す・外し (固定ボードだけ)、その他を 1 行で書く (固定ボードだけ)。この作業を起点にする作業は読み取りだけ */
function TriggerSection({
  activity,
  model,
  structural,
  update,
}: {
  activity: Activity;
  model: UntieModel;
  structural: boolean;
  update: (patch: Parameters<typeof updateElement>[1]["patch"]) => void;
}) {
  const dispatch = useUntieStore((s) => s.dispatch);
  const pushToast = useUntieStore((s) => s.pushToast);
  const triggers = activityTriggers(model, activity.id);
  const followers = activitiesTriggeredBy(model, activity.id);
  const chosen = new Set([...triggers.activities, ...triggers.events].map((e) => e.id));
  const activityOptions = model.elements.filter((e): e is Activity => e.kind === "activity" && e.id !== activity.id && !chosen.has(e.id));
  const eventOptions = model.elements.filter((e) => e.kind === "event" && !chosen.has(e.id));
  const activityGroups = [...new Set(activityOptions.map((a) => activityGroupLabel(model, a)))];
  const rows = [...triggers.activities, ...triggers.events];

  return (
    <section className="subsection" data-testid="trigger-section">
      <h3>起点</h3>
      {rows.length === 0 ? (
        structural && <p className="hint">この作業が始まるきっかけ (前の作業・イベント・その他) を足します。</p>
      ) : (
        <ul className="relation-list">
          {rows.map((other) => {
            const rel = model.relations.find(
              (r) => isTriggerKind(r.kind) && r.sourceId === other.id && r.targetId === activity.id,
            );
            return (
              <li key={other.id}>
                <span className="relation-kind">起点</span>
                <span className="relation-dir" aria-hidden="true">
                  ←
                </span>
                <span className={`relation-layer kind-${other.kind}`}>
                  <span className="kind-dot" />
                  {ELEMENT_KIND_LABELS[other.kind]}
                </span>
                <button type="button" className="link" onClick={() => selectAndReveal(other.id)}>
                  {other.name || "(名前なし)"}
                </button>
                {structural && rel && (
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`起点「${other.name || "(名前なし)"}」を外す`}
                    onClick={() => dispatch((m) => removeRelation(m, { id: rel.id }))}
                  >
                    ×
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {structural && (activityOptions.length > 0 || eventOptions.length > 0) && (
        <select
          aria-label="起点を追加"
          value=""
          onChange={(ev) => {
            const sourceId = ev.target.value;
            if (!sourceId) return;
            const r = dispatch((m) => addRelation(m, { sourceId, targetId: activity.id }));
            if (!r.ok) pushToast(r.reason, "error");
          }}
        >
          <option value="">起点を追加…</option>
          {activityGroups.map((g) => (
            <optgroup key={g} label={`${ELEMENT_KIND_LABELS.activity}: ${g}`}>
              {activityOptions
                .filter((a) => activityGroupLabel(model, a) === g)
                .map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name || "(名前なし)"}
                  </option>
                ))}
            </optgroup>
          ))}
          {eventOptions.length > 0 && (
            <optgroup label={ELEMENT_KIND_LABELS.event}>
              {eventOptions.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name || "(名前なし)"}
                </option>
              ))}
            </optgroup>
          )}
        </select>
      )}
      <CommitField
        label="起点 (その他)"
        maxLength={TRIGGER_NOTE_MAX_LENGTH}
        value={activity.triggerNote ?? ""}
        readOnly={!structural}
        onCommit={(triggerNote) => update({ triggerNote })}
      />
      {followers.length > 0 && (
        <>
          <h4>この作業を起点にする作業</h4>
          <ul className="relation-list" aria-label="この作業を起点にする作業">
            {followers.map((other) => (
              <li key={other.id}>
                <span className="relation-kind">起点</span>
                <span className="relation-dir" aria-hidden="true">
                  →
                </span>
                <span className={`relation-layer kind-${other.kind}`}>
                  <span className="kind-dot" />
                  {ELEMENT_KIND_LABELS[other.kind]}
                </span>
                <button type="button" className="link" onClick={() => selectAndReveal(other.id)}>
                  {other.name || "(名前なし)"}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
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

/** 操作の対象。システム・帳票・画面のどれか 1 つ (選ぶと前の対象と入れ替わる) */
function UsecaseTargetField({ usecaseId, model }: { usecaseId: string; model: UntieModel }) {
  const dispatch = useUntieStore((s) => s.dispatch);
  const pushToast = useUntieStore((s) => s.pushToast);
  const current = model.relations.find((r) => isUsecaseTargetKind(r.kind) && r.sourceId === usecaseId)?.targetId ?? "";
  const nameOf = (id: string) => model.elements.find((e) => e.id === id)?.name || "(名前なし)";
  const groups = [
    { label: "システム", items: model.elements.filter((e) => e.kind === "system").map((e) => ({ id: e.id, label: e.name || "(名前なし)", disabled: false })) },
    { label: "帳票", items: model.elements.filter((e) => e.kind === "ledger").map((e) => ({ id: e.id, label: e.name || "(名前なし)", disabled: false })) },
    {
      label: "画面",
      items: model.elements.flatMap((e) => {
        if (e.kind !== "screen") return [];
        const base = `${e.name || "(名前なし)"} (${nameOf(e.systemId)})`;
        const user = screenUserId(model, e.id);
        // 別の操作が使っている画面は選べない (自分が使っている画面はそのまま選べる)
        if (user && user !== usecaseId) return [{ id: e.id, label: `${base} — 使用中: ${nameOf(user)}`, disabled: true }];
        return [{ id: e.id, label: base, disabled: false }];
      }),
    },
  ].filter((g) => g.items.length > 0);
  return (
    <label className="field">
      <span className="field-label">対象</span>
      <select
        aria-label="対象"
        value={current}
        onChange={(e) => {
          const r = dispatch((m) => setUsecaseTarget(m, { usecaseId, targetId: e.target.value || null }));
          if (!r.ok) pushToast(r.reason, "error");
        }}
      >
        <option value="">なし</option>
        {groups.map((g) => (
          <optgroup key={g.label} label={g.label}>
            {g.items.map((o) => (
              <option key={o.id} value={o.id} disabled={o.disabled}>
                {o.label}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      <span className="hint">システム・帳票・画面のどれか 1 つ。画面を選ぶと、その画面のシステムが対象になります。別の操作が使っている画面は選べません。</span>
    </label>
  );
}

/** 画面を対象にしている操作の id (なければ undefined) */
function screenUserId(model: UntieModel, screenId: string): string | undefined {
  return model.relations.find((r) => r.kind === "usecaseScreen" && r.targetId === screenId)?.sourceId;
}

/** 画面を使う操作。選ぶと、操作の対象をこの画面に入れ替える (前にこの画面を使っていた操作の対象は外れる) */
function ScreenUsecaseField({ screenId, model }: { screenId: string; model: UntieModel }) {
  const dispatch = useUntieStore((s) => s.dispatch);
  const pushToast = useUntieStore((s) => s.pushToast);
  const readOnly = useUntieStore(selectReadOnly);
  const current = screenUserId(model, screenId) ?? "";
  const name = (id: string) => model.elements.find((e) => e.id === id)?.name || "(名前なし)";
  const usecases = model.elements.filter((e) => e.kind === "usecase");
  // 操作を使う作業ごとにまとめる。作業に属さない操作は「作業なし」
  const byActivity = new Map<string, string[]>();
  const noActivity: string[] = [];
  for (const u of usecases) {
    const acts = model.relations.filter((r) => r.kind === "activityUsecase" && r.targetId === u.id).map((r) => r.sourceId);
    if (acts.length === 0) noActivity.push(u.id);
    for (const a of acts) byActivity.set(a, [...(byActivity.get(a) ?? []), u.id]);
  }
  const label = (uId: string, activityId?: string) => (activityId ? `${name(uId)} (${name(activityId)})` : name(uId));
  const groups: { label: string; items: { key: string; id: string; label: string }[] }[] = [];
  for (const b of model.elements.filter((e) => e.kind === "buc")) {
    const items = model.elements
      .filter((e) => e.kind === "activity" && e.bucId === b.id)
      .flatMap((a) => (byActivity.get(a.id) ?? []).map((uId) => ({ key: `${a.id}/${uId}`, id: uId, label: label(uId, a.id) })));
    if (items.length > 0) groups.push({ label: `活動 (BUC): ${b.name || "(名前なし)"}`, items });
  }
  const placed = new Set(groups.flatMap((g) => g.items.map((i) => i.id)));
  const rest = [...byActivity.entries()].flatMap(([a, ids]) => ids.filter((uId) => !placed.has(uId)).map((uId) => ({ key: `${a}/${uId}`, id: uId, label: label(uId, a) })));
  if (rest.length > 0) groups.push({ label: "作業", items: rest });
  if (noActivity.length > 0) groups.push({ label: "作業なし", items: noActivity.map((uId) => ({ key: uId, id: uId, label: name(uId) })) });
  return (
    <label className="field">
      <span className="field-label">使う操作</span>
      <select
        aria-label="使う操作"
        value={current}
        disabled={readOnly}
        onChange={(e) => {
          const r = dispatch((m) => setScreenUsecase(m, { screenId, usecaseId: e.target.value || null }));
          if (!r.ok) pushToast(r.reason, "error");
        }}
      >
        <option value="">なし</option>
        {groups.map((g) => (
          <optgroup key={g.label} label={g.label}>
            {g.items.map((o) => (
              <option key={o.key} value={o.id}>
                {o.label}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      <span className="hint">操作の対象をこの画面にします。前にこの画面を使っていた操作の対象は外れます。</span>
    </label>
  );
}

/** 画面・非機能要件の属するシステム (帳票は持てないので、システムだけを出す) */
function SystemField({ element, model }: { element: Element; model: UntieModel }) {
  const dispatch = useUntieStore((s) => s.dispatch);
  const pushToast = useUntieStore((s) => s.pushToast);
  const systems = model.elements.filter((e) => e.kind === "system");
  const current = "systemId" in element ? element.systemId : "";
  // 画面を別のシステムへ移すと、それを指す設計データが外れる。外れるものを見せて確かめる (削除と同じ確認)
  const [pending, setPending] = useState<{ systemId: string; refs: string[] } | null>(null);
  const move = (systemId: string) => {
    const r = dispatch((m) => moveToSystem(m, { elementId: element.id, systemId }));
    if (!r.ok) pushToast(r.reason, "error");
  };
  return (
    <label className="field">
      <span className="field-label">システム</span>
      <select
        aria-label="システム"
        value={current}
        onChange={(e) => {
          const systemId = e.target.value;
          const refs = systemId === current ? [] : designReferences(model, element.id);
          if (refs.length > 0) setPending({ systemId, refs });
          else move(systemId);
        }}
      >
        {systems.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name || "(名前なし)"}
          </option>
        ))}
      </select>
      {pending && (
        <ConfirmDialog
          title="所属の変更の確認"
          message={`「${element.name || "(名前なし)"}」を別のシステムへ移すと、次の設計データが外れます。`}
          details={pending.refs}
          confirmLabel="移す"
          danger
          onCancel={() => setPending(null)}
          onConfirm={() => {
            const { systemId } = pending;
            setPending(null);
            move(systemId);
          }}
        />
      )}
    </label>
  );
}

/** 情報・状態・条件・バリエーション・イベントの所属コンテキスト。関係から見た候補も出す */
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
    onChange([...links, { title: title.trim() || truncateText(u, LINK_TITLE_MAX_LENGTH), url: u }]);
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
        <input aria-label="リンクの表示名" placeholder="表示名 (例: 鍵の受け渡しマニュアル)" maxLength={LINK_TITLE_MAX_LENGTH} value={title} onChange={(e) => setTitle(e.target.value)} />
        <div className="inline-add">
          <input
            aria-label="リンクの URL"
            placeholder="https://..."
            maxLength={LINK_URL_MAX_LENGTH}
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
              maxLength={VALUE_MAX_LENGTH}
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
          maxLength={VALUE_MAX_LENGTH}
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
  const simple = useUntieStore((s) => isSimpleBoard(s.ui.currentBoardId));
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
              const layer = t ? fixedLayerOf(t.kind) : null;
              return (
                <li key={id}>
                  <span className="relation-kind">{t ? ELEMENT_KIND_LABELS[t.kind] : ""}</span>
                  <button type="button" className="link" onClick={() => t && selectAndReveal(t.id)}>
                    {t?.name || "(名前なし)"}
                  </button>
                  {t && !(simple && layer && isWorkflowLayer(layer)) && (
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
 * アクター・外部アクターのペルソナ (人物像) と、困りごとのヒアリング。
 * 名前・説明と同じく、自由ボードでも編集できる。閲覧専用のファイルでは読み取りだけ
 */
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

/**
 * イベントの発生タイミング: 種類 (なし・定期・不定期)。定期は周期 (毎月・毎日・毎時) と、周期に合う日・時・分。
 * 補足は、定期なら「営業日だけ」など、不定期ならいつ起きるか (Webhook を受けたときなど)
 */
function EventTimingSection({ event }: { event: Extract<Element, { kind: "event" }> }) {
  const dispatch = useUntieStore((s) => s.dispatch);
  const pushToast = useUntieStore((s) => s.pushToast);
  const readOnly = useUntieStore(selectReadOnly);
  const timing = event.timing;

  /** いまのモデルのタイミングに、変えた項目だけ重ねて置く。種類を変えたら周期に合わない項目はコマンドが外す */
  const commit = (next: EventTiming | null) => {
    const r = dispatch((m) => setEventTiming(m, { id: event.id, timing: next }));
    if (!r.ok) pushToast(r.reason, "error");
  };
  const patch = (p: Partial<EventTiming>) => {
    if (!timing) return;
    const merged: Record<string, unknown> = { ...timing, ...p };
    for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k];
    commit(merged as unknown as EventTiming);
  };
  const numberSelect = (key: "day" | "hour" | "minute", label: string, values: number[], suffix: string) => (
    <label className="field event-timing-field">
      <span className="field-label">{label}</span>
      <select
        aria-label={`発生タイミングの${label}`}
        value={timing?.[key] ?? ""}
        disabled={readOnly}
        onChange={(e) => patch({ [key]: e.target.value === "" ? undefined : Number(e.target.value) })}
      >
        <option value="">--</option>
        {values.map((v) => (
          <option key={v} value={v}>
            {v}
            {suffix}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <section className="subsection" aria-label="発生タイミング">
      <h3>発生タイミング</h3>
      <p className="hint">定期は、毎月・毎日・毎時に繰り返すバッチ処理。不定期 (随時) は、Webhook などから API が呼ばれたときのような、決まった時刻の無い処理です。</p>
      <label className="field">
        <span className="field-label">種類</span>
        <select
          aria-label="発生タイミングの種類"
          value={timing?.type ?? ""}
          disabled={readOnly}
          onChange={(e) => {
            const type = e.target.value as EventTiming["type"] | "";
            if (type === "") commit(null);
            else commit({ ...(timing?.note ? { note: timing.note } : {}), ...(type === "scheduled" ? { type, every: timing?.every ?? "day", hour: timing?.hour, minute: timing?.minute, day: timing?.day } : { type }) } as EventTiming);
          }}
        >
          <option value="">決めていない</option>
          {EVENT_TIMING_TYPES.map((t) => (
            <option key={t} value={t}>
              {EVENT_TIMING_TYPE_LABELS[t]}
            </option>
          ))}
        </select>
      </label>
      {timing?.type === "scheduled" && (
        <div className="event-timing-row">
          <label className="field event-timing-field">
            <span className="field-label">周期</span>
            <select aria-label="発生タイミングの周期" value={timing.every ?? "day"} disabled={readOnly} onChange={(e) => patch({ every: e.target.value as EventTiming["every"] })}>
              {EVENT_TIMING_EVERIES.map((k) => (
                <option key={k} value={k}>
                  {EVENT_TIMING_EVERY_LABELS[k]}
                </option>
              ))}
            </select>
          </label>
          {timing.every === "month" && numberSelect("day", "日", range(1, 31), "日")}
          {timing.every !== "hour" && numberSelect("hour", "時", range(0, 23), "時")}
          {numberSelect("minute", "分", range(0, 59), "分")}
        </div>
      )}
      {timing && (
        <>
          <CommitField
            label={timing.type === "adhoc" ? "いつ起きるか" : "補足"}
            multiline
            maxLength={LIMITS.eventTimingNote.max}
            placeholder={timing.type === "adhoc" ? "例: 決済サービスから入金の Webhook を受けたとき" : "例: 営業日だけ・前日分をまとめて"}
            readOnly={readOnly}
            value={timing.note ?? ""}
            onCommit={(note) => patch({ note: note === "" ? undefined : note })}
          />
          <p className="hint event-timing-summary">{describeEventTiming(timing)}</p>
        </>
      )}
    </section>
  );
}

function PersonaSection({ actor }: { actor: Extract<Element, { kind: "actor" | "externalActor" }> }) {
  const dispatch = useUntieStore((s) => s.dispatch);
  const pushToast = useUntieStore((s) => s.pushToast);
  const readOnly = useUntieStore(selectReadOnly);
  const agentMode = useAgentStore((s) => s.mode);
  const agentRunning = useAgentStore((s) => s.running);
  const startHearing = useAgentStore((s) => s.startHearing);
  const provider = useAgentStore((s) => s.settings.provider);
  const settingsOpen = useAgentStore((s) => s.settingsOpen);
  const setSettingsOpen = useAgentStore((s) => s.setSettingsOpen);
  const [answerer, setAnswerer] = useState<HearingAnswerer>("persona");
  const [hasKey, setHasKey] = useState<boolean | undefined>(undefined);
  const persona = actor.persona;
  const hearing = agentMode.kind === "hearing" && agentMode.actorId === actor.id;

  // API キーがあるか (設定のダイアログを閉じたあとにも調べ直す)
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

  /** いまのモデルのペルソナに、変えた項目だけ重ねて置く (入力の確定が重なっても他の項目を巻き戻さない) */
  const commit = (patch: Partial<Persona>) => {
    const r = dispatch((m) => {
      const current = m.elements.find((e) => e.id === actor.id);
      const now = current && (current.kind === "actor" || current.kind === "externalActor") ? current.persona : undefined;
      return setPersona(m, { id: actor.id, persona: { ...now, ...patch } });
    });
    if (!r.ok) pushToast(r.reason, "error");
  };

  const textField = (key: "handle" | "attributes" | "background" | "goals" | "notes", max: number, multiline: boolean, placeholder?: string) => (
    <CommitField
      label={PERSONA_FIELD_LABELS[key]}
      multiline={multiline}
      maxLength={max}
      placeholder={placeholder}
      readOnly={readOnly}
      value={persona?.[key] ?? ""}
      onCommit={(v) => commit({ [key]: v })}
    />
  );

  return (
    <>
      <section className="subsection" aria-label="ペルソナ">
        <h3>ペルソナ</h3>
        <p className="hint">この人の人物像。AI のヒアリングで、この人になりきって答える材料になります。</p>
        {textField("handle", LIMITS.personaHandle.max, false, "例: 田中さん (店長・45歳)")}
        {textField("attributes", LIMITS.personaAttributes.max, false, "年代・経験年数・勤務形態など")}
        {textField("background", LIMITS.personaBackground.max, true, "何を任され、何を気にしているか")}
        {textField("goals", LIMITS.personaGoals.max, true, "この人が達成したいこと")}
        <label className="field">
          <span className="field-label">{PERSONA_FIELD_LABELS.itSkill}</span>
          <select
            aria-label={PERSONA_FIELD_LABELS.itSkill}
            value={persona?.itSkill ?? ""}
            disabled={readOnly}
            onChange={(e) => commit({ itSkill: (e.target.value || undefined) as Persona["itSkill"] })}
          >
            <option value="">未設定</option>
            {(Object.keys(PERSONA_IT_SKILL_LABELS) as NonNullable<Persona["itSkill"]>[]).map((k) => (
              <option key={k} value={k}>
                {PERSONA_IT_SKILL_LABELS[k]}
              </option>
            ))}
          </select>
        </label>
        {textField("notes", LIMITS.personaNotes.max, true)}
      </section>
      {!readOnly && (
        <section className="subsection" aria-label="困りごとのヒアリング">
          <label className="field">
            <span className="field-label">ヒアリングの答え方</span>
            <select aria-label="ヒアリングの答え方" value={answerer} disabled={hearing || agentRunning} onChange={(e) => setAnswerer(e.target.value as HearingAnswerer)}>
              {(Object.keys(HEARING_ANSWERER_LABELS) as HearingAnswerer[]).map((k) => (
                <option key={k} value={k}>
                  {HEARING_ANSWERER_LABELS[k]}
                  {k === "persona" ? " (既定)" : ""}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="link hearing-start"
            disabled={hearing || agentRunning || hasKey !== true}
            title={hasKey === false ? "「AI の設定」で API キーを入れると使えます" : "この人の困りごとを AI とのヒアリングで聞き出し、課題にする"}
            onClick={() => void startHearing(actor.id, answerer)}
          >
            {hearing ? "ヒアリング中…" : "困りごとをヒアリングする"}
          </button>
          {hasKey === false && (
            <p className="hint">
              「困りごとをヒアリングする」を使うには、
              <button type="button" className="link" onClick={() => setSettingsOpen(true)}>
                AI の設定
              </button>
              で {PROVIDERS[provider].label} の API キーを入れてください。
            </p>
          )}
        </section>
      )}
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
          maxLength={ANALYSIS_MAX_LENGTH}
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
