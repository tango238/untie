// JSON の値 (オブジェクト・配列・数・文字列・真偽・null) の比較と複製。
// Y.Doc に置く値と UntieModel の値はどちらも JSON なので、これで足りる。

/** 深い比較。値が undefined の項目は無いものとして扱う */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  let count = 0;
  for (const key of Object.keys(ra)) {
    if (ra[key] === undefined) continue;
    count++;
    if (!deepEqual(ra[key], rb[key])) return false;
  }
  for (const key of Object.keys(rb)) if (rb[key] !== undefined) count--;
  return count === 0;
}

/** 深い複製。Y.Doc に置く値とモデルの値で参照を共有しないために使う */
export function cloneJson<T>(value: T): T {
  if (typeof value !== "object" || value === null) return value;
  if (Array.isArray(value)) return value.map(cloneJson) as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = cloneJson(v);
  return out as T;
}
