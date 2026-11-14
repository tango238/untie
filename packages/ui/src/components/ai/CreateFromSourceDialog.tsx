import { useEffect, useId, useRef, useState } from "react";
import { useAgentStore } from "../../ai/agentStore";
import { describeChatError, isAbortError } from "../../ai/chat";
import { getApiKey } from "../../ai/keys";
import { PROVIDERS } from "../../ai/providers";
import { reverseEngineer, type ReverseStep } from "../../ai/reverse";
import {
  MAX_SOURCES,
  MAX_SOURCE_LABEL_CHARS,
  MAX_TREE_FILES,
  labelKey,
  looksSameSource,
  sourceLabelProblems,
  sourcesTitle,
  tidySourceLabel,
  visibleFiles,
  type LabeledSource,
  type SourceTree,
} from "../../ai/sourceTree";
import { getPlatform } from "../../platform";
import { hasUnsavedChanges, useUntieStore } from "../../store";

/** 進み具合の段階 (順に進む)。done は段階に出さない */
const STAGES: { step: Exclude<ReverseStep, "done">; label: string }[] = [
  { step: "survey", label: "ソースコードを調べる" },
  { step: "model", label: "業務のモデルを作る" },
  { step: "data", label: "データを作る" },
  { step: "screens", label: "画面を作る" },
];

/** 画面に出す、読んだ場所の件数 */
const RECENT_READS = 5;

/** ラベルの候補 (足した行に、使っていないものを順に入れる。自由に書き換えられる) */
export const SOURCE_LABEL_CANDIDATES = ["バックエンド", "管理画面", "フロント画面", "バッチ", "共通ライブラリ", "モバイルアプリ"] as const;

/** 行の番号 (0 始まり) に合う候補。使われていれば、使っていない候補の先頭 (すべて使っていれば空)。1 つ目のラベルがフォルダ名でも、2 つ目が「管理画面」から始まらないように、番号を先に見る */
const nextCandidate = (used: readonly string[], index: number): string => {
  const keys = new Set(used.map(labelKey));
  const byIndex = SOURCE_LABEL_CANDIDATES[index];
  if (byIndex !== undefined && !keys.has(labelKey(byIndex))) return byIndex;
  return SOURCE_LABEL_CANDIDATES.find((c) => !keys.has(labelKey(c))) ?? "";
};

/** 空のラベルへ自動で入れる値。フォルダ名を規則に合う形に整えたもの (ほかの行と重なる・整えて空になるなら、使っていない候補) */
const autoLabel = (folderName: string | undefined, used: readonly string[], index: number): string => {
  const tidy = folderName ? tidySourceLabel(folderName) : "";
  return tidy !== "" && !used.some((u) => labelKey(u) === labelKey(tidy)) ? tidy : nextCandidate(used, index);
};

/** 畳んだ要約に出す、ソースの呼び名 (ラベルだけ。ラベルが無い 1 つだけのときは「ソースコード「フォルダ名」」) */
const summaryTitle = (rows: readonly SourceRow[]): string =>
  rows.length === 1 ? sourcesTitle([{ label: rows[0]!.label.trim(), folder: rows[0]!.tree?.name ?? "" }]) : `ソースコード ${rows.length} か所 (${rows.map((r) => r.label.trim() || r.tree?.name || "未選択").join("・")})`;

/** 登録したソース (ソースコードのフォルダ) の 1 行 */
interface SourceRow {
  key: number;
  label: string;
  tree: SourceTree | null;
  /** 読めるファイルの数 (選んだときに 1 度だけ数える。2 万件で約 22ms) */
  fileCount: number;
  /** フォルダを選んだ回数 (同じ名前の別のフォルダに選び直したときも、同じフォルダの警告を見直すきっかけにする) */
  picks: number;
}

