import { useEffect, useMemo, useState, type ReactNode } from "react";
import { moveBusinessOrder } from "@untie/core/model/commands";
import { addWorkflowElement, adjacentBusinessInWorkflow, buildWorkflow, canAddActivityToBusiness, SIMPLE_BOARD_LABELS, workflowKindLabel, type WorkflowAddKind, type WorkflowBusiness, type WorkflowBuc, type WorkflowOutsider } from "@untie/core/model/workflow";
import type { Activity, Actor, Element, EventElement, UntieModel } from "@untie/core/model/types";
import { selectReadOnly, useUntieStore } from "../../store";
import { canvasApi } from "../canvas/canvasApi";
import { NameForm } from "../NameForm";

export const nameOf = (e: { name: string }) => e.name || "(名前なし)";

/**
 * 情報整理の業務一覧ボード。登場人物 → 業務 → 活動 → 作業 を 1 枚で書く。
 * 配置は保存せず、毎回モデルから組み立てる (core の buildWorkflow)。詳細調整モードの固定ボードと同じモデルを別の見せ方で扱う。
 */
export function WorkflowBoard() {
  const model = useUntieStore((s) => s.model);
  const readOnly = useUntieStore(selectReadOnly);
  const workflow = useMemo(() => buildWorkflow(model), [model]);
  const dispatch = useUntieStore((s) => s.dispatch);
  const select = useUntieStore((s) => s.select);
  const setRightPanel = useUntieStore((s) => s.setRightPanel);
  const requestNameFocus = useUntieStore((s) => s.requestNameFocus);
  const pushToast = useUntieStore((s) => s.pushToast);
  const selectedId = useUntieStore((s) => (s.ui.selection?.type === "element" ? s.ui.selection.id : null));

  // 要素の場所へのスクロール (選択やリンクからの移動で呼ばれる)
  useEffect(() => {
    canvasApi.focus = (elementId, laneId) => {
      const sel = `[data-workflow-el="${CSS.escape(elementId)}"]`;
      // 足した直後は、押した行の中の要素を先に探す (主担当の行と担当の行のように、同じ要素が複数の行に出るため)
      const inLane = laneId ? document.querySelector(`[data-workflow-lane="${CSS.escape(laneId)}"] ${sel}`) : null;
      (inLane ?? document.querySelector(sel))?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    };
    return () => {
      canvasApi.focus = undefined;
    };
  }, []);

  // 作業ごとの担当の名前 (行ごとに関係を走査しない)
  const assignees = useMemo(() => {
    const names = new Map(model.elements.map((e) => [e.id, e.name]));
    const map = new Map<string, string[]>();
    for (const r of model.relations) {
      if (r.kind !== "actorActivity") continue;
      const name = names.get(r.sourceId);
      if (name) map.set(r.targetId, [...(map.get(r.targetId) ?? []), name]);
    }
    return map;
  }, [model]);

  const choose = (id: string) => {
    select({ type: "element", id });
    setRightPanel("properties");
  };

  /** 足した直後は選び、名前をすぐ打てるようにする */
  const add = (kind: WorkflowAddKind, parentId?: string, options: { assigneeId?: string; laneId?: string } = {}) => {
    const { assigneeId, laneId } = options;
    const r = dispatch((m) => addWorkflowElement(m, kind, parentId, assigneeId !== undefined ? { assigneeId } : {}));
    if (!r.ok) {
      pushToast(r.reason, "error");
      return;
    }
    choose(r.id);
    requestNameFocus();
    setTimeout(() => canvasApi.focus?.(r.id, laneId), 50);
  };

  /** 業務を、その行 (laneId。担当なしの区画は空文字) の中の隣の業務と入れ替える。押した業務を選び、動いた先へスクロールする (dispatch 1 回 = 履歴 1 件) */
  const moveBusiness = (id: string, laneId: string, direction: "before" | "after") => {
    const targetId = adjacentBusinessInWorkflow(model, id, laneId, direction);
    if (!targetId) return;
    const r = dispatch((m) => moveBusinessOrder(m, { id, targetId, position: direction }));
    if (!r.ok) {
      pushToast(r.reason, "error");
      return;
    }
    choose(id);
    setTimeout(() => canvasApi.focus?.(id, laneId), 50);
  };

  const ctx: Ctx = { model, readOnly, selectedId, assignees, choose, add, moveBusiness };
  const empty = workflow.lanes.length === 0 && workflow.outsiders.length === 0 && workflow.unassigned.length === 0 && workflow.orphanActivities.length === 0;

  return (
    <div className="fixed-board workflow-board" data-testid="workflow-board">
      <div className="fixed-head">
        <h2 className="fixed-title">{SIMPLE_BOARD_LABELS.workflow}</h2>
        <span className="fixed-hint">登場人物から業務を、業務から活動と作業を生やして書きます。業務・活動は枠、作業は枠の中に縦に並びます。選ぶと右のプロパティで関連や削除を直せます。名前を押すと、その場で名前を直せます。業務の枠の「←」「→」で、同じ行の中の業務の順序を変えられます (業務フローの並びも同じです)。社内の登場人物の行のあとに、外部の登場人物とシステムの区画があり、それぞれが発生させるイベントを並べます。</span>
        {!readOnly && (
          <button type="button" className="fixed-head-add" aria-label="登場人物を足す" onClick={() => add("actor")}>
            ＋登場人物
          </button>
        )}
      </div>
      {empty && <p className="hint">まだ何もありません。「＋登場人物」から書き始めます。</p>}
      {workflow.lanes.map((lane) => (
        <section key={lane.actor.id} className="wf-lane" data-workflow-lane={lane.actor.id} aria-label={`登場人物 ${nameOf(lane.actor)} の行`}>
          <ActorCard actor={lane.actor} hasBusinesses={lane.businesses.length > 0} ctx={ctx} />
          {lane.businesses.length > 0 && (
            <>
              <div className="wf-trunk" aria-hidden="true" />
              <ul className="wf-businesses">
                {lane.businesses.map((b) => (
                  <li key={b.business.id} className="wf-branch-item">
                    <BusinessFrame box={b} laneActorId={lane.actor.id} ctx={ctx} />
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      ))}
      {(workflow.outsiders.length > 0 || !readOnly) && (
        <section className="wf-section wf-outsider-section" aria-label="外部の登場人物とシステム">
          <h3 className="wf-section-title">外部の登場人物とシステム</h3>
          <p className="fixed-hint">業務の主担当にも、作業の担当にもなれません。イベントを発生させます (イベントの発生元は、イベントのプロパティで結べます)。</p>
          {!readOnly && (
            <div className="wf-actions">
              <button type="button" className="wf-add" aria-label="外部の登場人物を足す" onClick={() => add("externalActor")}>
                ＋外部の登場人物
              </button>
              <button type="button" className="wf-add" aria-label="システムを足す" onClick={() => add("system")}>
                ＋システム
              </button>
            </div>
          )}
          {workflow.outsiders.length > 0 && (
            <ul className="wf-outsiders">
              {workflow.outsiders.map((o) => (
                <li key={o.element.id} className="wf-outsider-item">
                  <OutsiderColumn outsider={o} ctx={ctx} />
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      {workflow.unassigned.length > 0 && (
        <section className="wf-section" aria-label="担当が決まっていない業務">
          <h3 className="wf-section-title">担当が決まっていない業務</h3>
          <p className="fixed-hint">業務を選び、プロパティの「関係を追加」で主担当の登場人物を結ぶと、その人の行に移ります。</p>
          <ul className="wf-businesses is-flat">
            {workflow.unassigned.map((b) => (
              <li key={b.business.id}>
                <BusinessFrame box={b} laneActorId="" ctx={ctx} />
              </li>
            ))}
          </ul>
        </section>
      )}
      {workflow.orphanActivities.length > 0 && (
        <section className="wf-section" aria-label="業務に属さない作業">
          <h3 className="wf-section-title">業務に属さない作業</h3>
          <p className="fixed-hint">作業を選び、プロパティの「業務」「活動」で所属を決めると、業務の枠に移ります。</p>
          <ActivityStack activities={workflow.orphanActivities} ctx={ctx} />
        </section>
      )}
    </div>
  );
}

interface Ctx {
  model: UntieModel;
  readOnly: boolean;
  selectedId: string | null;
  assignees: Map<string, string[]>;
  choose: (id: string) => void;
  /** laneId: 押した行 (足した要素へは、その行の中を先にスクロールする) */
  add: (kind: WorkflowAddKind, parentId?: string, options?: { assigneeId?: string; laneId?: string }) => void;
  /** 業務を、同じ行 (laneId。担当なしの区画は空文字) の前・後ろの業務と入れ替える */
  moveBusiness: (id: string, laneId: string, direction: "before" | "after") => void;
}

/** 名前をクリックして直せる箱の指定。body は、名前の部分 (name) を差し込んだ中身を返す */
export interface PickRename {
  element: Element;
  body: (name: ReactNode) => ReactNode;
}

/**
 * 選べる箱 (カード・枠の見出し・作業の行)。ボタンなのでキーボードでも選べる。
 * rename を渡すと、名前を押したとき、その要素を選んだうえでその場で入力欄に替わる (閲覧専用・既定の活動では替わらない)。
 * 入力欄はボタンの中に置けないので、編集中は div にする。編集に入るのは押した箱だけ (同じ要素が複数の行に出ても、ほかの箱は変わらない)
 */
export function Pick({
  id,
  className,
  ctx,
  children,
  label,
  rename,
}: {
  id: string;
  className: string;
  ctx: { selectedId: string | null; choose: (id: string) => void; readOnly?: boolean };
  children?: ReactNode;
  label?: string;
  rename?: PickRename;
}) {
  const [editing, setEditing] = useState(false);
  const selected = ctx.selectedId === id;
  const cls = `${className}${selected ? " is-selected" : ""}`;
  // 既定の活動の名前は業務の名前と同じで、直接は変えられない
  const renamable = !!rename && !ctx.readOnly && !(rename.element.kind === "buc" && rename.element.isDefault);
  if (rename && renamable && editing) {
    return (
      // 枠の選択 (onClick) へ伝えない
      <div className={cls} aria-current={selected ? "true" : undefined} onClick={(e) => e.stopPropagation()}>
        {rename.body(<NameForm element={rename.element} kindLabel={workflowKindLabel(rename.element.kind)} onDone={() => setEditing(false)} />)}
      </div>
    );
  }
  const name = rename ? (
    <span className={`wf-name${renamable ? " is-renamable" : ""}`} title={renamable ? "クリックで名前を変える" : undefined} onClick={renamable ? () => setEditing(true) : undefined}>
      {nameOf(rename.element)}
    </span>
  ) : null;
  return (
    <button
      type="button"
      className={cls}
      aria-current={selected ? "true" : undefined}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        ctx.choose(id);
      }}
    >
      {rename ? rename.body(name) : children}
    </button>
  );
}

function ActorCard({ actor, hasBusinesses, ctx }: { actor: Actor; hasBusinesses: boolean; ctx: Ctx }) {
  return (
    <div className={`wf-actor kind-${actor.kind}${ctx.selectedId === actor.id ? " is-selected" : ""}`} data-workflow-el={actor.id}>
      <Pick id={actor.id} className="wf-actor-card" ctx={ctx} label={`登場人物 ${nameOf(actor)}`} rename={{ element: actor, body: (name) => <><span className="wf-kind">登場人物</span>{name}</> }} />
      {!ctx.readOnly && (
        <button type="button" className="wf-add" aria-label={`「${nameOf(actor)}」に業務を足す`} onClick={() => ctx.add("business", actor.id, { laneId: actor.id })}>
          ＋業務
        </button>
      )}
      {!hasBusinesses && <span className="wf-note">業務はまだありません</span>}
    </div>
  );
}

/** 外部の登場人物・システムの 1 列: 上にカード、その下に発生させるイベントの縦の一覧と「＋イベント」 */
function OutsiderColumn({ outsider, ctx }: { outsider: WorkflowOutsider; ctx: Ctx }) {
  const { element, events } = outsider;
  const kind = element.kind === "system" ? "システム" : "外部の登場人物";
  return (
    <section className={`wf-outsider kind-${element.kind}`} data-workflow-lane={element.id} aria-label={`${kind} ${nameOf(element)} の列`}>
      <div data-workflow-el={element.id}>
        <Pick id={element.id} className="wf-actor-card" ctx={ctx} label={`${kind} ${nameOf(element)}`} rename={{ element, body: (name) => <><span className="wf-kind">{kind}</span>{name}</> }} />
      </div>
      {events.length === 0 ? (
        <p className="wf-note">イベントはまだありません</p>
      ) : (
        <ul className="wf-stack" aria-label="発生させるイベントの一覧">
          {events.map((ev: EventElement) => (
            <li key={ev.id} data-workflow-el={ev.id}>
              <Pick id={ev.id} className="wf-event" ctx={ctx} label={`イベント ${nameOf(ev)}`} rename={{ element: ev, body: (name) => <><span className="wf-kind">イベント</span>{name}</> }} />
            </li>
          ))}
        </ul>
      )}
      {!ctx.readOnly && (
        <button type="button" className="wf-add" aria-label={`「${nameOf(element)}」にイベントを足す`} onClick={() => ctx.add("event", element.id, { laneId: element.id })}>
          ＋イベント
        </button>
      )}
    </section>
  );
}

function BusinessFrame({ box, laneActorId, ctx }: { box: WorkflowBusiness; laneActorId: string; ctx: Ctx }) {
  const { business } = box;
  const others = box.ownerIds.filter((id) => id !== laneActorId).map((id) => ctx.model.elements.find((e) => e.id === id)).filter((e) => !!e);
  const canAddActivity = canAddActivityToBusiness(ctx.model, business.id);
  const laneName = nameOf(ctx.model.elements.find((e) => e.id === laneActorId) ?? { name: "" });
  const prevId = ctx.readOnly ? null : adjacentBusinessInWorkflow(ctx.model, business.id, laneActorId, "before");
  const nextId = ctx.readOnly ? null : adjacentBusinessInWorkflow(ctx.model, business.id, laneActorId, "after");
  const moveButton = (direction: "before" | "after", neighborId: string | null) => {
    const word = direction === "before" ? "前へ" : "後ろへ";
    const title = neighborId ? `この業務を${word}動かす (同じ行の隣の業務と入れ替わります)` : direction === "before" ? "この行の先頭の業務です" : "この行の最後の業務です";
    return (
      <button
        type="button"
        className="wf-add wf-move"
        aria-label={`「${nameOf(business)}」を${word}`}
        title={title}
        disabled={!neighborId}
        onClick={(e) => {
          e.stopPropagation();
          ctx.moveBusiness(business.id, laneActorId, direction);
        }}
      >
        {direction === "before" ? "←" : "→"}
      </button>
    );
  };
  return (
    <section
      className={`wf-frame wf-business${ctx.selectedId === business.id ? " is-selected" : ""}`}
      aria-label={`業務 ${nameOf(business)}${laneActorId ? ` (${laneName} の行)` : ""}`}
      data-workflow-el={business.id}
      onClick={() => ctx.choose(business.id)}
    >
      <header className="wf-frame-head">
        <Pick id={business.id} className="wf-frame-title" ctx={ctx} label={`業務 ${nameOf(business)}`} rename={{ element: business, body: (name) => <><span className="wf-kind">業務</span>{name}</> }} />
        {!ctx.readOnly && (
          <div className="wf-move-group" role="group" aria-label={`「${nameOf(business)}」の順序`}>
            {moveButton("before", prevId)}
            {moveButton("after", nextId)}
          </div>
        )}
      </header>
      {/* 行は業務の主担当で決まり、作業の担当は行を決めない。担当を外してもカードは枠に残るので、そのことを伝える */}
      {laneActorId && <p className="wf-note wf-lane-note">行は業務の主担当 ({laneName})。作業の担当は、各カードに出ます。</p>}
      {box.ownerIds.length > 1 && laneActorId && (
        <p className="wf-warning">主担当が複数います (ほかに {others.map((o) => nameOf(o!)).join("、")} の行にも出ています)。主担当は 1 人にしてください。</p>
      )}
      {box.direct.length > 0 && <ActivityStack activities={box.direct} ctx={ctx} />}
      {box.direct.length > 0 && box.bucs.length > 0 && <p className="wf-warning">活動のある業務です。作業をどれかの活動に移してください (プロパティの「活動」)。</p>}
      {!ctx.readOnly && box.bucs.length > 0 && <p className="wf-note">作業は活動の枠の「＋作業」から足します。</p>}
      {box.bucs.map((b) => (
        <BucFrame key={b.buc.id} box={b} ctx={ctx} laneId={laneActorId} />
      ))}
      {!ctx.readOnly && (
        <div className="wf-actions">
          <button type="button" className="wf-add" aria-label={`「${nameOf(business)}」に活動を足す`} onClick={(e) => { e.stopPropagation(); ctx.add("buc", business.id, { laneId: laneActorId }); }}>
            ＋活動
          </button>
          {canAddActivity && (
            <button type="button" className="wf-add" aria-label={`「${nameOf(business)}」に作業を足す`} onClick={(e) => { e.stopPropagation(); ctx.add("activity", business.id, { laneId: laneActorId }); }}>
              ＋作業
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function BucFrame({ box, ctx, laneId }: { box: WorkflowBuc; ctx: Ctx; laneId: string }) {
  const { buc } = box;
  return (
    <section
      className={`wf-frame wf-buc${ctx.selectedId === buc.id ? " is-selected" : ""}`}
      aria-label={`活動 ${nameOf(buc)}`}
      data-workflow-el={buc.id}
      onClick={(e) => {
        e.stopPropagation();
        ctx.choose(buc.id);
      }}
    >
      <header className="wf-frame-head">
        <Pick id={buc.id} className="wf-frame-title" ctx={ctx} label={`活動 ${nameOf(buc)}`} rename={{ element: buc, body: (name) => <><span className="wf-kind">活動</span>{name}</> }} />
      </header>
      <ActivityStack activities={box.activities} ctx={ctx} />
      {!ctx.readOnly && (
        <div className="wf-actions">
          <button type="button" className="wf-add" aria-label={`「${nameOf(buc)}」に作業を足す`} onClick={(e) => { e.stopPropagation(); ctx.add("activity", buc.id, { laneId }); }}>
            ＋作業
          </button>
        </div>
      )}
    </section>
  );
}

/** 作業を縦に積んだ一覧 */
function ActivityStack({ activities, ctx }: { activities: Activity[]; ctx: Ctx }) {
  if (activities.length === 0) return <p className="wf-note">作業はまだありません</p>;
  return (
    <ul className="wf-stack" aria-label="作業の一覧">
      {activities.map((a) => {
        const assignees = ctx.assignees.get(a.id) ?? [];
        return (
          <li key={a.id} data-workflow-el={a.id}>
            <Pick
              id={a.id}
              className="wf-activity"
              ctx={ctx}
              label={`作業 ${nameOf(a)} (${assignees.length > 0 ? `担当: ${assignees.join("、")}` : "担当なし"})`}
              rename={{
                element: a,
                body: (name) => (
                  <>
                    <span className="wf-kind">作業</span>
                    {name}
                    {assignees.length > 0 ? <span className="wf-assignees">担当: {assignees.join("、")}</span> : <span className="wf-assignees is-none">担当なし</span>}
                  </>
                ),
              }}
            />
          </li>
        );
      })}
    </ul>
  );
}
