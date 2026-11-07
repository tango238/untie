import { mountViewV2, type MokkunV2Schema } from "mokkun";

let cached: string | undefined;

/**
 * mokkun v2 の描画に必要な CSS (DADS のスタイルと v2 のスタイル) の文字列。
 *
 * この CSS は mokkun の npm パッケージの CSS ファイル (`mokkun/style.css` は v1 用で v2 のスタイルを含まない) には入っておらず、
 * ライブラリの中に文字列として埋め込まれていて、mountViewV2 が描いている間だけ document の `<style id="mokkun-v2-styles">` に差し込まれる
 * (holdV2Styles は公開されていない)。DADS の CSS は html・a・:focus-visible などの要素セレクタを含むので、親の画面に差したままにはできない。
 * そこで、見えない一時の要素に最小の文書を mount して差し込まれた `<style>` を読み、すぐ destroy で外す (同期なので画面には出ない)。
 * 読んだ CSS から `@import` を取り除き (外部のフォントを読みにいくため)、iframe の srcdoc に入れる。1 回だけ作って使い回す
 */
export function mokkunCss(): string {
  if (cached !== undefined) return cached;
  let css = "";
  if (typeof document !== "undefined") {
    const holder = document.createElement("div");
    const schema: MokkunV2Schema = { mokkun: 2, app: { name: "x", layout: "plain" }, views: { v: { title: "x", goal: "x", sections: [{ id: "s", title: "x", kind: "readonly", note: "x" }] } } };
    try {
      const controller = mountViewV2(holder, schema, "v");
      css = document.getElementById("mokkun-v2-styles")?.textContent ?? "";
      controller.destroy();
    } catch {
      css = "";
    }
  }
  // CSS に Google Fonts の @import が入っている。CSP (font-src / style-src) に反し、ローカル専用の Web 版でも外部へ通信してしまうので、@import はすべて取り除く
  // (フォントは端末のものに落ちる)
  css = css.replace(/@import\s*(?:url\([^)]*\)|"[^"]*"|'[^']*')[^;{}]*;/g, "");
  // 読めなかったとき (一時的な失敗) は覚えない
  if (css !== "") cached = css;
  return css;
}
