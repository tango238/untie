import { useEffect, useMemo, useRef, useState } from "react";
import { viewShapeProblem } from "@untie/core/model/designView";
import { dump, JSON_SCHEMA, load } from "js-yaml";
import { useUntieStore } from "../../store";
import { isObject, type Json } from "./screenForm";
import { validateView } from "./viewValidate";

interface Props {
  /** いまの画面 UI (view) */
  view: Json;
  readOnly: boolean;
  /** title / goal が view に無いときの補い (mokkun の検証は両方を要る。プレビューでも画面の名前と説明を使う) */
  fallback: { title: string; goal: string };
  /** 設計の画面の id (自分) と、ほかの画面の id (遷移先の検証に使う) */
  selfId: string;
  screenIds: string[];
  /** 検証に通った view を保存する。保存できたら true */
  onSave: (view: Json) => boolean;
}

/** view を YAML の文章にする。JSON_SCHEMA で読み書きするので、日付のような文字列が日付型にならない */
export function viewToYaml(view: Json): string {
  return dump(view, { schema: JSON_SCHEMA, lineWidth: 100, noRefs: true });
}

/** YAML の文章を view にして検証する。通れば view、通らなければ理由 */
export function parseViewYaml(text: string, fallback: Props["fallback"], selfId: string, screenIds: string[]): { ok: true; view: Json } | { ok: false; message: string } {
  let parsed: unknown;
  try {
    parsed = load(text, { schema: JSON_SCHEMA });
  } catch (e) {
    return { ok: false, message: `YAML を読めません: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}` };
  }
  if (!isObject(parsed)) return { ok: false, message: "画面 UI はキーと値の形 (view) で書いてください" };
  // エイリアスで小さな入力が巨大に膨らむのを、検証の前に断る
  const shape = viewShapeProblem(parsed);
  if (shape) return { ok: false, message: shape };
  const check = validateView({ ...fallback, ...parsed }, selfId, screenIds);
  return check.ok ? { ok: true, view: parsed } : { ok: false, message: `mokkun の検証に通りません: ${check.message}` };
}

/**
 * 画面 UI を YAML で編集する。入力中は下書きに持ち (外の更新で書きかけを壊さない)、blur か Cmd+Enter で mokkun の検証に通ったときだけ保存する。
 * 通らなければ理由を下に出し、保存しない (下書きは残す)。列の対応 (bindings) は YAML に含めない
 */
export function ScreenYamlEditor({ view, readOnly, fallback, selfId, screenIds, onSave }: Props) {
  const current = useMemo(() => viewToYaml(view), [view]);
  const [draft, setDraft] = useState<string | null>(null);
  const draftRef = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // マウントした文書の世代。別のファイルを開いたあとに、前のファイルの下書きを同じ id の画面へ書かないために覚える
  const docSeq = useRef(useUntieStore.getState().docSeq);

  const updateDraft = (v: string | null) => {
    draftRef.current = v;
    setDraft(v);
  };

  /** 下書きを確定する。検証に通らない・保存できないときは下書きを残す */
  const commit = () => {
    const text = draftRef.current;
    if (text === null) return;
    if (text === current) {
      updateDraft(null);
      setError(null);
      return;
    }
    const r = parseViewYaml(text, fallback, selfId, screenIds);
    if (!r.ok) {
      setError(r.message);
      return;
    }
    if (onSave(r.view)) {
      updateDraft(null);
      setError(null);
    }
  };
  const commitRef = useRef(commit);
  commitRef.current = commit;
  // 画面を離れる (別の画面を選ぶ・表示を切り替える) ときは、書きかけを確定する。通らなければ捨てる
  useEffect(
    () => () => {
      if (useUntieStore.getState().docSeq === docSeq.current) commitRef.current();
    },
    [],
  );

  return (
    <div className="screen-yaml">
      <textarea
        className="screen-yaml-textarea"
        aria-label="画面 UI の YAML"
        spellCheck={false}
        readOnly={readOnly}
        value={draft ?? current}
        onChange={(e) => updateDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
            e.preventDefault();
            commit();
          }
        }}
      />
      {error !== null ? (
        <p className="hint is-error" role="alert">
          {error}
        </p>
      ) : (
        <p className="hint">{draft !== null ? "確定していません。フォーカスを外すか Cmd+Enter で保存します" : "mokkun v2 の view の YAML です。列の対応はフォームで付けます"}</p>
      )}
    </div>
  );
}
