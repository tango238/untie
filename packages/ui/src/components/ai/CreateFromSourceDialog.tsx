import { useEffect, useMemo, useRef, useState } from "react";
import { useAgentStore } from "../../ai/agentStore";
import { describeChatError, isAbortError } from "../../ai/chat";
import { getApiKey } from "../../ai/keys";
import { PROVIDERS } from "../../ai/providers";
import { reverseEngineer, type ReverseStep } from "../../ai/reverse";
import { visibleFiles, type SourceTree } from "../../ai/sourceTree";
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

/** ファイル > ソースコードから作成: ソースコードのフォルダを AI に読んでもらい、業務のモデルに起こす */
export function CreateFromSourceDialog({ onClose }: { onClose: () => void }) {
  const settings = useAgentStore((s) => s.settings);
  const setSettingsOpen = useAgentStore((s) => s.setSettingsOpen);
  const continueFrom = useAgentStore((s) => s.continueFrom);
  const [tree, setTree] = useState<SourceTree | null>(null);
  const [request, setRequest] = useState("");
  const [step, setStep] = useState<ReverseStep | null>(null);
  const [survey, setSurvey] = useState("");
  const [reads, setReads] = useState<string[]>([]);
  const [readCount, setReadCount] = useState(0);
  const [log, setLog] = useState<string[]>([]);
  const [screen, setScreen] = useState<{ done: number; total: number } | null>(null);
  const [warnings, setWarnings] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
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
  // 読めるファイルの数 (2 万件で約 22ms)。調査中は文章が届くたびに描画し直すので、木が替わったときだけ数える
  const fileCount = useMemo(() => (tree ? visibleFiles(tree).length : 0), [tree]);
  // 調査結果の文章の枠は、文章が届くたびに末尾までスクロールして最新の文を見せる。利用者が上へスクロールしているときは戻さない
  const surveyBox = useRef<HTMLPreElement | null>(null);
  const followSurvey = useRef(true);
  useEffect(() => {
    const el = surveyBox.current;
    if (el && followSurvey.current) el.scrollTop = el.scrollHeight;
  }, [survey]);

  const pick = async () => {
    setPicking(true);
    setError(null);
    try {
      const picked = await getPlatform().pickSourceFolder();
      if (picked) setTree(picked);
    } catch (e) {
      setError(`フォルダを読めませんでした。(${String(e)})`);
    } finally {
      setPicking(false);
    }
  };

  const start = async () => {
    if (!tree || starting.current) return;
    starting.current = true;
    try {
      await run(tree);
    } finally {
      starting.current = false;
    }
  };

  const run = async (tree: SourceTree) => {
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
      const res = await reverseEngineer(tree, request, {
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
        { role: "user", text: `ソースコード「${tree.name}」から作成: ${request}` },
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
  const canStart = !!tree && fileCount > 0 && !!request.trim() && !running && !finished;

  return (
    <div className="dialog-backdrop" onKeyDown={(e) => e.key === "Escape" && !running && onClose()}>
      <div className="dialog prompt-dialog source-dialog" role="dialog" aria-modal="true" aria-label="ソースコードから作成">
        <h2>ソースコードから作成</h2>
        <p className="hint">
          既存のソースコードのフォルダを AI が読み、対象の業務と、関係する業務・データ・画面を調べて、新しいモデルを作ります。今のモデルは置き換わります (保存はしません)。
        </p>
        <div className="source-folder">
          <button type="button" disabled={running || picking || finished} onClick={() => void pick()}>
            {tree ? "選び直す…" : "フォルダを選ぶ…"}
          </button>
          {tree ? (
            <span className="source-folder-name">
              <strong>{tree.name}</strong>
              <span className="source-folder-count">読めるファイル {fileCount} 件</span>
            </span>
          ) : (
            <span className="source-folder-count">ソースコードのフォルダを選んでください (読み取りだけで、書き換えません)</span>
          )}
        </div>
        {tree && fileCount === 0 && (
          <p className="prompt-error">このフォルダには、AI が読めるファイルがありません。別のフォルダを選んでください。</p>
        )}
        {tree?.truncated && (
          <p className="source-note">ファイルが多すぎるため、途中までしか数えていません。AI は一部のファイルだけを見ることになります。</p>
        )}
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
            選んでいる AI ({provider.label}) の API に送られるのは、フォルダ名、ファイルの一覧 (名前と大きさ)、AI が開いたファイルの中身、検索で見つかった行です。フォルダ全体は送りません。
          </li>
          <li>
            <code>.env</code> や鍵のファイル、<code>node_modules</code> などの依存・生成物は読みません。ただし、ふつうのソースファイルに直接書かれたキーや個人情報は送られることがあります。
          </li>
          <li>対象の業務のほか、関係する業務・データ・画面も調べます。画面の数だけ AI を呼ぶので、数分かかり、API の利用料がかかります。</li>
        </ul>
        <div className="prompt-ai">
          使う AI: {provider.label} ({model})
          <button type="button" className="link-plain context-apply" disabled={running} onClick={() => setSettingsOpen(true)}>
            変える
          </button>
        </div>
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
