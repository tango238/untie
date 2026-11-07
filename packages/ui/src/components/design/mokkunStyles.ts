import { MOKKUN_V2_CSS } from "mokkun";

let cached: string | undefined;

/**
 * mokkun v2 の描画に必要な CSS (DADS のスタイルと v2 のスタイル) の文字列。
 *
 * mokkun 0.2.2 が `MOKKUN_V2_CSS` として公開している文字列をそのまま使う (`mokkun/style.css` は v1 用で v2 のスタイルを含まない)。
 * DADS の CSS は html・a・:focus-visible などの要素セレクタを含むので親の画面には差さず、iframe の srcdoc の `<style>` に入れる。
 * 先頭に Google Fonts の `@import` が入っている。CSP (font-src / style-src) に反し、ローカル専用の Web 版でも外部へ通信してしまうので、
 * `@import` はすべて取り除く (フォントは端末のものに落ちる)。1 回だけ作って使い回す
 */
export function mokkunCss(): string {
  if (cached === undefined) cached = MOKKUN_V2_CSS.replace(/@import\s*(?:url\([^)]*\)|"[^"]*"|'[^']*')[^;{}]*;/g, "");
  return cached;
}
