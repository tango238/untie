import { MOKKUN_V2_CSS } from "mokkun";

let cached: string | undefined;

/**
 * mokkun は view の goal (必須) を見出しの上 (`.dads-heading__shoulder`) に必ず描く。
 * untie では goal を画面には出さず、画面ボードの右のペインで編集するので、プレビューでは隠す (mokkun は変えず、CSS で隠す)
 */
const HIDE_GOAL_CSS = "\n.mokkun-v2 .mk2-view-head .dads-heading__shoulder { display: none; }\n";

/**
 * mokkun v2 の描画に必要な CSS (DADS のスタイルと v2 のスタイル) の文字列。
 *
 * mokkun 0.2.2 が `MOKKUN_V2_CSS` として公開している文字列をそのまま使う (`mokkun/style.css` は v1 用で v2 のスタイルを含まない)。
 * DADS の CSS は html・a・:focus-visible などの要素セレクタを含むので親の画面には差さず、iframe の srcdoc の `<style>` に入れる。
 * 先頭に Google Fonts の `@import` が入っている。CSP (font-src / style-src) に反し、ローカル専用の Web 版でも外部へ通信してしまうので、
 * `@import` はすべて取り除く (フォントは端末のものに落ちる)。1 回だけ作って使い回す
 */
export function mokkunCss(): string {
  if (cached === undefined) cached = MOKKUN_V2_CSS.replace(/@import\s*(?:url\([^)]*\)|"[^"]*"|'[^']*')[^;{}]*;/g, "") + HIDE_GOAL_CSS;
  return cached;
}
