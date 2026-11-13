import { useRef, useState } from "react";
import { useAgentStore } from "../../ai/agentStore";
import { describeChatError } from "../../ai/chat";
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
  const provider = PROVIDERS[settings.provider];
  const model = settings.models[settings.provider] || provider.defaultModel;
  const running = step !== null && step !== "done";
  const fileCount = tree ? visibleFiles(tree).length : 0;

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
    if (!tree) return;
    setError(null);
    setSurvey("");
    setReads([]);
    setReadCount(0);
    setLog([]);
    setScreen(null);
    setWarnings(null);
    const st = useUntieStore.getState();
    if (hasUnsavedChanges(st) && !(await getPlatform().confirmDiscard("保存していない変更があります。破棄して新しいモデルを作りますか？"))) return;
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
    controller.current = new AbortController();
    setStep("survey");
    try {
      const res = await reverseEngineer(tree, request, {
        provider: settings.provider,
        model,
        apiKey,
        signal: controller.current.signal,
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
      setError(describeChatError(e));
      setStep(null);
    } finally {
      controller.current = null;
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
            AI が読んだ部分のソースコードは、選んでいる AI ({provider.label}) の API に送られます。フォルダ全体を送るわけではありません。
          </li>
          <li>
            <code>.env</code> や鍵などの秘密になりうるファイル、<code>node_modules</code> などの依存・生成物は読みません。
          </li>
          <li>対象の業務のほか、関係する業務・データ・画面も調べます。</li>
        </ul>
        <div className="prompt-ai">
          使う AI: {provider.label} ({model})
          <button type="button" className="link-plain context-apply" disabled={running} onClick={() => setSettingsOpen(true)}>
            変える
          </button>
        </div>
        {step && (
          <div className="prompt-progress" role="status">
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
            {survey && <pre className="prompt-analysis">{survey}</pre>}
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
          <div className="source-warnings" role="status">
            <div className="prompt-step">
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
