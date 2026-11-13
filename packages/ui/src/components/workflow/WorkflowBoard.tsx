import { useEffect, useMemo, type ReactNode } from "react";
import { activityParentOptions, addWorkflowElement, buildWorkflow, canAddActivityToBusiness, SIMPLE_BOARD_LABELS, type WorkflowAddKind, type WorkflowBusiness, type WorkflowBuc } from "@untie/core/model/workflow";
import type { Activity, Actor, ExternalActor, UntieModel } from "@untie/core/model/types";
import { selectReadOnly, useUntieStore } from "../../store";
import { canvasApi } from "../canvas/canvasApi";

export const nameOf = (e: { name: string }) => e.name || "(名前なし)";

/**
 * 分析（簡易）のワークフローボード。登場人物 → 業務 → 活動 → 作業 を 1 枚で書く。
 * 配置は保存せず、毎回モデルから組み立てる (core の buildWorkflow)。詳細モードの固定ボードと同じモデルを別の見せ方で扱う。
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

  const parentOptions = useMemo(() => activityParentOptions(model), [model]);
  const ctx: Ctx = { model, readOnly, selectedId, assignees, choose, add, parentOptions };
  const empty = workflow.lanes.length === 0 && workflow.unassigned.length === 0 && workflow.orphanActivities.length === 0;

  return (
    <div className="fixed-board workflow-board" data-testid="workflow-board">
      <div className="fixed-head">
        <h2 className="fixed-title">{SIMPLE_BOARD_LABELS.workflow}</h2>
        <span className="fixed-hint">登場人物から業務を、業務から活動と作業を生やして書きます。業務・活動は枠、作業は枠の中に縦に並びます。選ぶと右のプロパティで関連や削除を直せます。</span>
        {!readOnly && (
          <button type="button" className="fixed-head-add" aria-label="登場人物を足す" onClick={() => add("actor")}>
            ＋登場人物
          </button>
        )}
      </div>
      {empty && <p className="hint">まだ何もありません。「＋登場人物」から書き始めます。</p>}
      {workflow.lanes.map((lane) => (
        <section key={lane.actor.id} className="wf-lane" data-workflow-lane={lane.actor.id} aria-label={`登場人物 ${nameOf(lane.actor)} の行`}>
          <ActorCard actor={lane.actor} hasBusinesses={lane.businesses.length > 0 || lane.orphanActivities.length > 0} ctx={ctx} />
          {(lane.businesses.length > 0 || lane.orphanActivities.length > 0) && (
            <>
              <div className="wf-trunk" aria-hidden="true" />
              <ul className="wf-businesses">
                {lane.businesses.map((b) => (
                  <li key={b.business.id} className={`wf-branch-item${b.assignedOnly ? " is-assigned" : ""}`}>
                    <BusinessFrame box={b} laneActorId={lane.actor.id} ctx={ctx} />
                  </li>
                ))}
                {lane.orphanActivities.length > 0 && (
                  <li className="wf-branch-item is-assigned">
                    <section className="wf-frame wf-business is-assigned" aria-label={`業務に属さない作業 (${nameOf(lane.actor)} が担当する作業)`} onClick={(e) => e.stopPropagation()}>
                      <header className="wf-frame-head">
                        <h3 className="wf-section-title">業務に属さない作業</h3>
                      </header>
                      <p className="wf-note">担当する作業</p>
                      <ActivityStack activities={lane.orphanActivities} ctx={ctx} />
                    </section>
                  </li>
                )}
              </ul>
            </>
          )}
        </section>
      ))}
      {workflow.unassigned.length > 0 && (
        <section className="wf-section" aria-label="担当が決まっていない業務">
          <h3 className="wf-section-title">担当が決まっていない業務</h3>
          <p className="fixed-hint">業務を選び、プロパティの「関係を追加」で主担当の登場人物を結ぶと、その人の行に移ります。外部の登場人物が担当する作業は、その人の行にも出ます。</p>
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
  /** 作業を足せる足し先 (業務・活動) の候補 (外部の登場人物のカードのセレクト) */
  parentOptions: { id: string; label: string }[];
}

