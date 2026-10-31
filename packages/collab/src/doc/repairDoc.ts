import type * as Y from "yjs";
import { repairModel } from "@untie/core";
import { applyModelDiff } from "./diff";
import { readModel } from "./rebuild";

/**
 * Y.Doc の壊れた参照を直す (サーバーだけが呼ぶ。設計書 6 章)。
 * readModel の結果に repairModel を当て、差分を origin 付きの 1 トランザクションで書き、直した内容 (changes) を返す。
 * 壊れていなければ何も書かず、空の配列を返す。
 * origin は "repair" のように、自分の書き込みを判別できる値にする (サーバーは origin が repair の update では再び修復を予約しない)。
 */
export function repairDoc(doc: Y.Doc, origin: unknown): string[] {
  const before = readModel(doc);
  const { model, changes } = repairModel(before);
  if (changes.length === 0) return [];
  applyModelDiff(doc, before, model, origin);
  return changes;
}