/** ファイル > ソースコードから作成: ソースコードのフォルダを AI に読んでもらい、業務のモデルに起こす */
export function CreateFromSourceDialog({ onClose }: { onClose: () => void }) {
  const settings = useAgentStore((s) => s.settings);
  const setSettingsOpen = useAgentStore((s) => s.setSettingsOpen);
  const continueFrom = useAgentStore((s) => s.continueFrom);
  const nextKey = useRef(1);
  const [rows, setRows] = useState<SourceRow[]>([{ key: 0, label: "", tree: null, fileCount: 0, picks: 0 }]);
  /** 同じフォルダを重ねて登録しているらしい行 (key → 先に登録した行の番号 (1 始まり)) */
  const [duplicates, setDuplicates] = useState<Map<number, number>>(new Map());
  /** 足した行のラベルの入力欄へフォーカスを移す (行の key) */
  const [focusRow, setFocusRow] = useState<number | null>(null);
  /** ラベルの欄を一度離れた行 (空のラベルのエラーは、離れてから出す。足した直後から読み上げられないように) */
  const [touched, setTouched] = useState<ReadonlySet<number>>(new Set());
  const labelInputs = useRef(new Map<number, HTMLInputElement>());
  const addButton = useRef<HTMLButtonElement | null>(null);
  const datalistId = useId();
  const [request, setRequest] = useState("");
  const [step, setStep] = useState<ReverseStep | null>(null);
  const [survey, setSurvey] = useState("");
  const [reads, setReads] = useState<string[]>([]);
  const [readCount, setReadCount] = useState(0);
  const [log, setLog] = useState<string[]>([]);
  const [screen, setScreen] = useState<{ done: number; total: number } | null>(null);
  const [warnings, setWarnings] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pickingKey, setPickingKey] = useState<number | null>(null);
  const controller = useRef<AbortController | null>(null);
  /** 生成を始めている最中か (「作成」の二度押しで 2 本走らせない) */
  const starting = useRef(false);
  const mounted = useRef(true);
  // ダイアログが外れたら生成を止める (結果が届いても、今開いているモデルを置き換えない)
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, []);
  const provider = PROVIDERS[settings.provider];
  const model = settings.models[settings.provider] || provider.defaultModel;
  const running = step !== null && step !== "done";
  const multi = rows.length > 1;
  // ラベルの検査: ソースが 1 つならラベルは任意 (あれば形だけ見る)、2 つ以上なら必須で、重複も見る
  const labelProblems: (string | null)[] = multi
    ? sourceLabelProblems(rows.map((r) => r.label.trim()))
    : rows.map((r) => (r.label.trim() === "" ? null : sourceLabelProblems([r.label.trim()])[0]!));
  const totalFiles = rows.reduce((n, r) => n + r.fileCount, 0);
  const anyDepthTruncated = rows.some((r) => r.tree?.depthTruncated);
  const emptyRow = rows.some((r) => r.tree && r.fileCount === 0);
  // 同じフォルダを 2 回登録していないか。確かなのは isSameEntry (Chrome・Edge)。使えなければ、フォルダ名とファイルの一覧が同じかで見る (警告だけで、作成は止めない)
  useEffect(() => {
    let cancelled = false;
    const picked = rows.filter((r): r is SourceRow & { tree: SourceTree } => r.tree !== null);
    void (async () => {
      const found = new Map<number, number>();
      for (let j = 1; j < picked.length; j++) {
        for (let i = 0; i < j; i++) {
          const sure = await picked[j]!.tree.sameFolderAs?.(picked[i]!.tree).catch(() => null);
          if (sure ?? looksSameSource(picked[i]!.tree, picked[j]!.tree)) {
            found.set(picked[j]!.key, rows.findIndex((r) => r.key === picked[i]!.key) + 1);
            break;
          }
        }
      }
      if (!cancelled) setDuplicates((prev) => (prev.size === found.size && [...found].every(([k, v]) => prev.get(k) === v) ? prev : found));
    })();
    return () => {
      cancelled = true;
    };
    // 木の組が替わったときだけ見直す (ラベルの入力では見直さない)。同じ名前の別のフォルダに選び直したときも見直すよう、選んだ回数を入れる
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows.map((r) => (r.tree ? `${r.key}:${r.picks}` : "-")).join(",")]);
  useEffect(() => {
    if (focusRow === null) return;
    labelInputs.current.get(focusRow)?.focus();
    setFocusRow(null);
  }, [focusRow]);
  // 調査結果の文章の枠は、文章が届くたびに末尾までスクロールして最新の文を見せる。利用者が上へスクロールしているときは戻さない
  const surveyBox = useRef<HTMLPreElement | null>(null);
  const followSurvey = useRef(true);
  useEffect(() => {
    const el = surveyBox.current;
    if (el && followSurvey.current) el.scrollTop = el.scrollHeight;
  }, [survey]);

  const patchRow = (key: number, patch: Partial<SourceRow>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  const pick = async (key: number) => {
    setPickingKey(key);
    setError(null);
    try {
      const picked = await getPlatform().pickSourceFolder();
      if (picked && mounted.current) {
        const fileCount = visibleFiles(picked).length;
        // ソースが 2 つ以上のとき (ラベルが必須) だけ、空のラベルへフォルダ名を規則に合う形に整えて入れる。1 つだけのときは任意なので、自動では入れない
        setRows((rs) =>
          rs.map((r, i) =>
            r.key === key
              ? { ...r, tree: picked, fileCount, picks: r.picks + 1, label: rs.length > 1 && r.label.trim() === "" ? autoLabel(picked.name, rs.map((x) => x.label.trim()), i) : r.label }
              : r,
          ),
        );
      }
    } catch (e) {
      setError(`フォルダを読めませんでした。(${String(e)})`);
    } finally {
      setPickingKey(null);
    }
  };

  const addRow = () => {
    if (rows.length >= MAX_SOURCES) return;
    const key = nextKey.current++;
    setRows((rs) => {
      // 1 つ目のラベルが空なら、2 つ目を足すときに入れる (ソースが 2 つ以上のときは、ラベルが必須)。フォルダを選んでいれば規則に合う形に整えたフォルダ名、無ければ候補
      const first = rs[0]!.label.trim() === "" ? { ...rs[0]!, label: autoLabel(rs[0]!.tree?.name, [], 0) } : rs[0]!;
      const base = [first, ...rs.slice(1)];
      return [...base, { key, label: nextCandidate(base.map((r) => r.label), base.length), tree: null, fileCount: 0, picks: 0 }];
    });
    setFocusRow(key);
  };

  const removeRow = (key: number) => {
    // 最後の 1 行を外したら、空の行に戻す
    setRows((rs) => (rs.length <= 1 ? [{ key: nextKey.current++, label: "", tree: null, fileCount: 0, picks: 0 }] : rs.filter((r) => r.key !== key)));
    // 外した行のフォーカスは、行を足すボタンへ
    requestAnimationFrame(() => addButton.current?.focus());
  };

  const start = async () => {
    if (starting.current || !canStart) return;
    starting.current = true;
    try {
      await run(rows.map((r) => ({ label: r.label.trim(), tree: r.tree! })));
    } finally {
      starting.current = false;
    }
  };

  const run = async (sources: LabeledSource[]) => {
    setError(null);
    setSurvey("");
    followSurvey.current = true;
    setReads([]);
    setReadCount(0);
    setLog([]);
    setScreen(null);
    setWarnings(null);
    const st = useUntieStore.getState();
    if (hasUnsavedChanges(st) && !(await getPlatform().confirmDiscard("保存していない変更があります。破棄して新しいモデルを作りますか？"))) return;
    if (!mounted.current) return;
    let apiKey: string | null;
    try {
      apiKey = await getApiKey(settings.provider);
    } catch (e) {
      setError(`${provider.label} の API キーをキーチェーンから読み出せませんでした。「AI の設定」で保存し直してください。(${String(e)})`);
      return;
    }
    if (!apiKey) {
      setError(`${provider.label} の API キーが設定されていません。「AI の設定」で入れてください。`);
      return;
    }
    if (!mounted.current) return;
    const ctl = new AbortController();
    controller.current = ctl;
    setStep("survey");
    try {
      const res = await reverseEngineer(sources, request, {
        provider: settings.provider,
        model,
        apiKey,
        signal: ctl.signal,
        onStep: setStep,
        onText: (d) => setSurvey((a) => a + d),
        onSourceTool: (name, detail) => {
          setReadCount((n) => n + 1);
          setReads((r) => [...r, `${name} ${detail}`].slice(-RECENT_READS));
        },
        onSubmit: (accepted, message) => setLog((l) => [...l, `${accepted ? "✓" : "↻"} ${message}`]),
        onScreen: (done, total, name, ok) => {
          setScreen({ done, total });
          setLog((l) => [...l, `${ok ? "✓" : "×"} 画面 ${done}/${total}: ${name}`]);
        },
      });
      // 中断された・ダイアログが外れたあとに届いた結果では、今のモデルを置き換えない
      if (!mounted.current) return;
      if (ctl.signal.aborted) {
        setError("中断しました。");
        setStep(null);
        return;
      }
      useUntieStore.getState().newDocument(res.build.model);
      // 作成の会話を引き継いで、AI エージェントで続けられるようにする
      continueFrom(res.seed, [
        { role: "user", text: `${sourcesTitle(sources.map((x) => ({ label: x.label, folder: x.tree.name })))}から作成: ${request}` },
        { role: "assistant", text: res.summary },
        { role: "info", text: "このまま会話を続けて、モデルを直せます。" },
      ]);
      if (res.warnings.length > 0) {
        // 気づいたことは、閉じる前に読めるよう残す
        setWarnings(res.warnings);
        setStep("done");
      } else {
        onClose();
      }
    } catch (e) {
      if (!mounted.current) return;
      setError(ctl.signal.aborted || isAbortError(e) ? "中断しました。" : describeChatError(e));
      setStep(null);
    } finally {
      if (controller.current === ctl) controller.current = null;
    }
  };

  const finished = warnings !== null;
  const stageIndex = step ? STAGES.findIndex((s) => s.step === step) : -1;
  const allPicked = rows.every((r) => r.tree !== null);
  // フォルダをたどっている間 (選び直し中) は押せない (たどり終えるまで、古い木のまま始めてしまわないように)
  const canStart = allPicked && !emptyRow && labelProblems.every((p) => p === null) && !!request.trim() && !running && !finished && pickingKey === null;
  /** 生成が始まったら (終わって気づいたことを見せるときも)、登録欄・説明・入力欄は畳んで要約にし、進み具合を見せる。失敗・中断で step が戻ったら、登録欄へ戻る */
  const collapsed = step !== null;

  return (
    <div className="dialog-backdrop" onKeyDown={(e) => e.key === "Escape" && !running && onClose()}>
      <div className="dialog prompt-dialog source-dialog" role="dialog" aria-modal="true" aria-label="ソースコードから作成">
        <h2>ソースコードから作成</h2>
        <div className="source-dialog-body">
          {collapsed ? (
            <div className="source-summary" title={`${summaryTitle(rows)} / 業務: ${request.trim()}`}>
              <div className="source-summary-sources">{summaryTitle(rows)}</div>
              <div className="source-summary-request">業務: {request.trim()}</div>
            </div>
          ) : (
            <>
            <p className="hint">
              既存のソースコードのフォルダを AI が読み、対象の業務と、関係する業務・データ・画面を調べて、新しいモデルを作ります。バックエンド・管理画面・フロント画面のようにソースコードが分かれているときは、フォルダを複数登録できます。今のモデルは置き換わります (保存はしません)。
            </p>
            <datalist id={datalistId}>
              {SOURCE_LABEL_CANDIDATES.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
            <ul className="source-rows" aria-label="ソースコードの場所">
              {rows.map((row, i) => {
                const titleId = `${datalistId}-title-${row.key}`;
                const problemId = `${datalistId}-problem-${row.key}`;
                // 空のラベルのエラーは、欄を離れてから出す (行を足した直後から、入力のたびに読み上げられないように)
                const problem = labelProblems[i] && (row.label.trim() !== "" || touched.has(row.key)) ? labelProblems[i] : null;
                const duplicateOf = duplicates.get(row.key);
                const shown = row.label.trim() || row.tree?.name || "未選択";
                const busy = running || finished;
                return (
                  <li key={row.key} className="source-row">
                    <div className="source-row-head">
                      <strong id={titleId}>ソース {i + 1}</strong>
                      {(multi || row.tree) && (
                        <button
                          type="button"
                          className="link-plain"
                          disabled={busy}
                          aria-label={`ソース ${i + 1}「${shown}」を外す`}
                          onClick={() => removeRow(row.key)}
                        >
                          外す
                        </button>
                      )}
                    </div>
                    <label className="source-label-field">
                      <span>{multi ? "ラベル" : "ラベル (任意)"}</span>
                      <input
                        ref={(el) => {
                          if (el) labelInputs.current.set(row.key, el);
                          else labelInputs.current.delete(row.key);
                        }}
                        list={datalistId}
                        value={row.label}
                        maxLength={MAX_SOURCE_LABEL_CHARS + 20}
                        placeholder="例: バックエンド"
                        disabled={busy}
                        aria-label={multi ? `ソース ${i + 1} のラベル` : undefined}
                        aria-invalid={problem ? true : undefined}
                        aria-describedby={problem ? problemId : undefined}
                        onChange={(e) => patchRow(row.key, { label: e.target.value })}
                        onBlur={() => setTouched((t) => (t.has(row.key) ? t : new Set(t).add(row.key)))}
                      />
                    </label>
                    {problem && (
                      <p className="prompt-error source-row-problem" id={problemId} aria-live="polite">
                        {problem}
                      </p>
                    )}
                    <div className="source-folder">
                      <button type="button" disabled={busy || pickingKey !== null} aria-describedby={titleId} onClick={() => void pick(row.key)}>
                        {row.tree ? "選び直す…" : "フォルダを選ぶ…"}
                      </button>
                      {row.tree ? (
                        <span className="source-folder-name">
                          <strong>{row.tree.name}</strong>
                          <span className="source-folder-count">読めるファイル {row.fileCount} 件</span>
                        </span>
                      ) : (
                        <span className="source-folder-count">ソースコードのフォルダを選んでください (読み取りだけで、書き換えません)</span>
                      )}
                    </div>
                    {row.tree && row.fileCount === 0 && (
                      <p className="prompt-error">このフォルダには、AI が読めるファイルがありません。別のフォルダを選ぶか、この行を外してください。</p>
                    )}
                    {row.tree?.truncated && (
                      <p className="source-note">ファイルが多すぎるため、途中までしか数えていません。数えていないファイルは、AI が読み取りも検索もできません。</p>
                    )}
                    {row.tree?.depthTruncated && <p className="source-note">深すぎるフォルダは読んでいません。その下のファイルは AI に見えません。</p>}
                    {duplicateOf !== undefined && (
                      <p className="source-note source-duplicate">同じフォルダを、ソース {duplicateOf} と重ねて登録していませんか? (フォルダ名とファイルの一覧が同じです)</p>
                    )}
                  </li>
                );
              })}
            </ul>
            <div className="source-add">
              <button type="button" ref={addButton} disabled={running || finished || rows.length >= MAX_SOURCES} onClick={addRow}>
                ソースコードの場所を足す
              </button>
              <span className="source-folder-count">
                {rows.length >= MAX_SOURCES ? `${MAX_SOURCES} か所まで登録できます` : multi ? `${rows.length}/${MAX_SOURCES} か所` : "別のフォルダにあるソースコードも、あわせて読めます"}
              </span>
              {multi && (
                <span className="source-total" aria-live="polite">
                  合計 読めるファイル {totalFiles} 件
                </span>
              )}
            </div>
            {multi && totalFiles > MAX_TREE_FILES && (
              <p className="source-note">
                合計が上限 ({MAX_TREE_FILES.toLocaleString("ja-JP")} 件) を超えるため、ソースごとに上限を分け合います。多いソースの一部のファイルは、一覧に出ず、AI は読み取りも検索もできません (フォルダごとに少しずつ残します)。
              </p>
            )}
            {multi && anyDepthTruncated && <p className="source-note">深すぎるフォルダがあるソースがあります。</p>}
            <textarea
              aria-label="モデルに起こしたい業務"
              className="prompt-input"
              placeholder="例: 受注から出荷まで"
              value={request}
              rows={3}
              disabled={running || finished}
              onChange={(e) => setRequest(e.target.value)}
            />
            <ul className="source-notes">
              <li>
                選んでいる AI ({provider.label}) の API に送られるのは、フォルダ名とラベル、ファイルの一覧 (名前と大きさ)、AI が開いたファイルの中身、検索で見つかった行です。フォルダ全体は送りません。
              </li>
              <li>
                <code>.env</code> や鍵のファイル、<code>node_modules</code> などの依存・生成物は読みません。ただし、ふつうのソースファイルに直接書かれたキーや個人情報は送られることがあります。
              </li>
              {multi && <li>ソースを複数登録すると、ラベルが、どのソースのファイルかを示すパスの先頭 (例: バックエンド/src/routes/orders.ts) として AI に渡ります。AI は、ソースをまたいで読みます。</li>}
              <li>対象の業務のほか、関係する業務・データ・画面も調べます。画面の数だけ AI を呼ぶので、数分かかり、API の利用料がかかります。</li>
            </ul>
            <div className="prompt-ai">
              使う AI: {provider.label} ({model})
              <button type="button" className="link-plain context-apply" disabled={running} onClick={() => setSettingsOpen(true)}>
                変える
              </button>
            </div>
            </>
          )}
          {step && (
            <div className="prompt-progress">
              <div className="visually-hidden" role="status">
                {stageIndex >= 0 ? `${stageIndex + 1}/${STAGES.length} ${STAGES[stageIndex]!.label}` : "完了"}
              </div>
              <ol className="source-stages">
                {STAGES.map((s, i) => {
                  const state = step === "done" || i < stageIndex ? "done" : i === stageIndex ? "now" : "next";
                  return (
                    <li key={s.step} className={`source-stage is-${state}`} aria-current={state === "now" ? "step" : undefined}>
                      <span aria-hidden="true">{state === "done" ? "✓" : state === "now" ? "▶" : "・"}</span> {i + 1}/{STAGES.length} {s.label}
                    </li>
                  );
                })}
              </ol>
              {readCount > 0 && (
                <div className="source-reads">
                  <div className="prompt-step">読んだ場所 ({readCount} 件)</div>
                  {reads.map((r, i) => (
                    <div key={`${readCount}-${i}`} className="prompt-log">
                      {r}
                    </div>
                  ))}
                </div>
              )}
              {survey && (
                <pre
                  ref={surveyBox}
                  className="prompt-analysis source-survey"
                  onScroll={(e) => {
                    const el = e.currentTarget;
                    followSurvey.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 24;
                  }}
                >
                  {survey}
                </pre>
              )}
              {screen && (
                <div className="prompt-step">
                  画面 {screen.done}/{screen.total}
                </div>
              )}
              {log.map((l, i) => (
                <div key={i} className="prompt-log">
                  {l}
                </div>
              ))}
            </div>
          )}
          {warnings && (
            <div className="source-warnings">
              <div className="prompt-step" role="status">
                モデルを作りました。気づいたことが {warnings.length} 件あります。
              </div>
              <ul>
                {warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
          )}
          {error && <p className="prompt-error">{error}</p>}
        </div>
        <div className="dialog-actions">
          {running ? (
            <button type="button" onClick={() => controller.current?.abort()}>
              中断
            </button>
          ) : (
            <button type="button" onClick={onClose}>
              閉じる
            </button>
          )}
          {!finished && (
            <button
              type="button"
              className={`primary${running ? " is-busy" : ""}`}
              disabled={!canStart}
              aria-busy={running}
              onClick={() => void start()}
            >
              {running && <span className="spinner" aria-hidden="true" />}
              {running ? "生成中…" : error ? "やり直す" : "作成"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
