import { useEffect, useMemo, useRef, useState } from "react";
import { clearDesignScreenView, setDesignScreenShell, setDesignScreenView } from "@untie/core/model/commands";
import { effectiveDatabaseIds } from "@untie/core/model/design";
import { LIMITS } from "@untie/core/model/limits";
import { usecaseIsReadOnly } from "@untie/core/model/placement";
import { parsePrismaDslCached } from "@untie/core/model/prismaCache";
import { designScreenName, SHELL_LABELS } from "@untie/core/model/sitemap";
import type { DesignScreen, SystemDesign, UntieModel } from "@untie/core/model/types";
import { useAgentStore } from "../../ai/agentStore";
import { describeChatError } from "../../ai/chat";
import { generateScreen } from "../../ai/designScreen";
import { getApiKey } from "../../ai/keys";
import { PROVIDERS } from "../../ai/providers";
import { selectReadOnly, useUntieStore } from "../../store";
import { CommitField } from "../CommitField";
import { ConfirmDialog } from "../ConfirmDialog";
import type { DbInfo } from "./BindingPicker";
import { ScreenConditionList, useScreenConditions } from "./ScreenConditionList";
import { ScreenFormEditor } from "./ScreenFormEditor";
import { ScreenYamlEditor } from "./ScreenYamlEditor";
import { pruneBindings, setOrDelete, str, type Binding, type Json } from "./screenForm";

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/** 設計が使うデータベースのテーブルと列 (列の対応の選択肢)。他のテーブルを指す関連の列は除く */
export function databaseInfos(model: UntieModel, design: SystemDesign): DbInfo[] {
  return effectiveDatabaseIds(model, design).flatMap((id) => {
    const db = model.databases.find((d) => d.id === id);
    if (!db) return [];
    const schema = parsePrismaDslCached(db.dsl);
    const modelNames = new Set(schema.models.map((m) => m.name));
    return [{ id: db.id, name: db.name, tables: schema.models.map((m) => ({ name: m.name, columns: m.fields.filter((f) => !modelNames.has(f.type)).map((f) => f.name) })) }];
  });
}

/**
 * 画面 UI の新規作成の中身: 目的と、セクション 1 つ。
 * 画面を使う操作が情報を読むだけ (問い合わせ) なら一覧、書く (コマンド) なら入力を既定にする
 */
export function newView(title: string, goal: string, readOnly = false): Json {
  if (readOnly) return { title, goal, sections: [{ id: "main", title: "一覧", kind: "list", list: { columns: [{ id: "name", label: "名前" }] } }] };
  return { title, goal, sections: [{ id: "main", title: "入力", kind: "form", fields: [] }] };
}

/** 画面を使う操作が、情報を読むだけか (扱う情報があり、すべて取得だけで、状態を変えず、出来事も起こさない) */
export function screenIsReadOnly(model: UntieModel, analysisScreenId: string | undefined): boolean {
  if (!analysisScreenId) return false;
  const usecases = [...new Set(model.relations.filter((r) => r.kind === "usecaseScreen" && r.targetId === analysisScreenId).map((r) => r.sourceId))];
  return usecases.length > 0 && usecases.every((id) => usecaseIsReadOnly(model, id));
}

/** 右のペイン (設計モードの画面ボード): 選んだ画面の画面 UI を、フォームか YAML で組み立てる。AI で作ることもできる */
export function ScreenBuilder() {
  const model = useUntieStore((s) => s.model);
  const systemId = useUntieStore((s) => s.ui.designSystemId);
  const screenId = useUntieStore((s) => s.ui.designScreenId);
  const design = model.designs.find((d) => d.systemId === systemId);
  const screen = design?.screens.find((s) => s.id === screenId);
  return (
    <aside className="property-panel screen-builder" aria-label="画面の組み立て">
      <h2 className="panel-title">画面の組み立て</h2>
      {systemId && design && screen ? <ScreenBuilderFor key={screen.id} model={model} systemId={systemId} design={design} screen={screen} /> : <p className="hint">左の一覧から画面を選ぶと、ここで画面 UI を組み立てられます</p>}
    </aside>
  );
}

