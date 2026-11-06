/**
 * スマートフォン向けのレイアウトに切り替える幅。app.css の `@media (max-width: 768px)` と同じ値にそろえる。
 * この幅以下では、左右のペインを画面の上に重ねるドロワーにして、ツールバーのボタンで開閉する
 */
export const MOBILE_MAX_WIDTH = 768;

/** いま、スマートフォン向けのレイアウトになる幅か (matchMedia が無い環境では false) */
export function isNarrowViewport(): boolean {
  try {
    return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(`(max-width: ${MOBILE_MAX_WIDTH}px)`).matches;
  } catch {
    return false;
  }
}
