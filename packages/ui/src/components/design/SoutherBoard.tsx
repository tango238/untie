import { useMemo } from "react";
import { exportSouther } from "@untie/core/model/southerExport";
import { exportSoutherToFolder } from "../../io/document";
import { useUntieStore } from "../../store";

/**
 * 設計ボード「業務ルール (Souther)」(開発モードのときだけ)。
 * 対象のシステムの操作を、Souther (業務ルールを data と behavior で書き、example の行で組み合わせを確かめる言語) のソースにして見せる。
 * 中身は分析から導くので、ここでは直せない。まだ決まっていない組み合わせは、答えが `<?>` の行になる
 */
export function SoutherBoard() {
  const model = useUntieStore((s) => s.model);
  const systemId = useUntieStore((s) => s.ui.designSystemId);
  const result = useMemo(() => (systemId ? exportSouther(model, systemId) : null), [model, systemId]);
  const systemName = model.elements.find((e) => e.id === systemId)?.name || "(名前なし)";
  if (!result) return null;
  const lines = result.text.replace(/\n$/, "").split("\n");
  return (
    <section className="domain-board souther-board" aria-label="設計ボード: 業務ルール (Souther)">
      <div className="dsl-toolbar domain-toolbar">
        <h2 className="dsl-title">業務ルール (Souther)</h2>
        <span className="souther-file">{result.fileName}</span>
        <button type="button" onClick={() => void exportSoutherToFolder()} title="すべてのシステムの分を、選んだフォルダへ .sou のファイルで書き出す">
          書き出す…
        </button>
      </div>
      <p className="hint domain-hint">
        「{systemName}」の操作を、分析から Souther のソースにしています。状態は data、操作は behavior、条件のときの流れ (代替パターン) は guard と example の行です。書き出したファイルを Souther のコンパイラに通すと、行が成り立つかと、行の無い組み合わせが分かります
      </p>
      <div className="domain-scroll souther-scroll">
        <dl className="souther-counts" aria-label="書き出しの数">
          <div>
            <dt>操作 (behavior)</dt>
            <dd data-testid="souther-behaviors">{result.behaviors}</dd>
          </div>
          <div>
            <dt>例の行</dt>
            <dd data-testid="souther-rows">{result.rows}</dd>
          </div>
          <div className={result.owed > 0 ? "is-owed" : undefined}>
            <dt>答え待ちの行</dt>
            <dd data-testid="souther-owed">{result.owed}</dd>
          </div>
          <div>
            <dt>書き出していない操作</dt>
            <dd data-testid="souther-skipped">{result.skipped.length}</dd>
          </div>
        </dl>
        {result.open.length > 0 && (
          <section className="souther-open" aria-label="まだ決まっていない組み合わせ" data-testid="souther-open">
            <h3 className="contextmap-title">まだ決まっていない組み合わせ ({result.open.length})</h3>
            <ul>
              {result.open.map((o, i) => (
                <li key={i}>{o.message}</li>
              ))}
            </ul>
          </section>
        )}
        {result.behaviors === 0 ? (
          <p className="hint domain-empty">書き出せる操作がまだありません。分析で、このシステムの操作に、前提の状態 (状態 → 操作) か、判断する条件 (操作 → 条件) を結ぶと、ここに出ます</p>
        ) : (
          <pre className="souther-source" aria-label="Souther のソース" data-testid="souther-source">
            {lines.map((text, i) => (
              <span key={i} className={`souther-line${text.trimStart().startsWith("//") ? " is-comment" : text.includes("<?>") ? " is-owed" : ""}`}>
                <span className="souther-no" aria-hidden="true">
                  {i + 1}
                </span>
                {text}
                {"\n"}
              </span>
            ))}
          </pre>
        )}
      </div>
    </section>
  );
}

/** 右のペイン (業務ルール): 書き出しの読み方 */
export function SoutherHelp() {
  return (
    <aside className="property-panel" aria-label="プロパティ">
      <h2 className="panel-title">書き出しの読み方</h2>
      <div className="editor">
        <p className="hint">業務ルールの骨組みを、分析から機械的に導いたものです。流れや条件を変えるときは、分析とシーケンス図を直します</p>
        <dl className="contextmap-legend">
          <div>
            <dt>data</dt>
            <dd>状態。同じグループの状態は、1 つの和 (どれか 1 つ) にまとめる</dd>
          </div>
          <div>
            <dt>behavior</dt>
            <dd>操作。入力は、前提の状態と、判断する条件 (真偽)。出力は、次の状態か、条件のときの別の結果</dd>
          </div>
          <div>
            <dt>guard … else</dt>
            <dd>条件で流れが変わるところ。シーケンス図の分岐で決めた「どうなるか」が、別の結果になる</dd>
          </div>
          <div>
            <dt>example</dt>
            <dd>確かめる組み合わせ。ふだんの流れと、条件のときの流れ。コンパイルのときに評価される</dd>
          </div>
          <div>
            <dt>{"<?>"}</dt>
            <dd>答え待ちの行。条件のときにどうなるか・次の状態がどれになるかが、まだ決まっていない</dd>
          </div>
        </dl>
        <p className="hint">ここに無いもの: 条件の式 (何で判断するか)、情報の項目、不変条件。条件は真偽の入力にしてあります</p>
        <p className="hint">
          確かめ方: 書き出したファイルに <code>souther examples ファイル名</code>。サンプルの分は、CI が同じことをしています
        </p>
      </div>
    </aside>
  );
}
