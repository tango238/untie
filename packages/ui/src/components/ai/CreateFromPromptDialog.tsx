import { useEffect, useRef, useState } from "react";
import { useAgentStore } from "../../ai/agentStore";
import { describeChatError, isAbortError } from "../../ai/chat";
import { generateFromPrompt, type GenerationStep } from "../../ai/generate";
import { getApiKey } from "../../ai/keys";
import { PROVIDERS } from "../../ai/providers";
import { getPlatform } from "../../platform";
import { hasUnsavedChanges, useUntieStore } from "../../store";

const STEP_LABELS: Record<GenerationStep, string> = {
  analysis: "1/2 初期要望を分析しています…",
  model: "2/2 業務・作業・操作・情報などを組み立てています…",
  done: "できました",
};

/** ファイル > プロンプトから作成: 初期要望の文章から、新しいモデルを AI に作ってもらう */
export function CreateFromPromptDialog({ onClose }: { onClose: () => void }) {
  const settings = useAgentStore((s) => s.settings);
  const setSettingsOpen = useAgentStore((s) => s.setSettingsOpen);
  const continueFrom = useAgentStore((s) => s.continueFrom);
  const [request, setRequest] = useState("");
  const [step, setStep] = useState<GenerationStep | null>(null);
  const [analysis, setAnalysis] = useState("");
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
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

  const start = async () => {
    if (starting.current) return;
    starting.current = true;
    try {
      await run();
    } finally {
      starting.current = false;
    }
  };

  const run = async () => {
    setError(null);
    setAnalysis("");
    setLog([]);
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
    try {
      const result = await generateFromPrompt(request, {
        provider: settings.provider,
        model,
        apiKey,
        signal: ctl.signal,
        onStep: setStep,
        onText: (d) => setAnalysis((a) => a + d),
        onSubmit: (accepted, message) => setLog((l) => [...l, `${accepted ? "✓" : "↻"} ${message}`]),
      });
      // 中断された・ダイアログが外れたあとに届いた結果では、今のモデルを置き換えない
      if (!mounted.current) return;
      if (ctl.signal.aborted) {
        setError("中断しました。");
        setStep(null);
        return;
      }
      useUntieStore.getState().newDocument(result.build.model);
      // 作成の会話を引き継いで、AI エージェントで続けられるようにする
      continueFrom(result.seed, [
        { role: "user", text: request },
        { role: "assistant", text: result.summary },
        { role: "info", text: "このまま会話を続けて、モデルを直せます。" },
      ]);
      onClose();
    } catch (e) {
      if (!mounted.current) return;
      setError(ctl.signal.aborted || isAbortError(e) ? "中断しました。" : describeChatError(e));
      setStep(null);
    } finally {
      if (controller.current === ctl) controller.current = null;
    }
  };

  return (
    <div className="dialog-backdrop" onKeyDown={(e) => e.key === "Escape" && !running && onClose()}>
      <div className="dialog prompt-dialog" role="dialog" aria-modal="true" aria-label="プロンプトから作成">
        <h2>プロンプトから作成</h2>
        <p className="hint">
          作りたい業務やシステムについての初期要望を書くと、AI が段階を踏んで分析し、業務・活動・作業・操作・情報などのモデルを作ります。今のモデルは置き換わります (保存はしません)。
        </p>
        <textarea
          aria-label="初期要望"
          className="prompt-input"
          placeholder={"例: 小さな旅館の予約から宿泊・精算までの業務。予約は電話と予約サイトで受け、フロント担当が予約台帳に手で書き写している。…"}
          value={request}
          rows={8}
          disabled={running}
          onChange={(e) => setRequest(e.target.value)}
        />
        <div className="prompt-ai">
          使う AI: {provider.label} ({model})
          <button type="button" className="link-plain context-apply" disabled={running} onClick={() => setSettingsOpen(true)}>
            変える
          </button>
        </div>
        {step && (
          <div className="prompt-progress">
            <div className="prompt-step" role="status">
              {STEP_LABELS[step]}
            </div>
            {analysis && <pre className="prompt-analysis">{analysis}</pre>}
            {log.map((l, i) => (
              <div key={i} className="prompt-log">
                {l}
              </div>
            ))}
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
          <button
            type="button"
            className={`primary${running ? " is-busy" : ""}`}
            disabled={running || !request.trim()}
            aria-busy={running}
            onClick={() => void start()}
          >
            {running && <span className="spinner" aria-hidden="true" />}
            {running ? "生成中…" : "作成"}
          </button>
        </div>
      </div>
    </div>
  );
}
