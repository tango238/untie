import { useEffect, useRef, useState } from "react";
import { setDatabaseDesign, setDatabaseDsl } from "@untie/core/model/commands";
import { addScaffold } from "@untie/core/model/designData";
import { LIMITS } from "@untie/core/model/limits";
import { parsePrismaDslCached } from "@untie/core/model/prismaCache";
import type { Database } from "@untie/core/model/types";
import { useAgentStore } from "../../ai/agentStore";
import { generateDatabaseDesign } from "../../ai/designData";
import { describeChatError } from "../../ai/chat";
import { getApiKey } from "../../ai/keys";
import { PROVIDERS } from "../../ai/providers";
import { selectReadOnly, useUntieStore } from "../../store";
import { ConfirmDialog } from "../ConfirmDialog";
import { DataDiagram } from "./DataDiagram";
import { useDataSelection } from "./dataSelection";

/** データボードの中央の見せ方: 図 (ER 図) かテキスト (DSL)。端末ごとに覚える */
export type DataView = "diagram" | "text";
const DATA_VIEW_KEY = "untie.design.dataView";

function loadDataView(): DataView {
  try {
    return localStorage.getItem(DATA_VIEW_KEY) === "text" ? "text" : "diagram";
  } catch {
    return "diagram";
  }
}

function saveDataView(view: DataView) {
  try {
    localStorage.setItem(DATA_VIEW_KEY, view);
  } catch {
    // 覚えられなくても切り替えはできる
  }
}

/** 解析エラーの一覧に出す件数 (多すぎると描画が重くなる) */
const MAX_SHOWN_ERRORS = 100;

/**
 * 設計モードのデータボードの中央: 選んだデータベースの DSL (Prisma の一部) を、図 (ER 図) かテキストで編集する。
 * どちらも同じ DSL を書き換えるので、いつでも行き来できる (テキストの書きかけは、図へ移るときに確定する)
 */
export function DslEditor() {
  const { database } = useDataSelection();
  const model = useUntieStore((s) => s.model);
  const dbCount = model.databases.length;
  if (!database) {
    return (
      <section className="dsl-editor" aria-label="DSL の編集">
        <p className="hint">
          {dbCount === 0 ? "左の「＋データベース」でデータベースを足すと、ここに DSL を書けます。" : "左のデータベースを選ぶと、ここに DSL が出ます。"}
        </p>
      </section>
    );
  }
  return <DslEditorFor key={database.id} database={database} />;
}

