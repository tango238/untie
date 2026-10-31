import type * as Y from "yjs";
import { repairModel } from "@untie/core";
import { applyModelDiff } from "./diff";
import { readRawModel } from "./rebuild";

/**
 * Y.Doc の壊れた参照を直す (サーバーだけが呼ぶ。設計書 6 章)。
 * readRawModel の結果に repairModel (壊れた参照の修復と、長すぎる文字列の切り詰め) を当て、差分を origin 付きの 1 トランザクションで書き、直した内容 (changes) を返す。
 * 壊れていなければ何も書かず、空の配列を返す。
 * origin は "repair" のように、自分の書き込みを判別できる値にする (サーバーは origin が repair の update では再び修復を予約しない)。
 */
export function repairDoc(doc: Y.Doc, origin: unknown): string[] {
  // 切り詰める前の中身から直す (切り詰めた結果との差分が Y.Doc に書かれる)
  const before = readRawModel(doc);
  const { model, changes } = repairModel(before);
  if (changes.length === 0) return [];
  applyModelDiff(doc, before, model, origin);
  return changes;
}
