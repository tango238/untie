import type * as Y from "yjs";
import { migrateDerivedPlacement, repairModel } from "@untie/core";
import type { UntieModel } from "@untie/core";
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
  // 知らせなしで直すもの (全項目が空のペルソナ) もあるので、changes ではなくモデルが変わったかで見る
  if (model === before) return [];
  applyModelDiff(doc, before, model, origin);
  return changes;
}

/**
 * 0.3.0 までに保存した Y.Doc に残っている旧関係 (systemInformation・informationSystem・screenInformation) を、
 * 取得・保存の区別 (usecaseInformation の access) に移してから外す (サーバーが復元した直後に 1 回呼ぶ)。
 * JSON ファイルを開くときの変換 (migrateDerivedPlacement) と同じ規則。readRawModel は常に現行の版を付けるので、
 * これを呼ばずに repairDoc を当てると、旧関係は「結べない関係」として消えるだけで、access に移せない。
 * 旧関係が無ければ何も書かず、空の配列を返す。変換で知らせることがあれば (導けず消える置き場所の件数など) notes を返す。
 */
export function migrateDocPlacement(doc: Y.Doc, origin: unknown): string[] {
  const before = readRawModel(doc);
  const notes: string[] = [];
  const after = migrateDerivedPlacement(before as unknown as Record<string, unknown>, notes) as unknown as UntieModel;
  if (after === before) return [];
  applyModelDiff(doc, before, after, origin);
  return notes;
}
