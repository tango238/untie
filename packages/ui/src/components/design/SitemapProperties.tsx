import { useMemo } from "react";
import { addTransition, removeTransition, updateTransition } from "@untie/core/model/commands";
import { designBoardId } from "@untie/core/model/design";
import { TRANSITION_VIAS, TRANSITION_VIA_LABELS, designScreenName } from "@untie/core/model/sitemap";
import { LIMITS } from "@untie/core/model/limits";
import type { DesignScreen, SystemDesign, Transition, UntieModel } from "@untie/core/model/types";
import { selectReadOnly, useUntieStore } from "../../store";
import { revealOnFixedBoard } from "../actions";
import { CommitField } from "../CommitField";
import { cachedEntryNotes } from "./entryNotesCache";
import { useSitemapEdit } from "./useSitemapEdit";

/** 右のペイン (設計モードのサイトマップ): 選んだ画面の内容と、出ていく・入ってくる遷移 */
export function SitemapProperties() {
  const model = useUntieStore((s) => s.model);
  const systemId = useUntieStore((s) => s.ui.designSystemId);
  const screenId = useUntieStore((s) => s.ui.designScreenId);
  const design = model.designs.find((d) => d.systemId === systemId);
  const screen = design?.screens.find((s) => s.id === screenId);
  return (
    <aside className="property-panel" aria-label="プロパティ">
      <h2 className="panel-title">プロパティ</h2>
      {design && systemId && screen ? (
        <ScreenEditor key={screen.id} model={model} systemId={systemId} design={design} screen={screen} />
      ) : (
        <p className="hint">サイトマップの画面を選ぶと、ここに内容が出ます</p>
      )}
    </aside>
  );
}