function DslEditorFor({ database }: { database: Database }) {
  const systemId = useUntieStore((s) => s.ui.designSystemId);
  const readOnly = useUntieStore(selectReadOnly);
  const dispatch = useUntieStore((s) => s.dispatch);
  const pushToast = useUntieStore((s) => s.pushToast);
  const provider = useAgentStore((s) => s.settings.provider);
  const aiModels = useAgentStore((s) => s.settings.models);
  const settingsOpen = useAgentStore((s) => s.settingsOpen);
  const setSettingsOpen = useAgentStore((s) => s.setSettingsOpen);

  const [view, setView] = useState<DataView>(loadDataView);
  // 入力中の下書き。null のあいだは外の値に追従し、同時編集の更新で書きかけを壊さない
  const [draft, setDraft] = useState<string | null>(null);
  const draftRef = useRef<string | null>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const [hasKey, setHasKey] = useState<boolean | undefined>(undefined);
  const [confirmAi, setConfirmAi] = useState(false);
  const [generating, setGenerating] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  // マウントした文書の世代。別のファイルを開いたあとに、前のファイルの下書きを同じ id のデータベースへ書かないために覚える
  const docSeq = useRef(useUntieStore.getState().docSeq);

  const value = draft ?? database.dsl;
  const schema = parsePrismaDslCached(value);

  const updateDraft = (v: string | null) => {
    draftRef.current = v;
    setDraft(v);
  };

  /** 下書きを確定する。失敗したら下書きを残す */
  const commit = () => {
    const text = draftRef.current;
    if (text === null) return;
    if (text === useUntieStore.getState().model.databases.find((d) => d.id === database.id)?.dsl) {
      updateDraft(null);
      return;
    }
    const r = dispatch((m) => setDatabaseDsl(m, { id: database.id, dsl: text }));
    if (r.ok) updateDraft(null);
    else pushToast(r.reason, "error");
  };
  const commitRef = useRef(commit);
  commitRef.current = commit;
  // 画面を離れる (別のデータベースを選ぶ・ボードを変える) ときは、書きかけを確定する
  useEffect(
    () => () => {
      if (useUntieStore.getState().docSeq === docSeq.current) commitRef.current();
    },
    [],
  );

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
  useEffect(() => () => abortRef.current?.abort(), []);

  const jumpTo = (line: number, column: number) => {
    const area = areaRef.current;
    if (!area) return;
    const lines = value.split(/\r\n|\r|\n/);
    let offset = 0;
    for (let i = 0; i < line - 1 && i < lines.length; i++) offset += lines[i]!.length + 1;
    offset = Math.min(value.length, offset + Math.max(0, column - 1));
    area.focus();
    area.setSelectionRange(offset, offset);
    const lineHeight = parseFloat(getComputedStyle(area).lineHeight) || 18;
    area.scrollTop = Math.max(0, (line - 1) * lineHeight - area.clientHeight / 2);
  };

  const scaffold = () => {
    if (!systemId) return;
    commit();
    const r = dispatch((m) => addScaffold(m, systemId, database.id));
    if (!r.ok) pushToast(r.reason, "error");
    else if (r.added === 0) pushToast("まだテーブルに対応していない情報はありません", "info");
    else pushToast(`${r.added} 件の雛形を足しました。model の名前を直してください`, "info");
  };

  const generate = async () => {
    if (!systemId) return;
    commit();
    const st = useUntieStore.getState();
    const db = st.model.databases.find((d) => d.id === database.id);
    if (!db) return;
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
      const result = await generateDatabaseDesign(st.model, systemId, db, {
        provider,
        model: aiModels[provider] || PROVIDERS[provider].defaultModel,
        apiKey,
        signal: controller.signal,
      });
      // 生成のあいだに別の文書を開いていたら、結果は捨てる
      if (useUntieStore.getState().docSeq !== docSeq.current) return;
      const r = useUntieStore.getState().dispatch((m) => setDatabaseDesign(m, { id: database.id, dsl: result.dsl, tables: result.tables }));
      if (!r.ok) pushToast(r.reason, "error");
      else {
        const notes = [
          result.errors.length > 0 ? `DSL に解析エラーが ${result.errors.length} 件残っています` : "",
          result.dropped > 0 ? `存在しない情報やテーブルの対応 ${result.dropped} 件は捨てました` : "",
        ].filter(Boolean);
        pushToast(`情報から DSL と対応を作りました${notes.length > 0 ? `。${notes.join("。")}` : ""}`, notes.length > 0 ? "error" : "info");
      }
    } catch (e) {
      pushToast(describeChatError(e), "error");
    } finally {
      abortRef.current = null;
      setGenerating(false);
    }
  };

  const requestGenerate = () => {
    if (database.dsl.trim() !== "" || draftRef.current?.trim()) setConfirmAi(true);
    else void generate();
  };

  const switchView = (next: DataView) => {
    if (next === view) return;
    if (next === "diagram") {
      commit();
      // 確定できなかった (長すぎるなど) ときは、書きかけを失わないようテキストのままにする
      if (draftRef.current !== null) return;
    }
    setView(next);
    saveDataView(next);
  };

  const aiDisabled = readOnly || !systemId || generating || hasKey !== true;

  return (
    <section className="dsl-editor" aria-label="DSL の編集">
      <div className="dsl-toolbar">
        <h2 className="dsl-title">{database.name || "(名前なし)"}</h2>
        <div className="segmented" role="group" aria-label="見せ方">
          {(
            [
              ["diagram", "図"],
              ["text", "テキスト"],
            ] as const
          ).map(([v, label]) => (
            <button key={v} type="button" className={view === v ? "is-active" : undefined} aria-pressed={view === v} onClick={() => switchView(v)}>
              {label}
            </button>
          ))}
        </div>
        <button
          type="button"
          disabled={aiDisabled}
          title={hasKey === false ? "「AI の設定」で API キーを入れると使えます" : "対象システムが使う情報から、DSL と対応を作る"}
          onClick={requestGenerate}
        >
          {generating ? "作っています…" : "情報から作る (AI)"}
        </button>
        <button type="button" disabled={readOnly || !systemId} title="まだテーブルに対応していない情報の model の雛形を末尾に足す" onClick={scaffold}>
          雛形を足す
        </button>
      </div>
      {hasKey === false && !readOnly && (
        <p className="hint dsl-key-hint">
          「情報から作る (AI)」を使うには、
          <button type="button" className="link" onClick={() => setSettingsOpen(true)}>
            AI の設定
          </button>
          で {PROVIDERS[provider].label} の API キーを入れてください。
        </p>
      )}
      {view === "diagram" ? (
        <DataDiagram database={database} readOnly={readOnly || generating} />
      ) : (
        <>
          <textarea
            ref={areaRef}
            className="dsl-textarea"
            aria-label="DSL"
            spellCheck={false}
            value={value}
            readOnly={readOnly || generating}
            maxLength={LIMITS.dsl.max}
            placeholder={"Prisma のスキーマの一部を書きます。例:\nmodel Reservation {\n  id   String @id\n  name String\n}"}
            onChange={(e) => updateDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
                e.preventDefault();
                commit();
              }
            }}
          />
          <div className="dsl-status" aria-label="DSL の解析結果">
            {schema.errors.length === 0 ? (
              <p className="hint">{value.trim() === "" ? "DSL が空です" : `エラーなし (model ${schema.models.length}、enum ${schema.enums.length})`}</p>
            ) : (
              <>
                <p className="hint is-error">解析エラー {schema.errors.length} 件</p>
                <ul className="dsl-errors">
                  {schema.errors.slice(0, MAX_SHOWN_ERRORS).map((e, i) => (
                    <li key={i}>
                      <button type="button" className="link" onClick={() => jumpTo(e.line, e.column)}>
                        {e.line}:{e.column}
                      </button>{" "}
                      {e.message}
                    </li>
                  ))}
                  {schema.errors.length > MAX_SHOWN_ERRORS && <li className="hint-inline">ほか {schema.errors.length - MAX_SHOWN_ERRORS} 件</li>}
                </ul>
              </>
            )}
          </div>
        </>
      )}
      {confirmAi && (
        <ConfirmDialog
          title="DSL と対応を置き換える"
          message="今の DSL と、テーブルと情報の対応を、AI が作ったものに置き換えます。"
          confirmLabel="置き換える"
          danger
          onConfirm={() => {
            setConfirmAi(false);
            void generate();
          }}
          onCancel={() => setConfirmAi(false)}
        />
      )}
    </section>
  );
}