function ScreenBuilderFor({ model, systemId, design, screen }: { model: UntieModel; systemId: string; design: SystemDesign; screen: DesignScreen }) {
  const readOnly = useUntieStore(selectReadOnly);
  const dispatch = useUntieStore((s) => s.dispatch);
  const pushToast = useUntieStore((s) => s.pushToast);
  const provider = useAgentStore((s) => s.settings.provider);
  const aiModels = useAgentStore((s) => s.settings.models);
  const settingsOpen = useAgentStore((s) => s.settingsOpen);
  const setSettingsOpen = useAgentStore((s) => s.setSettingsOpen);
  const [yaml, setYaml] = useState(false);
  const [hasKey, setHasKey] = useState<boolean | undefined>(undefined);
  const [generating, setGenerating] = useState(false);
  const [confirm, setConfirm] = useState<"ai" | "clear" | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const docSeq = useRef(useUntieStore.getState().docSeq);

  const name = designScreenName(model, screen);
  const analysis = screen.source.kind === "screen" ? model.elements.find((e) => e.id === (screen.source as { screenId: string }).screenId) : undefined;
  const description = (analysis?.kind === "screen" && analysis.description?.trim()) || "";
  const screens = useMemo(() => design.screens.map((s) => ({ id: s.id, name: designScreenName(model, s) })), [design.screens, model]);
  const databases = useMemo(() => databaseInfos(model, design), [model, design]);
  const view = screen.view as Json | undefined;
  const bindings: Binding[] = screen.bindings ?? [];

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

  /** view と対応を置く。view に無い項目の対応は外す。失敗は toast */
  const save = (nextView: Json, nextBindings: Binding[]): boolean => {
    const r = dispatch((m) => setDesignScreenView(m, { systemId, id: screen.id, view: nextView, bindings: pruneBindings(nextView, nextBindings) }));
    if (!r.ok) pushToast(r.reason, "error");
    return r.ok;
  };

  /** フォームの編集 1 回分。最新の画面から写しを作って書き換え、1 回の dispatch で置く */
  const edit = (fn: (v: Json, b: Binding[]) => unknown) => {
    const cur = useUntieStore.getState().model.designs.find((d) => d.systemId === systemId)?.screens.find((s) => s.id === screen.id);
    if (!cur?.view) return;
    const v = clone(cur.view as Json);
    const b = clone(cur.bindings ?? []) as Binding[];
    if (fn(v, b) === false) return;
    save(v, b);
  };

  const generate = async () => {
    setConfirm(null);
    const st = useUntieStore.getState();
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
      const result = await generateScreen(st.model, systemId, screen.id, {
        provider,
        model: aiModels[provider] || PROVIDERS[provider].defaultModel,
        apiKey,
        signal: controller.signal,
      });
      // 生成のあいだに別の文書を開いていたら、結果は捨てる
      if (useUntieStore.getState().docSeq !== docSeq.current) return;
      const r = useUntieStore.getState().dispatch((m) => setDesignScreenView(m, { systemId, id: screen.id, view: result.view, bindings: result.bindings }));
      if (!r.ok) pushToast(r.reason, "error");
      else pushToast(`AI が画面 UI を作りました${result.dropped > 0 ? `。存在しない列や項目の対応 ${result.dropped} 件は捨てました` : ""}`, result.dropped > 0 ? "error" : "info");
    } catch (e) {
      pushToast(describeChatError(e), "error");
    } finally {
      abortRef.current = null;
      setGenerating(false);
    }
  };

  const requestGenerate = () => {
    if (screen.view !== undefined || (screen.bindings?.length ?? 0) > 0) setConfirm("ai");
    else void generate();
  };

  const doClear = () => {
    setConfirm(null);
    const r = dispatch((m) => clearDesignScreenView(m, { systemId, id: screen.id }));
    if (!r.ok) pushToast(r.reason, "error");
  };

  const conditions = useScreenConditions(model, analysis?.id);
  const aiDisabled = readOnly || generating || hasKey !== true;

  return (
    <div className="editor screen-builder-body" data-testid="screen-builder">
      <h3 className="screen-title">{name}</h3>
      {view ? (
        <CommitField
          label="画面の目的"
          value={str(view.goal)}
          placeholder={description || name}
          maxLength={LIMITS.description.max}
          readOnly={readOnly}
          onCommit={(v) => edit((d) => setOrDelete(d, "goal", v.trim()))}
        />
      ) : (
        description && (
          <div className="field">
            <span className="field-label">画面の目的 (分析の説明)</span>
            <div className="static-value">{description}</div>
          </div>
        )
      )}
      <label className="field">
        <span className="field-label">レイアウト</span>
        <select
          aria-label="レイアウト"
          value={screen.shell ?? ""}
          disabled={readOnly}
          onChange={(e) => {
            const v = e.target.value;
            const r = dispatch((m) => setDesignScreenShell(m, { systemId, screenId: screen.id, shell: v === "shell" || v === "plain" ? v : undefined }));
            if (!r.ok) pushToast(r.reason, "error");
          }}
        >
          <option value="">設計のレイアウトに従う ({design.layout.shell})</option>
          <option value="shell">{SHELL_LABELS.shell}</option>
          <option value="plain">{SHELL_LABELS.plain}</option>
        </select>
      </label>
      {conditions.length > 0 && (
        <div className="field">
          <span className="field-label">この画面が判断する条件</span>
          <ScreenConditionList conditions={conditions} />
        </div>
      )}
      <div className="nav-actions">
        <button
          type="button"
          disabled={aiDisabled}
          title={hasKey === false ? "「AI の設定」で API キーを入れると使えます" : readOnly ? "閲覧専用です" : "画面の材料と使うデータベースから、画面 UI と列の対応を AI に作らせる"}
          onClick={requestGenerate}
        >
          {generating ? "作っています…" : "AI で作る"}
        </button>
        {view && (
          <label className="check-row">
            <input type="checkbox" aria-label="YAML で編集" checked={yaml} onChange={(e) => setYaml(e.target.checked)} />
            YAML で編集
          </label>
        )}
      </div>
      {hasKey === false && !readOnly && (
        <p className="hint">
          「AI で作る」を使うには、<button type="button" className="link" onClick={() => setSettingsOpen(true)}>AI の設定</button>で {PROVIDERS[provider].label} の API キーを入れてください。
        </p>
      )}
      {readOnly && <p className="hint">閲覧専用です。編集はできません。</p>}

      {!view ? (
        <div className="screen-empty">
          <p className="hint">この画面には、画面 UI がまだありません。</p>
          {!readOnly && (
            <button type="button" onClick={() => save(newView(name, description || name, screenIsReadOnly(model, analysis?.id)), [])}>
              画面 UI を作る
            </button>
          )}
        </div>
      ) : yaml ? (
        <ScreenYamlEditor
          key={`${screen.id}:yaml`}
          view={view}
          readOnly={readOnly}
          fallback={{ title: name, goal: description || name }}
          selfId={screen.id}
          screenIds={design.screens.map((s) => s.id)}
          onSave={(next) => {
            // 最新の対応を読み、view に無くなった項目の対応を外して、外した件数を知らせる
            const cur = useUntieStore.getState().model.designs.find((d) => d.systemId === systemId)?.screens.find((s) => s.id === screen.id);
            const latest = (cur?.bindings ?? []) as Binding[];
            const kept = pruneBindings(next, latest);
            const ok = save(next, latest);
            if (ok && kept.length < latest.length) pushToast(`画面 UI にない項目の列の対応 ${latest.length - kept.length} 件を外しました`, "info");
            return ok;
          }}
        />
      ) : (
        <ScreenFormEditor view={view} bindings={bindings} screens={screens} databases={databases} readOnly={readOnly} edit={edit} notify={(m) => pushToast(m, "error")} />
      )}

      {view && !readOnly && (
        <button type="button" className="screen-clear" onClick={() => setConfirm("clear")}>
          画面 UI を消す
        </button>
      )}
      {confirm === "ai" && (
        <ConfirmDialog
          title="画面 UI を置き換える"
          message="いまの画面 UI と、項目と列の対応を、AI が作ったものに置き換えます。"
          confirmLabel="置き換える"
          danger
          onConfirm={() => void generate()}
          onCancel={() => setConfirm(null)}
        />
      )}
      {confirm === "clear" && (
        <ConfirmDialog
          title="画面 UI を消す"
          message={`画面「${name}」の画面 UI と、項目と列の対応 (${bindings.length} 件) を消します。画面はサイトマップに残り、仮の画面を出します。`}
          confirmLabel="消す"
          danger
          onConfirm={doClear}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  );
}
