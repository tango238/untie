import { useEffect, useRef, useState } from "react";
import { useAgentStore } from "../../ai/agentStore";
import { HEARING_ANSWERER_LABELS, HEARING_SUMMARY_REQUEST } from "../../ai/hearing";
import { PROVIDERS } from "../../ai/providers";
import { useUntieStore } from "../../store";

/** 下のペイン: AI エージェントとの会話。編集中のモデルを自然言語で直す。課題の深掘り・困りごとのヒアリング・ドメインモデルの対話もここで行う */
export function AgentPane() {
  const items = useAgentStore((s) => s.items);
  const running = useAgentStore((s) => s.running);
  const settings = useAgentStore((s) => s.settings);
  const mode = useAgentStore((s) => s.mode);
  const send = useAgentStore((s) => s.send);
  const cancel = useAgentStore((s) => s.cancel);
  const newConversation = useAgentStore((s) => s.newConversation);
  const endGrill = useAgentStore((s) => s.endGrill);
  const endHearing = useAgentStore((s) => s.endHearing);
  const endDomainTalk = useAgentStore((s) => s.endDomainTalk);
  const setOpen = useAgentStore((s) => s.setOpen);
  const setSettingsOpen = useAgentStore((s) => s.setSettingsOpen);
  const grillIssue = useUntieStore((s) => (mode.kind === "grill" ? s.model.elements.find((e) => e.id === mode.issueId) : undefined));
  const hearingActor = useUntieStore((s) => (mode.kind === "hearing" ? s.model.elements.find((e) => e.id === mode.actorId) : undefined));
  const domainSystem = useUntieStore((s) => (mode.kind === "domain" ? s.model.elements.find((e) => e.id === mode.systemId) : undefined));
  const [text, setText] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const provider = PROVIDERS[settings.provider];
  const model = settings.models[settings.provider] || provider.defaultModel;

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [items]);

  const submit = () => {
    if (!text.trim() || running) return;
    void send(text);
    setText("");
  };

  return (
    <section className="agent-pane" aria-label="AI エージェント">
      <header className="agent-head">
        <h2 className="agent-title">
          {mode.kind === "grill" ? (
            <>
              課題を深掘り: <span className="agent-grill-issue">「{grillIssue?.name || (grillIssue ? "(名前なし)" : "(削除された課題)")}」</span>
            </>
          ) : mode.kind === "hearing" ? (
            <>
              ヒアリング:{" "}
              <span className="agent-grill-issue">
                「{hearingActor?.name || (hearingActor ? "(名前なし)" : "(削除されたアクター)")}」({HEARING_ANSWERER_LABELS[mode.answerer]})
              </span>
            </>
          ) : mode.kind === "domain" ? (
            <>
              ドメインモデルを決める: <span className="agent-grill-issue">「{domainSystem?.name || (domainSystem ? "(名前なし)" : "(削除されたシステム)")}」</span>
            </>
          ) : (
            "AI エージェント"
          )}
        </h2>
        <button type="button" className="link-plain agent-model" title="AI の設定を開く" onClick={() => setSettingsOpen(true)}>
          {provider.label} ({model}) ▾
        </button>
        <span className="agent-spacer" />
        {mode.kind === "grill" ? (
          <button type="button" onClick={endGrill}>
            深掘りを終える
          </button>
        ) : mode.kind === "hearing" ? (
          <>
            <button type="button" onClick={() => void send(HEARING_SUMMARY_REQUEST)} disabled={running}>
              まとめる
            </button>
            <button type="button" onClick={endHearing}>
              ヒアリングを終える
            </button>
          </>
        ) : mode.kind === "domain" ? (
          <button type="button" onClick={endDomainTalk}>
            対話を終える
          </button>
        ) : (
          <button type="button" onClick={newConversation} disabled={running || items.length === 0}>
            新しい会話
          </button>
        )}
        <button type="button" className="icon-button" aria-label="AI エージェントを閉じる" onClick={() => setOpen(false)}>
          ×
        </button>
      </header>
      <div className="agent-list" ref={listRef} role="log" aria-live="polite">
        {items.length === 0 ? (
          <p className="hint agent-empty">
            編集中のモデルを、会話で直せます。例: 「チェックインの業務に、宿泊客が自分で受付する作業を足して」「担当のいない作業に担当を付けて」。AI
            が変えた内容は 1 回の返答ごとに元に戻す (Undo) でまとめて戻せます。
          </p>
        ) : (
          items.map((item) => (
            <div key={item.id} className={`agent-item is-${item.role}${item.ok === false ? " is-failed" : ""}`}>
              {item.role === "tool" ? (
                <span>
                  {item.ok === false ? "⚠" : "🔧"} {item.text}
                  {item.ok === false ? " (失敗)" : ""}
                </span>
              ) : (
                item.text
              )}
            </div>
          ))
        )}
        {running && <div className="agent-item is-running">考えています…</div>}
      </div>
      <div className="agent-input">
        <textarea
          aria-label="AI への依頼"
          placeholder={
            mode.kind === "grill" || mode.kind === "domain"
              ? "質問に答えて Enter で送信 (Shift+Enter で改行)。「はい」で推奨を採ります"
              : mode.kind === "hearing"
                ? mode.answerer === "persona"
                  ? "ペルソナに質問して Enter で送信 (Shift+Enter で改行)"
                  : "質問に答えて Enter で送信 (Shift+Enter で改行)。「はい」で推奨を採ります"
                : "依頼を書いて Enter で送信 (Shift+Enter で改行)"
          }
          value={text}
          rows={2}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
        />
        {running ? (
          <button type="button" onClick={cancel}>
            中断
          </button>
        ) : (
          <button type="button" className="primary" onClick={submit} disabled={!text.trim()}>
            送信
          </button>
        )}
      </div>
    </section>
  );
}
