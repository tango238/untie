import { useEffect, useState } from "react";
import { useAgentStore } from "../../ai/agentStore";
import { deleteApiKey, getApiKey, setApiKey } from "../../ai/keys";
import { PROVIDER_IDS, PROVIDERS, type ProviderId } from "../../ai/providers";
import { copyText, isTauri, openExternalUrl } from "../../io/file";
import { useUntieStore } from "../../store";

/** AI の設定: 使うプロバイダーとモデル、プロバイダーごとの API キー (OS のキーチェーンに保存) */
export function AiSettingsDialog() {
  const settings = useAgentStore((s) => s.settings);
  const updateSettings = useAgentStore((s) => s.updateSettings);
  const setSettingsOpen = useAgentStore((s) => s.setSettingsOpen);
  const pushToast = useUntieStore((s) => s.pushToast);
  const [provider, setProvider] = useState<ProviderId>(settings.provider);
  const [models, setModels] = useState(settings.models);
  const [keyInput, setKeyInput] = useState("");
  const [hasKey, setHasKey] = useState<Record<ProviderId, boolean>>({ claude: false, codex: false, gemini: false });

  useEffect(() => {
    void Promise.all(PROVIDER_IDS.map(async (p) => [p, !!(await getApiKey(p).catch(() => null))] as const)).then((pairs) =>
      setHasKey(Object.fromEntries(pairs) as Record<ProviderId, boolean>),
    );
  }, []);

  const close = () => setSettingsOpen(false);
  const info = PROVIDERS[provider];

  const saveKey = async () => {
    const key = keyInput.trim();
    if (!key) return;
    try {
      await setApiKey(provider, key);
      setHasKey((h) => ({ ...h, [provider]: true }));
      setKeyInput("");
      pushToast(`${info.label} の API キーを保存しました`, "info");
    } catch (e) {
      pushToast(String(e), "error");
    }
  };
  const removeKey = async () => {
    try {
      await deleteApiKey(provider);
      setHasKey((h) => ({ ...h, [provider]: false }));
      pushToast(`${info.label} の API キーを消しました`, "info");
    } catch (e) {
      pushToast(String(e), "error");
    }
  };

  const openKeyPage = async () => {
    try {
      await openExternalUrl(info.keyUrl);
    } catch (e) {
      pushToast(`開けませんでした。URL をコピーしてブラウザで開いてください: ${String(e)}`, "error");
    }
  };
  const copyKeyUrl = async () => {
    try {
      await copyText(info.keyUrl);
      pushToast("URL をコピーしました", "info");
    } catch {
      pushToast("コピーできませんでした。URL を選んでコピーしてください", "error");
    }
  };

  return (
    <div className="dialog-backdrop" onKeyDown={(e) => e.key === "Escape" && close()}>
      <div className="dialog ai-dialog" role="dialog" aria-modal="true" aria-label="AI の設定">
        <h2>AI の設定</h2>
        <label className="field">
          <span className="field-label">使う AI</span>
          <select aria-label="使う AI" value={provider} onChange={(e) => setProvider(e.target.value as ProviderId)}>
            {PROVIDER_IDS.map((p) => (
              <option key={p} value={p}>
                {PROVIDERS[p].label} ({PROVIDERS[p].vendor})
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">モデル</span>
          <input
            aria-label="モデル"
            list={`models-${provider}`}
            value={models[provider]}
            onChange={(e) => setModels({ ...models, [provider]: e.target.value })}
          />
          <datalist id={`models-${provider}`}>
            {info.models.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </label>
        <div className="field">
          <span className="field-label">
            {info.label} の API キー {hasKey[provider] ? "(保存済み)" : "(未設定)"}
          </span>
          <div className="inline-add">
            <input
              aria-label="API キー"
              type="password"
              autoComplete="off"
              placeholder={hasKey[provider] ? "入れ直すときだけ入力" : "API キーを貼り付け"}
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
            />
            <button type="button" onClick={() => void saveKey()} disabled={!keyInput.trim()}>
              保存
            </button>
            {hasKey[provider] && (
              <button type="button" onClick={() => void removeKey()}>
                消す
              </button>
            )}
          </div>
          <p className="hint">
            {isTauri() ? "API キーはこのパソコンのキーチェーンに保存します。業務モデルのファイルには含まれません。" : "ブラウザでは、このタブを閉じるまでだけ API キーを覚えます。"}
            <button type="button" className="link-plain context-apply" onClick={() => void openKeyPage()}>
              {info.vendor} のサイトで API キーを発行する
            </button>
          </p>
          <div className="inline-add key-url">
            <input aria-label="API キーを発行するページの URL" readOnly value={info.keyUrl} onFocus={(e) => e.target.select()} />
            <button type="button" onClick={() => void copyKeyUrl()}>
              URL をコピー
            </button>
          </div>
        </div>
        <div className="dialog-actions">
          <button type="button" onClick={close}>
            キャンセル
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => {
              updateSettings({ provider, models });
              close();
            }}
          >
            この設定を使う
          </button>
        </div>
      </div>
    </div>
  );
}
