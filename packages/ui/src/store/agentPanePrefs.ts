// AI エージェントのペイン (下のペイン) の高さ。ファイルに入れず、このブラウザ (WebView) に覚えておく。

const HEIGHT_KEY = "untie.agent.paneHeight";

/** ペインの高さの下限 (px)。見出しと入力欄が収まる高さ */
export const AGENT_PANE_MIN_HEIGHT = 120;
/** ペインより上に残す高さ (px)。ツールバーとキャンバスの一部を必ず残す */
export const AGENT_PANE_KEEP_ABOVE = 160;

/** 高さを、下限と「画面の高さ − 上に残す高さ」の間に収める */
export function clampAgentPaneHeight(height: number, viewportHeight: number): number {
  const max = Math.max(AGENT_PANE_MIN_HEIGHT, viewportHeight - AGENT_PANE_KEEP_ABOVE);
  return Math.round(Math.min(max, Math.max(AGENT_PANE_MIN_HEIGHT, height)));
}

/** 覚えている高さ。覚えていなければ null (既定の高さは CSS に任せる。localStorage が使えなくても null) */
export function loadAgentPaneHeight(): number | null {
  try {
    const raw = localStorage.getItem(HEIGHT_KEY);
    const n = raw === null ? NaN : Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** 高さを覚える。null で忘れる (既定の高さに戻す) */
export function saveAgentPaneHeight(height: number | null): void {
  try {
    if (height === null) localStorage.removeItem(HEIGHT_KEY);
    else localStorage.setItem(HEIGHT_KEY, String(height));
  } catch {
    // 覚えられなくても大きさは変えられる
  }
}
