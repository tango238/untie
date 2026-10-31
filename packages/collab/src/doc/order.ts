// 配列の順番を表す順序キー (fractional index の文字列)。
// 配列は合流に向かないので、要素・関係・ボード・ノード・線のそれぞれに順序キーを持たせ、組み立てるときにキーで並べる (設計書 4.1)。
import { generateKeyBetween, generateNKeysBetween } from "fractional-indexing";

const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
/** 同時に同じ隙間へ足した 2 人のキーが同じにならないよう、キーの後ろに足す乱数の長さ */
const JITTER_LENGTH = 5;

/** キーの大小。文字コード順 (fractional-indexing と同じ。localeCompare は使わない) */
export function compareOrder(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** order の昇順、同じなら id の昇順 (どの端末でも同じ並びになる) */
export function compareByOrder(a: { order: string; id: string }, b: { order: string; id: string }): number {
  return compareOrder(a.order, b.order) || compareOrder(a.id, b.id);
}

/** fractional-indexing のキーとして正しい形か (壊れた update で不正な文字列が入りうる) */
function isValidKey(key: string): boolean {
  try {
    generateKeyBetween(key, null);
    return true;
  } catch {
    return false;
  }
}

/** 空の状態から n 件並べるときのキー (読み込み用。決まった値になる) */
export function initialOrders(n: number): string[] {
  return generateNKeysBetween(null, null, n);
}

/** lo より大きく hi より小さいまま、キーの後ろに乱数を足す。足せなければ元のキー */
function jitter(key: string, hi: string | null): string {
  let suffix = "";
  for (let i = 0; i < JITTER_LENGTH; i++) {
    // 末尾が '0' だとキーとして不正になる
    const from = i === JITTER_LENGTH - 1 ? 1 : 0;
    suffix += DIGITS[from + Math.floor(Math.random() * (DIGITS.length - from))];
  }
  const candidate = key + suffix;
  return hi === null || candidate < hi ? candidate : key;
}

/** 厳密に増えるキーの最長部分列の位置 (残すキー) */
function longestIncreasing(keys: readonly (string | undefined)[]): Set<number> {
  // tails[k] = 長さ k + 1 の増加列の末尾の位置。prev で列をたどる
  const tails: number[] = [];
  const prev: number[] = new Array(keys.length).fill(-1);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (key === undefined) continue;
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (compareOrder(keys[tails[mid]]!, key) < 0) lo = mid + 1;
      else hi = mid;
    }
    prev[i] = lo > 0 ? tails[lo - 1] : -1;
    tails[lo] = i;
  }
  const keep = new Set<number>();
  for (let i = tails.length > 0 ? tails[tails.length - 1] : -1; i >= 0; i = prev[i]) keep.add(i);
  return keep;
}

/**
 * desired (並べたい id の列) を満たすために、新しく振るキーを決める。
 * existing(id) は Y.Doc にすでにあるキー。戻り値には「キーが無い id」と「並びを満たすために振り直す id」だけが入る。
 * 厳密に増えている最長の列は動かさず、そのほかの id にだけ前後のキーの間の値を振る (振り直しは最小限)。
 */
export function planOrders(desired: readonly string[], existing: (id: string) => string | undefined): Map<string, string> {
  const result = new Map<string, string>();
  // 形の不正なキーは「キーが無い」ものとして振り直す (先に検出するので、生成の途中で例外にならない)
  const keys = desired.map((id) => {
    const key = existing(id);
    return key !== undefined && isValidKey(key) ? key : undefined;
  });
  const keep = longestIncreasing(keys);
  if (keep.size === desired.length) return result;
  let i = 0;
  while (i < desired.length) {
    if (keep.has(i)) {
      i++;
      continue;
    }
    // keep されていない連続した区間 [i, j) に、前後の keep のキーの間の値を振る
    let j = i;
    while (j < desired.length && !keep.has(j)) j++;
    const lo = i > 0 ? keys[i - 1]! : null;
    const hi = j < desired.length ? keys[j]! : null;
    const base = generateNKeysBetween(lo, hi, j - i);
    for (let k = 0; k < base.length; k++) {
      // 次のキーを超えないこと (区間の最後は hi を超えないこと)
      result.set(desired[i + k], jitter(base[k], k + 1 < base.length ? base[k + 1] : hi));
    }
    i = j;
  }
  return result;
}
