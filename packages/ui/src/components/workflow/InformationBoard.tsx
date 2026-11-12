import { useMemo } from "react";
import { addInformationBoardElement, buildInformationBoard, type ContextFrame, type InformationRow, type StateGroupBox } from "@untie/core/model/informationBoard";
import { SIMPLE_BOARD_LABELS } from "@untie/core/model/workflow";
import type { State, Variation } from "@untie/core/model/types";
import { useBoardKit } from "./boardKit";
import { nameOf, Pick } from "./WorkflowBoard";

/** バリエーションの値の要約 (長くなりすぎないよう先頭の数個だけ) */
const valuesSummary = (v: Variation) => (v.values.length === 0 ? "値はまだありません" : `値: ${v.values.slice(0, 3).join("、")}${v.values.length > 3 ? " ほか" : ""}`);

/**
 * 分析（簡易）のボード「情報と状態」。コンテキスト → 情報 (・バリエーション)・状態 を 1 枚で書く。
 * 配置は保存せず、毎回モデルから組み立てる (core の buildInformationBoard)。条件は出さない (システム操作ボードで見る)。
 */
export function InformationBoard() {
  const { model, readOnly, selectedId, choose, run } = useBoardKit();
  const board = useMemo(() => buildInformationBoard(model), [model]);
  const ctx: Ctx = {
    readOnly,
    selectedId,
    choose,
    addInformation: (contextId) => run((m) => addInformationBoardElement(m, "information", contextId)),
    addState: (contextId, group) => run((m) => addInformationBoardElement(m, "state", contextId, group ? { group } : {})),
    addVariation: (informationId) => run((m) => addInformationBoardElement(m, "variation", informationId)),
  };

  return (
    <div className="fixed-board workflow-board" data-testid="information-board">
      <div className="fixed-head">
        <h2 className="fixed-title">{SIMPLE_BOARD_LABELS.information}</h2>
        <span className="fixed-hint">
          コンテキスト (役割の同じ情報と、その状態・バリエーションのまとまり) ごとに、情報と、情報の種別のバリエーション、状態 (状態グループごと) を並べます。条件は「システム操作」のボードに出ます。新しい状態グループは、状態を選び、プロパティの「状態グループ」にグループ名を打って作ります。選ぶと右のプロパティで関連や削除を直せます。
        </span>
        {!readOnly && (
          <button type="button" className="fixed-head-add" aria-label="コンテキストを足す" onClick={() => run((m) => addInformationBoardElement(m, "context", null))}>
            ＋コンテキスト
          </button>
        )}
      </div>
      {board.frames.length === 0 && <p className="hint">まだ何もありません。「＋コンテキスト」から書き始めます。</p>}
      <div className="wf-outers">
        {board.frames.map((f) => (
          <ContextFrameView key={f.key} frame={f} ctx={ctx} />
        ))}
      </div>
    </div>
  );
}

interface Ctx {
  readOnly: boolean;
  selectedId: string | null;
  choose: (id: string) => void;
  addInformation: (contextId: string | null) => void;
  addState: (contextId: string | null, group?: string) => void;
  addVariation: (informationId: string) => void;
}

