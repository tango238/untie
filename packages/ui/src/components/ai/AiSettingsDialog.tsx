import { useEffect, useState } from "react";
import { useAgentStore } from "../../ai/agentStore";
import { deleteApiKey, getApiKey, isApiKeyRemembered, setApiKey } from "../../ai/keys";
import { PROVIDER_IDS, PROVIDERS, type ProviderId } from "../../ai/providers";
import { copyText } from "../../io/clipboard";
import { getPlatform } from "../../platform";
import { useUntieStore } from "../../store";

/** AI の設定: 使うプロバイダーとモデル、プロバイダーごとの API キー (アプリは OS のキーチェーン、ブラウザはタブの間かこのブラウザに保存) */
export function AiSettingsDialog() {
  const settings = useAgentStore((s) => s.settings);
  const updateSettings = useAgentStore((s) => s.updateSettings);
  const setSettingsOpen = useAgentStore((s) => s.setSettingsOpen);
  const pushToast = useUntieStore((s) => s.pushToast);
  const [provider, setProvider] = useState<ProviderId>(settings.provider);
  const [models, setModels] = useState(settings.models);
  const [keyInput, setKeyInput] = useState("");
  const [hasKey, setHasKey] = useState<Record<ProviderId, boolean>>({ claude: false, codex: false, gemini: false });
  // キーチェーンから読めなかったときの理由 (保存されていないのとは分けて出す)
  const [readError, setReadError] = useState<Partial<Record<ProviderId, string>>>({});
  // ブラウザだけ: API キーをこのブラウザに保存するか (しなければタブを閉じるまで)
  const platform = getPlatform();
  const browser = platform.kind === "web";
  const [remember, setRemember] = useState<Record<ProviderId, boolean>>(
    () => Object.fromEntries(PROVIDER_IDS.map((p) => [p, isApiKeyRemembered(p)])) as Record<ProviderId, boolean>,
  );

  useEffect(() => {
    void Promise.all(
      PROVIDER_IDS.map(async (p) => {
        try {
          return [p, !!(await getApiKey(p)), undefined] as const;
        } catch (e) {
          return [p, false, String(e)] as const;
        }
      }),
    ).then((rows) => {
      setHasKey(Object.fromEntries(rows.map(([p, has]) => [p, has])) as Record<ProviderId, boolean>);
      setReadError(Object.fromEntries(rows.filter(([, , err]) => err).map(([p, , err]) => [p, err])));
    });
  }, []);

  const close = () => setSettingsOpen(false);
  const info = PROVIDERS[provider];

  const saveKey = async () => {
    const key = keyInput.trim();
    if (!key) return;
    try {
      await setApiKey(provider, key, { remember: remember[provider] });
      setHasKey((h) => ({ ...h, [provider]: true }));
      setReadError((r) => ({ ...r, [provider]: undefined }));
      setKeyInput("");
      pushToast(`${info.label} の API キーを保存しました`, "info");
    } catch (e) {
      pushToast(String(e), "error");
    }
  };
  // 保存済みのキーがあれば、チェックを変えたときにすぐ置き場所を変える
  const changeRemember = async (checked: boolean) => {
    setRemember((r) => ({ ...r, [provider]: checked }));
    if (!hasKey[provider]) return;
    try {
      const key = await getApiKey(provider);
      if (key) await setApiKey(provider, key, { remember: checked });
    } catch (e) {
      setRemember((r) => ({ ...r, [provider]: false }));
      pushToast(String(e), "error");
    }
  };
  const removeKey = async () => {
    try {
      await deleteApiKey(provider);
      setHasKey((h) => ({ ...h, [provider]: false }));
      setRemember((r) => ({ ...r, [provider]: false }));
      setReadError((r) => ({ ...r, [provider]: undefined }));
      pushToast(`${info.label} の API キーを消しました`, "info");
    } catch (e) {
      pushToast(String(e), "error");
    }
  };

  const openKeyPage = async () => {
    try {
      await platform.openExternalUrl(info.keyUrl);
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
            {info.label} の API キー {readError[provider]
              ? "(読み出せません)"
              : !hasKey[provider]
                ? "(未設定)"
                : browser
                  ? remember[provider]
                    ? "(このブラウザに保存済み)"
                    : "(このタブを閉じるまで)"
                  : "(保存済み)"}
          </span>
          {readError[provider] && (
            <p className="field-error" role="alert">
              キーチェーンに保存した API キーを読み出せませんでした。アプリを作り直したときなど、保存したときと署名が変わると読めなくなります。
              もう一度保存してください (前のキーを置き換えます)。詳細: {readError[provider]}
            </p>
          )}
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
          {browser && (
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={remember[provider]}
                onChange={(e) => void changeRemember(e.target.checked)}
              />
              このブラウザに保存する (次に開いたときも使える)
            </label>
          )}
          <p className="hint">
            {browser
              ? "保存しなければ、このタブを閉じるまでだけ覚えます。共用のパソコンでは保存しないでください。API キーはこのブラウザから各社の API に直接送るだけで、Untie のサーバーには送りません。"
              : "API キーはこのパソコンのキーチェーンに保存します。業務モデルのファイルには含まれません。"}
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
