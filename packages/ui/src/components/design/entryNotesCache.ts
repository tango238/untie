import { entryNotes } from "@untie/core/model/sitemap";
import type { SystemDesign, UntieModel } from "@untie/core/model/types";

const cache = new WeakMap<SystemDesign, { model: UntieModel; notes: Map<string, string[]> }>();

/**
 * 入口の画面と注記 (entryNotes)。モデルと設計だけで決まるので、選択が変わっても計算し直さない。
 * 中央の図と右のペインが同じ結果を使う (設計の参照とモデルが同じなら使い回す)
 */
export function cachedEntryNotes(model: UntieModel, systemId: string, design: SystemDesign): Map<string, string[]> {
  const hit = cache.get(design);
  if (hit && hit.model === model) return hit.notes;
  const notes = entryNotes(model, systemId, design);
  cache.set(design, { model, notes });
  return notes;
}
