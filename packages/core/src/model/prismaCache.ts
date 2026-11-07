import { parsePrismaDsl, type PrismaSchema } from "./prisma";

const MAX_ENTRIES = 8;
const cache = new Map<string, PrismaSchema>();

/**
 * DSL の解析結果。直近の数件 (文字列をキーにした小さな LRU) を覚え、同じ文字列なら解析し直さない。
 * 画面の描画や検証が、同じ DSL を何度も読まないようにするためのもの (結果は書き換えない)
 */
export function parsePrismaDslCached(dsl: string): PrismaSchema {
  const hit = cache.get(dsl);
  if (hit) {
    // 使ったものを末尾に回す
    cache.delete(dsl);
    cache.set(dsl, hit);
    return hit;
  }
  const schema = parsePrismaDsl(dsl);
  cache.set(dsl, schema);
  if (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value!);
  return schema;
}
