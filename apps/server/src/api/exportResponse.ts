import type { UntieModel } from "@untie/core";

/** 書き出した JSON の整形 (ui の serializeModel と同じ: 2 スペース + 末尾の改行) */
export function serialize(model: UntieModel): string {
  return `${JSON.stringify(model, null, 2)}\n`;
}

/** RFC 5987 の attr-char 以外をパーセントエンコードする */
function encodeRfc5987(text: string): string {
  return encodeURIComponent(text).replace(/['()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** ファイル名に使えない文字を置き換える */
function safeFilename(name: string): string {
  // パスの区切り・制御文字 (U+007F を含む)・文字の並びを入れ替える方向制御文字 (U+200E/F、U+202A〜202E、U+2066〜2069) は置き換える
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "_").trim().slice(0, 100);
  return `${cleaned || "untie"}.json`;
}

/** モデルを JSON のダウンロード応答にする (メンバーの書き出しと、リンクの書き出しで共有) */
export function exportResponse(model: UntieModel): Response {
  const filename = safeFilename(model.meta.name);
  return new Response(serialize(model), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="untie.json"; filename*=UTF-8''${encodeRfc5987(filename)}`,
      "Cache-Control": "no-store",
    },
  });
}