/** 選べる箱 (カード・枠の見出し・作業の行)。ボタンなのでキーボードでも選べる */
export function Pick({ id, className, ctx, children, label }: { id: string; className: string; ctx: { selectedId: string | null; choose: (id: string) => void }; children: ReactNode; label?: string }) {
  const selected = ctx.selectedId === id;
  return (
    <button
      type="button"
      className={`${className}${selected ? " is-selected" : ""}`}
      aria-current={selected ? "true" : undefined}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        ctx.choose(id);
      }}
    >
      {children}
    </button>
  );
}

function ActorCard({ actor, hasBusinesses, ctx }: { actor: Actor | ExternalActor; hasBusinesses: boolean; ctx: Ctx }) {
  const external = actor.kind === "externalActor";
  return (
    <div className={`wf-actor kind-${actor.kind}${ctx.selectedId === actor.id ? " is-selected" : ""}`} data-workflow-el={actor.id}>
      <Pick id={actor.id} className="wf-actor-card" ctx={ctx} label={`${external ? "外部の登場人物" : "登場人物"} ${nameOf(actor)}`}>
        <span className="wf-kind">{external ? "外部の登場人物" : "登場人物"}</span>
        <span className="wf-name">{nameOf(actor)}</span>
      </Pick>
      {!ctx.readOnly && !external && (
        <button type="button" className="wf-add" aria-label={`「${nameOf(actor)}」に業務を足す`} onClick={() => ctx.add("business", actor.id, { laneId: actor.id })}>
          ＋業務
        </button>
      )}
      {/* 外部の登場人物は業務の主担当にはなれないが、作業の担当にはなれる。担当する作業のある業務の枠を出し、作業はここから足せる */}
      {!ctx.readOnly && external && ctx.parentOptions.length > 0 && (
        <select
          className="wf-add"
          aria-label={`「${nameOf(actor)}」に作業を足す (業務・活動を選ぶ)`}
          value=""
          onChange={(e) => {
            if (e.target.value) ctx.add("activity", e.target.value, { assigneeId: actor.id, laneId: actor.id });
          }}
        >
          <option value="">＋作業 (業務・活動を選ぶ)</option>
          {ctx.parentOptions.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      )}
      {!ctx.readOnly && external && ctx.parentOptions.length === 0 && <span className="wf-note">作業を足すには、先に業務を作ってください</span>}
      {external && <span className="wf-note">業務の主担当にはなれません。担当する作業を、業務ごとに出します</span>}
      {!hasBusinesses && !external && <span className="wf-note">業務はまだありません</span>}
      {!hasBusinesses && external && <span className="wf-note">担当する作業はまだありません</span>}
    </div>
  );
}

function BusinessFrame({ box, laneActorId, ctx }: { box: WorkflowBusiness; laneActorId: string; ctx: Ctx }) {
  const { business } = box;
  const others = box.ownerIds.filter((id) => id !== laneActorId).map((id) => ctx.model.elements.find((e) => e.id === id)).filter((e) => !!e);
  const canAddActivity = canAddActivityToBusiness(ctx.model, business.id);
  // 外部の登場人物の行の枠 (担当する作業だけ): 主担当の業務ではないので、主担当を添えて区別する。活動は足さず、作業はその人の担当として足す
  const assigned = box.assignedOnly === true;
  const laneName = nameOf(ctx.model.elements.find((e) => e.id === laneActorId) ?? { name: "" });
  const owners = box.ownerIds.map((id) => ctx.model.elements.find((e) => e.id === id)).filter((e): e is NonNullable<typeof e> => !!e);
  return (
    <section
      className={`wf-frame wf-business${assigned ? " is-assigned" : ""}${ctx.selectedId === business.id ? " is-selected" : ""}`}
      aria-label={`業務 ${nameOf(business)}${laneActorId ? ` (${laneName} ${assigned ? "が担当する作業" : "の行"})` : ""}`}
      data-workflow-el={business.id}
      onClick={() => ctx.choose(business.id)}
    >
      <header className="wf-frame-head">
        <Pick id={business.id} className="wf-frame-title" ctx={ctx} label={`業務 ${nameOf(business)}`}>
          <span className="wf-kind">業務</span>
          <span className="wf-name">{nameOf(business)}</span>
        </Pick>
      </header>
      {assigned && <p className="wf-note">担当する作業 ({owners.length > 0 ? `主担当: ${owners.map(nameOf).join("、")}` : "主担当は決まっていません"})</p>}
      {!assigned && box.ownerIds.length > 1 && laneActorId && (
        <p className="wf-warning">主担当が複数います (ほかに {others.map((o) => nameOf(o!)).join("、")} の行にも出ています)。主担当は 1 人にしてください。</p>
      )}
      {box.direct.length > 0 && <ActivityStack activities={box.direct} ctx={ctx} />}
      {box.direct.length > 0 && box.bucs.length > 0 && <p className="wf-warning">活動のある業務です。作業をどれかの活動に移してください (プロパティの「活動」)。</p>}
      {!ctx.readOnly && box.bucs.length > 0 && <p className="wf-note">作業は活動の枠の「＋作業」から足します。</p>}
      {/* 担当の枠で、活動のある業務の直下の作業だけを担当しているときは、ここに足せるボタンが無いので理由を出す */}
      {!ctx.readOnly && assigned && !canAddActivity && box.bucs.length === 0 && (
        <p className="wf-note">この業務には活動があるので、作業は活動に足します。カードの「＋作業 (業務・活動を選ぶ)」から活動を選んでください。</p>
      )}
      {box.bucs.map((b) => (
        <BucFrame key={b.buc.id} box={b} ctx={ctx} laneId={laneActorId} assigned={assigned} />
      ))}
      {!ctx.readOnly && (
        <div className="wf-actions">
          {!assigned && (
            <button type="button" className="wf-add" aria-label={`「${nameOf(business)}」に活動を足す`} onClick={(e) => { e.stopPropagation(); ctx.add("buc", business.id, { laneId: laneActorId }); }}>
              ＋活動
            </button>
          )}
          {canAddActivity && (
            <button type="button" className="wf-add" aria-label={assigned ? `「${nameOf(business)}」に${laneName}が担当する作業を足す` : `「${nameOf(business)}」に作業を足す`} onClick={(e) => { e.stopPropagation(); ctx.add("activity", business.id, { ...(assigned ? { assigneeId: laneActorId } : {}), laneId: laneActorId }); }}>
              ＋作業
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function BucFrame({ box, ctx, laneId, assigned }: { box: WorkflowBuc; ctx: Ctx; laneId: string; assigned: boolean }) {
  const laneName = nameOf(ctx.model.elements.find((e) => e.id === laneId) ?? { name: "" });
  const { buc } = box;
  return (
    <section
      className={`wf-frame wf-buc${ctx.selectedId === buc.id ? " is-selected" : ""}`}
      aria-label={assigned ? `活動 ${nameOf(buc)} (${laneName} が担当する作業)` : `活動 ${nameOf(buc)}`}
      data-workflow-el={buc.id}
      onClick={(e) => {
        e.stopPropagation();
        ctx.choose(buc.id);
      }}
    >
      <header className="wf-frame-head">
        <Pick id={buc.id} className="wf-frame-title" ctx={ctx} label={`活動 ${nameOf(buc)}`}>
          <span className="wf-kind">活動</span>
          <span className="wf-name">{nameOf(buc)}</span>
        </Pick>
      </header>
      <ActivityStack activities={box.activities} ctx={ctx} />
      {!ctx.readOnly && (
        <div className="wf-actions">
          <button type="button" className="wf-add" aria-label={assigned ? `「${nameOf(buc)}」に${laneName}が担当する作業を足す` : `「${nameOf(buc)}」に作業を足す`} onClick={(e) => { e.stopPropagation(); ctx.add("activity", buc.id, { ...(assigned ? { assigneeId: laneId } : {}), laneId }); }}>
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
            <Pick id={a.id} className="wf-activity" ctx={ctx} label={`作業 ${nameOf(a)}${assignees.length > 0 ? ` (担当: ${assignees.join("、")})` : ""}`}>
              <span className="wf-kind">作業</span>
              <span className="wf-name">{nameOf(a)}</span>
              {assignees.length > 0 && <span className="wf-assignees">担当: {assignees.join("、")}</span>}
            </Pick>
          </li>
        );
      })}
    </ul>
  );
}
