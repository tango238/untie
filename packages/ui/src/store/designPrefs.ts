// 設計モードの設定のうち、ファイルに入れず、このブラウザ (WebView) に覚えておくもの。

const LAST_SYSTEM_KEY = "untie.design.lastSystemId";

/** 最後に設計したシステムの id。覚えていなければ null (localStorage が使えなくても null) */
export function loadLastDesignSystemId(): string | null {
  try {
    return localStorage.getItem(LAST_SYSTEM_KEY);
  } catch {
    return null;
  }
}

export function saveLastDesignSystemId(systemId: string): void {
  try {
    localStorage.setItem(LAST_SYSTEM_KEY, systemId);
  } catch {
    // 覚えられなくても設計はできる
  }
}