function ScreenEditor({ model, systemId, design, screen }: { model: UntieModel; systemId: string; design: SystemDesign; screen: DesignScreen }) {
  const readOnly = useUntieStore(selectReadOnly);
  const highlighted = useUntieStore((s) => s.ui.designTransitionId);
  const dispatch = useUntieStore((s) => s.dispatch);
  const pushToast = useUntieStore((s) => s.pushToast);
  const selectDesignScreen = useUntieStore((s) => s.selectDesignScreen);
  const setCurrentBoard = useUntieStore((s) => s.setCurrentBoard);
  const { remove, dialog } = useSitemapEdit();

  const name = designScreenName(model, screen);
  const analysis = screen.source.kind === "screen" ? model.elements.find((e) => e.id === (screen.source as { screenId: string }).screenId) : undefined;
  const nameOf = (id: string) => {
    const ds = design.screens.find((s) => s.id === id);
    return ds ? designScreenName(model, ds) : id;
  };

  // この画面を使う操作 (作業名つき) と、この画面が使う情報
  const { usecases, informations } = useMemo(() => {
    if (!analysis) return { usecases: [], informations: [] };
    const byId = new Map(model.elements.map((e) => [e.id, e]));
    const usecases = model.relations
      .filter((r) => r.kind === "usecaseScreen" && r.targetId === analysis.id)
      .map((r) => {
        const acts = model.relations
          .filter((a) => a.kind === "activityUsecase" && a.targetId === r.sourceId)
          .map((a) => byId.get(a.sourceId)?.name || "(名前なし)");
        return { id: r.sourceId, name: byId.get(r.sourceId)?.name || "(名前なし)", activities: acts };
      });
    const informations = model.relations
      .filter((r) => r.kind === "screenInformation" && r.sourceId === analysis.id)
      .map((r) => byId.get(r.targetId)?.name || "(名前なし)");
    return { usecases, informations };
  }, [model, analysis]);

  const notes = cachedEntryNotes(model, systemId, design).get(screen.id);
  const outgoing = design.transitions.filter((t) => t.from === screen.id);
  const incoming = design.transitions.filter((t) => t.to === screen.id);
  const addable = design.screens.filter((s) => s.id !== screen.id && !outgoing.some((t) => t.to === s.id));

  const run = (command: Parameters<typeof dispatch>[0]) => {
    const r = dispatch(command);
    if (!r.ok) pushToast(r.reason, "error");
  };
  const setVia = (t: Transition, value: string) =>
    run((m) => updateTransition(m, { systemId, id: t.id, patch: { via: value === "" ? null : (value as NonNullable<Transition["via"]>) } }));

  return (
    <div className="editor" data-testid="sitemap-properties">
      <div className="kind-line">{screen.source.kind === "builtin" ? "組み込みの画面" : "画面"}</div>
      <div className="field">
        <span className="field-label">名前</span>
        <div className="static-value">{name}</div>
        {analysis && (
          <button type="button" className="link" onClick={() => revealOnFixedBoard(analysis.id)}>
            分析の画面ボードで見る
          </button>
        )}
      </div>
      {analysis?.kind === "screen" && analysis.description && (
        <div className="field">
          <span className="field-label">説明</span>
          <div className="static-value sitemap-description">{analysis.description}</div>
        </div>
      )}
      {analysis && (
        <div className="field">
          <span className="field-label">この画面を使う操作</span>
          {usecases.length === 0 ? (
            <div className="hint-inline">なし</div>
          ) : (
            <ul className="plain-list">
              {usecases.map((u) => (
                <li key={u.id}>
                  {u.name}
                  {u.activities.length > 0 && <small className="hint-inline"> ({u.activities.join("、")})</small>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {analysis && (
        <div className="field">
          <span className="field-label">この画面が使う情報</span>
          {informations.length === 0 ? (
            <div className="hint-inline">なし</div>
          ) : (
            <ul className="plain-list">
              {informations.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {notes && (
        <div className="field" data-testid="sitemap-entry-notes">
          <span className="field-label">入口の画面</span>
          {notes.length === 0 ? (
            <div className="hint-inline">ほかの画面から入ってくる遷移がありません</div>
          ) : (
            <ul className="plain-list">
              {notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="field">
        <span className="field-label">出ていく遷移</span>
        {outgoing.length === 0 ? (
          <div className="hint-inline">なし</div>
        ) : (
          <ul className="transition-list">
            {outgoing.map((t) => (
              <li key={t.id} className={t.id === highlighted ? "is-highlight" : undefined} data-transition={t.id}>
                <div className="transition-row">
                  <span className="transition-target">{nameOf(t.to)}</span>
                  <select aria-label={`${nameOf(t.to)} へのきっかけ`} value={t.via ?? ""} disabled={readOnly} onChange={(e) => setVia(t, e.target.value)}>
                    <option value="">未定</option>
                    {TRANSITION_VIAS.map((v) => (
                      <option key={v} value={v}>
                        {TRANSITION_VIA_LABELS[v]}
                      </option>
                    ))}
                  </select>
                  <button type="button" aria-label={`${nameOf(t.to)} への遷移を削除`} title="遷移を削除" disabled={readOnly} onClick={() => run((m) => removeTransition(m, { systemId, id: t.id }))}>
                    ×
                  </button>
                </div>
                <CommitField
                  label={`${nameOf(t.to)} への文言`}
                  value={t.label ?? ""}
                  maxLength={LIMITS.transitionLabel.max}
                  readOnly={readOnly}
                  placeholder="ボタンやリンクの文言"
                  onCommit={(v) => run((m) => updateTransition(m, { systemId, id: t.id, patch: { label: v } }))}
                />
              </li>
            ))}
          </ul>
        )}
        {!readOnly && (
          <select
            aria-label="遷移を追加"
            value=""
            onChange={(e) => {
              const to = e.target.value;
              if (to) run((m) => addTransition(m, { systemId, from: screen.id, to }));
            }}
          >
            <option value="">遷移を追加…</option>
            {addable.map((s) => (
              <option key={s.id} value={s.id}>
                {designScreenName(model, s)}
              </option>
            ))}
          </select>
        )}
      </div>

      <div className="field">
        <span className="field-label">入ってくる遷移</span>
        {incoming.length === 0 ? (
          <div className="hint-inline">なし</div>
        ) : (
          <ul className="plain-list">
            {incoming.map((t) => (
              <li key={t.id}>
                <button type="button" className="link" onClick={() => selectDesignScreen(t.from)}>
                  {nameOf(t.from)}
                </button>
                <small className="hint-inline"> {t.via ? TRANSITION_VIA_LABELS[t.via] : "未定"}</small>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="sitemap-actions">
        <button type="button" onClick={() => setCurrentBoard(designBoardId("screen"))}>
          画面ボードで開く
        </button>
        <button type="button" className="danger-outline" disabled={readOnly} onClick={() => remove([screen.id])}>
          サイトマップから外す
        </button>
      </div>
      {dialog}
    </div>
  );
}
