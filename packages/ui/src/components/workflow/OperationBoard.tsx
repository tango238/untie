import { useMemo } from "react";
import { addOperationElement, buildOperationBoard, systemsForScreens, type OperationBox, type OperationFrame, type OperationRow } from "@untie/core/model/operationBoard";
import { canAddActivityToBusiness, addWorkflowElement, SIMPLE_BOARD_LABELS } from "@untie/core/model/workflow";
import { ALTERNATE_WHEN_LABELS, INFORMATION_ACCESS_BOTH_LABEL, INFORMATION_ACCESS_LABELS, type Activity, type Condition, type Information, type InformationAccess, type RelationAlternate, type UntieModel } from "@untie/core/model/types";
import { useBoardKit } from "./boardKit";
import { nameOf, Pick } from "./WorkflowBoard";

/**
 * 分析（簡易）のボード「システム操作」。作業 → 操作 → 画面・情報 を 1 枚で書く。
 * 作業は、1 つ上の概念 (活動、無ければ業務) の枠で囲む。配置は保存せず、毎回モデルから組み立てる (core の buildOperationBoard)。
 */
export function OperationBoard() {
  const { model, readOnly, selectedId, choose, run } = useBoardKit();
  const board = useMemo(() => buildOperationBoard(model), [model]);

  const ctx: Ctx = {
    model,
    readOnly,
    selectedId,
    systems: systemsForScreens(model).map((s) => ({ id: s.id, name: nameOf(s) })),
    choose,
    addActivity: (parentId) => run((m) => addWorkflowElement(m, "activity", parentId)),
    addOperation: (activityId) => run((m) => addOperationElement(m, "usecase", activityId)),
    addCondition: (usecaseId) => run((m) => addOperationElement(m, "condition", usecaseId)),
    addInformation: (usecaseId) => run((m) => addOperationElement(m, "information", usecaseId)),
    addScreen: (usecaseId, systemId) => run((m) => addOperationElement(m, "screen", usecaseId, systemId ? { systemId } : {})),
  };
  const empty = board.frames.length === 0 && board.unlinkedOperations.length === 0 && board.unlinkedScreens.length === 0 && board.unlinkedInformations.length === 0 && board.unlinkedConditions.length === 0;

  return (
    <div className="fixed-board workflow-board" data-testid="operation-board">
      <div className="fixed-head">
        <h2 className="fixed-title">{SIMPLE_BOARD_LABELS.operation}</h2>
        <span className="fixed-hint">
          作業ごとに、使う操作と、操作が使う画面・扱う情報・判断する条件を並べます。作業は、活動 (活動の無い業務では業務) の枠で囲みます。選ぶと右のプロパティで関連や削除を直せます。
        </span>
      </div>
      {!readOnly && ctx.systems.length === 0 && <p className="hint">画面は、画面の持ち主になるシステム (例: 宿泊管理システム) に属します。画面を足すには、先に分析（詳細）の「登場人物」でシステムを作ってください。</p>}
      {empty && <p className="hint">まだ作業がありません。「ワークフロー」のボードで業務と作業を書くと、ここに出ます。</p>}
      <div className="wf-outers">
        {board.frames.map((f) => (
          <OuterFrame key={f.key} frame={f} ctx={ctx} />
        ))}
      </div>
      {board.unlinkedOperations.length > 0 && (
        <section className="wf-section" aria-label="作業に結ばれていない操作">
          <h3 className="wf-section-title">作業に結ばれていない操作</h3>
          <p className="fixed-hint">イベントをきっかけにした操作などです。操作を選び、プロパティの「関係を追加」で作業に結ぶと、作業の行に移ります。</p>
          <ul className="wf-businesses is-flat">
            {board.unlinkedOperations.map((b) => (
              <li key={b.usecase.id}>
                <OperationFrameView box={b} ctx={ctx} />
              </li>
            ))}
          </ul>
        </section>
      )}
      {board.unlinkedConditions.length > 0 && (
        <section className="wf-section" aria-label="操作に結ばれていない条件">
          <h3 className="wf-section-title">操作に結ばれていない条件</h3>
          <p className="fixed-hint">条件を選び、プロパティの「関係を追加」で判断する操作に結ぶと、操作の枠に移ります。</p>
          <ul className="wf-stack">
            {board.unlinkedConditions.map((c) => (
              <li key={c.id} data-workflow-el={c.id}>
                <ConditionRow condition={c} ctx={ctx} />
              </li>
            ))}
          </ul>
        </section>
      )}
      {board.unlinkedInformations.length > 0 && (
        <section className="wf-section" aria-label="操作に結ばれていない情報">
          <h3 className="wf-section-title">操作に結ばれていない情報</h3>
          <p className="fixed-hint">情報を選び、プロパティの「関係を追加」で扱う操作に結ぶと、操作の枠に移ります。</p>
          <ul className="wf-stack">
            {board.unlinkedInformations.map((i) => (
              <li key={i.id} data-workflow-el={i.id}>
                <InformationRow information={i} ctx={ctx} />
              </li>
            ))}
          </ul>
        </section>
      )}
      {board.unlinkedScreens.length > 0 && (
        <section className="wf-section" aria-label="操作に結ばれていない画面">
          <h3 className="wf-section-title">操作に結ばれていない画面</h3>
          <p className="fixed-hint">画面を選び、プロパティの「使う操作」で操作を決めると、操作の枠に移ります。</p>
          <ul className="wf-stack">
            {board.unlinkedScreens.map((s) => (
              <li key={s.id} data-workflow-el={s.id}>
                <ScreenRow screen={s} ctx={ctx} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

interface Ctx {
  model: UntieModel;
  readOnly: boolean;
  selectedId: string | null;
  systems: { id: string; name: string }[];
  choose: (id: string) => void;
  addActivity: (parentId: string) => void;
  addOperation: (activityId: string) => void;
  addScreen: (usecaseId: string, systemId?: string) => void;
  addInformation: (usecaseId: string) => void;
  addCondition: (usecaseId: string) => void;
}

const FRAME_KIND_LABEL = { buc: "活動", business: "業務", none: "" } as const;

function OuterFrame({ frame, ctx }: { frame: OperationFrame; ctx: Ctx }) {
  const el = frame.element;
  const label = frame.kind === "none" ? "業務に属さない作業" : `${FRAME_KIND_LABEL[frame.kind]} ${nameOf(el!)}`;
  const canAdd = !ctx.readOnly && el !== null && (frame.kind === "buc" || canAddActivityToBusiness(ctx.model, el.id));
  return (
    <section
      className={`wf-frame wf-outer ${frame.kind === "buc" ? "wf-buc" : "wf-business"}${el && ctx.selectedId === el.id ? " is-selected" : ""}`}
      aria-label={label}
      data-workflow-el={el?.id}
      onClick={() => el && ctx.choose(el.id)}
    >
      <header className="wf-frame-head">
        {el ? (
          <Pick id={el.id} className="wf-frame-title" ctx={ctx} label={label}>
            <span className="wf-kind">{FRAME_KIND_LABEL[frame.kind as "buc" | "business"]}{frame.business ? ` (業務: ${nameOf(frame.business)})` : ""}</span>
            <span className="wf-name">{nameOf(el)}</span>
          </Pick>
        ) : (
          <h3 className="wf-section-title">業務に属さない作業</h3>
        )}
      </header>
      {frame.rows.length === 0 && <p className="wf-note">作業はまだありません</p>}
      {frame.rows.map((row) => (
        <ActivityRow key={row.activity.id} row={row} ctx={ctx} />
      ))}
      {canAdd && (
        <div className="wf-actions">
          <button
            type="button"
            className="wf-add"
            aria-label={`「${nameOf(el!)}」に作業を足す`}
            onClick={(e) => {
              e.stopPropagation();
              ctx.addActivity(el!.id);
            }}
          >
            ＋作業
          </button>
        </div>
      )}
    </section>
  );
}

/** 作業のカードと、そこから右へ伸びる枝の先の操作の枠 */
function ActivityRow({ row, ctx }: { row: OperationRow; ctx: Ctx }) {
  const a: Activity = row.activity;
  return (
    <div className="wf-lane wf-row" aria-label={`作業 ${nameOf(a)} の行`} role="group">
      <div className="wf-actor" data-workflow-el={a.id}>
        <Pick id={a.id} className="wf-activity wf-actor-card" ctx={ctx} label={`作業 ${nameOf(a)}`}>
          <span className="wf-kind">作業</span>
          <span className="wf-name">{nameOf(a)}</span>
        </Pick>
        {!ctx.readOnly && (
          <button
            type="button"
            className="wf-add"
            aria-label={`「${nameOf(a)}」に操作を足す`}
            onClick={(e) => {
              e.stopPropagation();
              ctx.addOperation(a.id);
            }}
          >
            ＋操作
          </button>
        )}
        {row.operations.length === 0 && <span className="wf-note">操作はまだありません</span>}
      </div>
      {row.operations.length > 0 && (
        <>
          <div className="wf-trunk" aria-hidden="true" />
          <ul className="wf-businesses">
            {row.operations.map((b) => (
              <li key={b.usecase.id} className="wf-branch-item">
                <OperationFrameView box={b} ctx={ctx} />
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function OperationFrameView({ box, ctx }: { box: OperationBox; ctx: Ctx }) {
  const u = box.usecase;
  // 画面を足せるのは、対象 (システム・帳票・画面) が無く、画面を足すシステムがある操作 (コマンドも同じ決まりで確かめる)
  const canAddScreen = !ctx.readOnly && ctx.systems.length > 0 && box.screens.length === 0 && box.targets.length === 0;
  return (
    <section
      className={`wf-frame wf-operation${ctx.selectedId === u.id ? " is-selected" : ""}`}
      aria-label={`操作 ${nameOf(u)}`}
      data-workflow-el={u.id}
      onClick={(e) => {
        e.stopPropagation();
        ctx.choose(u.id);
      }}
    >
      <header className="wf-frame-head">
        <Pick id={u.id} className="wf-frame-title" ctx={ctx} label={`操作 ${nameOf(u)}`}>
          <span className="wf-kind">操作</span>
          <span className="wf-name">{nameOf(u)}</span>
        </Pick>
      </header>
      {box.triggers.length > 0 && <EventChips label="きっかけ" events={box.triggers} ctx={ctx} />}
      {box.screens.length > 0 && (
        <ul className="wf-stack" aria-label="画面の一覧">
          {box.screens.map((s) => (
            <li key={s.id} data-workflow-el={s.id}>
              <ScreenRow screen={s} ctx={ctx} />
            </li>
          ))}
        </ul>
      )}
      {box.targets.length > 0 && (
        <ul className="wf-chips" aria-label="対象">
          {box.targets.map((t) => (
            <li key={t.id} data-workflow-el={t.id}>
              <Pick id={t.id} className={`wf-chip kind-${t.kind}`} ctx={ctx} label={`${t.kind === "system" ? "システム" : "帳票"} ${nameOf(t)}`}>
                <span className="wf-kind">{t.kind === "system" ? "システム" : "帳票"}</span> {nameOf(t)}
              </Pick>
            </li>
          ))}
        </ul>
      )}
      {box.informations.length > 0 && (
        <ul className="wf-stack" aria-label="情報の一覧">
          {box.informations.map((x) => (
            <li key={x.information.id} data-workflow-el={x.information.id}>
              <InformationRow information={x.information} access={x.access} linked ctx={ctx} />
            </li>
          ))}
        </ul>
      )}
      {box.conditions.length > 0 && (
        <ul className="wf-stack" aria-label="条件の一覧">
          {box.conditions.map((x) => (
            <li key={x.condition.id} data-workflow-el={x.condition.id}>
              <ConditionRow condition={x.condition} alternate={x.alternate} linked ctx={ctx} />
            </li>
          ))}
        </ul>
      )}
      {box.emits.length > 0 && <EventChips label="発生" events={box.emits} ctx={ctx} />}
      {!ctx.readOnly && (
        <div className="wf-actions" onClick={(e) => e.stopPropagation()}>
          <button type="button" className="wf-add" aria-label={`「${nameOf(u)}」に情報を足す`} onClick={() => ctx.addInformation(u.id)}>
            ＋情報
          </button>
        </div>
      )}
      {!ctx.readOnly && (
        <div className="wf-actions" onClick={(e) => e.stopPropagation()}>
          <button type="button" className="wf-add" aria-label={`「${nameOf(u)}」に条件を足す`} onClick={() => ctx.addCondition(u.id)}>
            ＋条件
          </button>
        </div>
      )}
      {canAddScreen && <AddScreen usecaseId={u.id} nameLabel={nameOf(u)} ctx={ctx} />}
    </section>
  );
}

function EventChips({ label, events, ctx }: { label: string; events: { id: string; name: string }[]; ctx: Ctx }) {
  return (
    <ul className="wf-chips" aria-label={`${label}のイベント`}>
      {events.map((e) => (
        <li key={e.id} data-workflow-el={e.id}>
          <Pick id={e.id} className="wf-chip kind-event" ctx={ctx} label={`${label}のイベント ${nameOf(e)}`}>
            <span className="wf-kind">{label}</span> {nameOf(e)}
          </Pick>
        </li>
      ))}
    </ul>
  );
}

function ScreenRow({ screen, ctx }: { screen: { id: string; name: string; systemId: string }; ctx: Ctx }) {
  const system = ctx.model.elements.find((e) => e.id === screen.systemId);
  return (
    <Pick id={screen.id} className="wf-screen" ctx={ctx} label={`画面 ${nameOf(screen)}${system ? ` (システム: ${nameOf(system)})` : ""}`}>
      <span className="wf-kind">画面</span>
      <span className="wf-name">{nameOf(screen)}</span>
      {system && <span className="wf-assignees">システム: {nameOf(system)}</span>}
    </Pick>
  );
}

/** 条件の行。操作が判断する条件には、代替パターンがあるかを添える (長い文は出さない。中身はプロパティで見る) */
function ConditionRow({ condition, alternate, linked = false, ctx }: { condition: Condition; alternate?: RelationAlternate; linked?: boolean; ctx: Ctx }) {
  const note = linked && alternate ? `代替パターンあり: ${ALTERNATE_WHEN_LABELS[alternate.when]}` : "";
  return (
    <Pick id={condition.id} className="wf-condition" ctx={ctx} label={`条件 ${nameOf(condition)}${note ? ` (${note})` : ""}`}>
      <span className="wf-kind">条件</span>
      <span className="wf-name">{nameOf(condition)}</span>
      {note && <span className="wf-assignees">{note}</span>}
    </Pick>
  );
}

/** 情報の行。操作が扱う情報には、取得・保存の区別を添える */
function InformationRow({ information, access, linked = false, ctx }: { information: Information; access?: InformationAccess; linked?: boolean; ctx: Ctx }) {
  return (
    <Pick id={information.id} className="wf-information" ctx={ctx} label={`情報 ${nameOf(information)}${linked ? ` (${access ? INFORMATION_ACCESS_LABELS[access] : INFORMATION_ACCESS_BOTH_LABEL})` : ""}`}>
      <span className="wf-kind">情報</span>
      <span className="wf-name">{nameOf(information)}</span>
      {linked && <span className="wf-assignees">{access ? INFORMATION_ACCESS_LABELS[access] : INFORMATION_ACCESS_BOTH_LABEL}</span>}
    </Pick>
  );
}

/** 「＋画面」。システムが 1 つなら押すだけ、複数なら足すシステムを選ぶ */
function AddScreen({ usecaseId, nameLabel, ctx }: { usecaseId: string; nameLabel: string; ctx: Ctx }) {
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  if (ctx.systems.length === 1) {
    return (
      <div className="wf-actions" onClick={stop}>
        <button type="button" className="wf-add" aria-label={`「${nameLabel}」に画面を足す`} onClick={() => ctx.addScreen(usecaseId)}>
          ＋画面
        </button>
      </div>
    );
  }
  return (
    <div className="wf-actions" onClick={stop}>
      <select
        className="wf-add"
        aria-label={`「${nameLabel}」に画面を足す`}
        value=""
        onChange={(e) => {
          if (e.target.value) ctx.addScreen(usecaseId, e.target.value);
        }}
      >
        <option value="">＋画面 (属するシステムを選ぶ)</option>
        {ctx.systems.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
    </div>
  );
}
