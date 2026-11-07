// 画面 UI (view。mokkun v2 の ViewV2) を、単体で mokkun の検証 (parseV2Document) に通す。
// mokkun を読み込むので、このファイルは遅延読み込みする側 (画面ボード・AI の生成) から静的に、そのほかからは import() で使う。
import { parseV2Document } from "mokkun";

export type ViewCheck = { ok: true } | { ok: false; message: string };

/** 遷移先 (to) の検証に使う、中身の無い仮の view */
const STUB = { title: "-", goal: "-", sections: [{ id: "stub", title: "-", kind: "readonly", note: "-" }] };

/**
 * view を 1 つの文書に包んで検証する。包み方は `{ mokkun: 2, app: { name }, views: { <selfId>: view } }` で、
 * 遷移先 (to) が通るよう、設計のほかの画面 (otherIds) は仮の view として並べる。
 * 理由は最初の 5 件を `path: message` で並べる (path の `views.<id>.` は省く)
 */
export function validateView(view: unknown, selfId: string, otherIds: readonly string[]): ViewCheck {
  const views: Record<string, unknown> = {};
  for (const id of otherIds) views[id] = STUB;
  views[selfId] = view;
  const r = parseV2Document({ mokkun: 2, app: { name: "画面" }, views });
  if (r.success) return { ok: true };
  const prefix = `views.${selfId}`;
  const shown = r.errors.slice(0, 5).map((e) => {
    const path = (e.path ?? "").startsWith(prefix) ? (e.path ?? "").slice(prefix.length).replace(/^\./, "") : (e.path ?? "");
    return path ? `${path}: ${e.message}` : e.message;
  });
  return { ok: false, message: `${shown.join(" / ")}${r.errors.length > 5 ? ` (ほか ${r.errors.length - 5} 件)` : ""}` };
}
