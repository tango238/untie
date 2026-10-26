// AI のプロバイダー (Claude / Codex / Gemini) の設定。API キーは OS のキーチェーンに置き、ここには持たない。

export const PROVIDER_IDS = ["claude", "codex", "gemini"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export interface ProviderInfo {
  label: string;
  /** API を提供する会社 */
  vendor: string;
  /** 既定のモデル */
  defaultModel: string;
  /** 選択肢として出すモデル (自由入力もできる) */
  models: string[];
  /** API キーの取得先 */
  keyUrl: string;
}

export const PROVIDERS: Record<ProviderId, ProviderInfo> = {
  claude: {
    label: "Claude",
    vendor: "Anthropic",
    defaultModel: "claude-opus-5-5",
    models: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
    keyUrl: "https://platform.claude.com/settings/keys",
  },
  codex: {
    label: "Codex",
    vendor: "OpenAI",
    defaultModel: "gpt-5-codex",
    models: ["gpt-5-codex"],
    keyUrl: "https://platform.openai.com/api-keys",
  },
  gemini: {
    label: "Gemini",
    vendor: "Google",
    defaultModel: "gemini-2.5-pro",
    models: ["gemini-2.5-pro", "gemini-2.5-flash"],
    keyUrl: "https://aistudio.google.com/apikey",
  },
};

export interface AiSettings {
  provider: ProviderId;
  /** プロバイダーごとに選んだモデル */
  models: Record<ProviderId, string>;
}

const SETTINGS_KEY = "untie.ai.settings";

export function defaultAiSettings(): AiSettings {
  return {
    provider: "claude",
    models: { claude: PROVIDERS.claude.defaultModel, codex: PROVIDERS.codex.defaultModel, gemini: PROVIDERS.gemini.defaultModel },
  };
}

/** 端末ごとの設定 (プロバイダーとモデル)。読めなければ既定値 */
export function loadAiSettings(): AiSettings {
  const base = defaultAiSettings();
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return base;
    const parsed = JSON.parse(raw) as Partial<AiSettings>;
    const provider = PROVIDER_IDS.includes(parsed.provider as ProviderId) ? (parsed.provider as ProviderId) : base.provider;
    return { provider, models: { ...base.models, ...(parsed.models ?? {}) } };
  } catch {
    return base;
  }
}

export function saveAiSettings(settings: AiSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // 保存できなくても動作には困らない (次回は既定値で開く)
  }
}