function ContextFrameView({ frame, ctx }: { frame: ContextFrame; ctx: Ctx }) {
  const c = frame.context;
  const label = c ? `コンテキスト ${nameOf(c)}` : "コンテキストが決まっていない";
  const contextId = c?.id ?? null;
  const addLabel = c ? `「${nameOf(c)}」` : "「コンテキストが決まっていない」枠";
  const empty = frame.rows.length === 0 && frame.stateGroups.length === 0 && frame.unlinkedVariations.length === 0;
  return (
    <section
      className={`wf-frame wf-outer wf-context${c && ctx.selectedId === c.id ? " is-selected" : ""}`}
      aria-label={label}
      data-workflow-el={c?.id}
      onClick={() => c && ctx.choose(c.id)}
    >
      <header className="wf-frame-head">
        {c ? (
          <Pick id={c.id} className="wf-frame-title" ctx={ctx} label={label}>
            <span className="wf-kind">コンテキスト</span>
            <span className="wf-name">{nameOf(c)}</span>
          </Pick>
        ) : (
          <h3 className="wf-section-title">コンテキストが決まっていない</h3>
        )}
      </header>
      {!c && <p className="fixed-hint">要素を選び、プロパティの「コンテキスト」で所属を決めると、コンテキストの枠に移ります。</p>}
      {empty && <p className="wf-note">情報・状態・バリエーションはまだありません</p>}
      {frame.rows.map((row) => (
        <InformationRowView key={row.information.id} row={row} ctx={ctx} />
      ))}
      {!ctx.readOnly && (
        <div className="wf-actions" onClick={(e) => e.stopPropagation()}>
          <button type="button" className="wf-add" aria-label={`${addLabel}に情報を足す`} onClick={() => ctx.addInformation(contextId)}>
            ＋情報
          </button>
        </div>
      )}
      {(frame.stateGroups.length > 0 || !ctx.readOnly) && (
        <section className="wf-subsection" aria-label={`${label}の状態`}>
          <h4 className="wf-subtitle">状態</h4>
          {frame.stateGroups.length === 0 && <p className="wf-note">状態はまだありません</p>}
          <div className="wf-state-groups">
            {frame.stateGroups.map((g) => (
              <StateGroupView key={g.key} box={g} contextId={contextId} ctx={ctx} />
            ))}
          </div>
          {!ctx.readOnly && frame.stateGroups.every((g) => g.group !== undefined) && (
            <div className="wf-actions" onClick={(e) => e.stopPropagation()}>
              <button type="button" className="wf-add" aria-label={`${addLabel}に状態を足す`} onClick={() => ctx.addState(contextId)}>
                ＋状態 (グループなし)
              </button>
            </div>
          )}
        </section>
      )}
      {frame.unlinkedVariations.length > 0 && (
        <section className="wf-subsection" aria-label={`${label}の情報に結ばれていないバリエーション`}>
          <h4 className="wf-subtitle">情報に結ばれていないバリエーション</h4>
          <ul className="wf-stack">
            {frame.unlinkedVariations.map((v) => (
              <li key={v.id} data-workflow-el={v.id}>
                <VariationRow variation={v} ctx={ctx} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </section>
  );
}

/** 情報のカードと、そこから右へ伸びる枝の先の、バリエーションの枠 */
function InformationRowView({ row, ctx }: { row: InformationRow; ctx: Ctx }) {
  const i = row.information;
  return (
    <div className="wf-lane wf-row" role="group" aria-label={`情報 ${nameOf(i)} の行`}>
      <div className="wf-actor" data-workflow-el={i.id}>
        <Pick id={i.id} className="wf-information wf-actor-card" ctx={ctx} label={`情報 ${nameOf(i)}${row.related.length > 0 ? ` (関連: ${row.related.map(nameOf).join("、")})` : ""}`}>
          <span className="wf-kind">情報</span>
          <span className="wf-name">{nameOf(i)}</span>
          {row.related.length > 0 && <span className="wf-assignees">関連: {row.related.map(nameOf).join("、")}</span>}
        </Pick>
        {!ctx.readOnly && (
          <button
            type="button"
            className="wf-add"
            aria-label={`「${nameOf(i)}」にバリエーションを足す`}
            onClick={(e) => {
              e.stopPropagation();
              ctx.addVariation(i.id);
            }}
          >
            ＋バリエーション
          </button>
        )}
        {row.variations.length === 0 && <span className="wf-note">バリエーションはまだありません</span>}
      </div>
      {row.variations.length > 0 && (
        <>
          <div className="wf-trunk" aria-hidden="true" />
          <ul className="wf-businesses">
            <li className="wf-branch-item">
              <section className="wf-frame wf-variation-frame" aria-label={`情報 ${nameOf(i)} のバリエーション`} onClick={(e) => e.stopPropagation()}>
                <header className="wf-frame-head">
                  <span className="wf-kind">バリエーション</span>
                </header>
                <ul className="wf-stack" aria-label="バリエーションの一覧">
                  {row.variations.map((v) => (
                    <li key={v.id} data-workflow-el={v.id}>
                      <VariationRow variation={v} ctx={ctx} />
                    </li>
                  ))}
                </ul>
              </section>
            </li>
          </ul>
        </>
      )}
    </div>
  );
}

function VariationRow({ variation, ctx }: { variation: Variation; ctx: Ctx }) {
  return (
    <Pick id={variation.id} className="wf-variation" ctx={ctx} label={`バリエーション ${nameOf(variation)} (${valuesSummary(variation)})`}>
      <span className="wf-kind">バリエーション</span>
      <span className="wf-name">{nameOf(variation)}</span>
      <span className="wf-assignees">{valuesSummary(variation)}</span>
    </Pick>
  );
}

function StateGroupView({ box, contextId, ctx }: { box: StateGroupBox; contextId: string | null; ctx: Ctx }) {
  const title = box.group ?? "グループなし";
  return (
    <section className="wf-frame wf-state-group" aria-label={`状態グループ ${title}`} onClick={(e) => e.stopPropagation()}>
      <header className="wf-frame-head">
        <span className="wf-kind">状態グループ</span>
        <span className="wf-name">{title}</span>
      </header>
      <ul className="wf-stack" aria-label="状態の一覧">
        {box.states.map((s) => (
          <li key={s.id} data-workflow-el={s.id}>
            <StateRow state={s} ctx={ctx} />
          </li>
        ))}
      </ul>
      {!ctx.readOnly && box.group !== undefined && (
        <div className="wf-actions">
          <button type="button" className="wf-add" aria-label={`状態グループ「${title}」に状態を足す`} onClick={() => ctx.addState(contextId, box.group)}>
            ＋状態
          </button>
        </div>
      )}
      {!ctx.readOnly && box.group === undefined && (
        <div className="wf-actions">
          <button type="button" className="wf-add" aria-label="グループなしに状態を足す" onClick={() => ctx.addState(contextId)}>
            ＋状態
          </button>
        </div>
      )}
    </section>
  );
}

function StateRow({ state, ctx }: { state: State; ctx: Ctx }) {
  return (
    <Pick id={state.id} className="wf-state" ctx={ctx} label={`状態 ${nameOf(state)}`}>
      <span className="wf-kind">状態</span>
      <span className="wf-name">{nameOf(state)}</span>
    </Pick>
  );
}
