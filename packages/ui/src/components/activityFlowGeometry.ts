// 作業ボードで、作業のカードどうしをつなぐ線の形。DOM に触れない純粋関数だけを置く。

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface LinkShape {
  /** SVG の path (3 次ベジェ) */
  d: string;
  start: Point;
  end: Point;
  /** 線の真ん中 (消すボタンを置く) */
  mid: Point;
}

const OFFSET_MIN = 24;

function cubicAt(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const u = 1 - t;
  return {
    x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
  };
}

/** 線の端を、右の辺の丸 (引き始める丸) より外へ出す幅 */
const GAP = 9;
/** 同じ列のカードどうしをつなぐ線が、右へふくらむ幅 */
const LOOP = 28;

/**
 * 前の作業 a から次の作業 b への線。同じ列で上下に離れていれば縦の直線。そうでなければ a の右の辺の真ん中から出る。
 * 同じ列 (横の範囲が重なる) なら、カードの文字に重ならないよう右へふくらませて b の右の辺へ戻し、そうでなければ b の左右の辺へつなぐ
 */
export function linkShape(a: Box, b: Box): LinkShape {
  const sameColumn = a.x < b.x + b.w && b.x < a.x + a.w;
  // 同じ列で上下に離れているなら、まっすぐ縦の矢印 (行をまたぐ線。外部アクターのイベント → 作業、作業 → システム)
  if (sameColumn && (a.y + a.h <= b.y || b.y + b.h <= a.y)) {
    const x = (Math.max(a.x, b.x) + Math.min(a.x + a.w, b.x + b.w)) / 2;
    const down = a.y + a.h <= b.y;
    const start: Point = { x, y: down ? a.y + a.h : a.y };
    const end: Point = { x, y: down ? b.y : b.y + b.h };
    const f = (n: number) => Math.round(n * 10) / 10;
    return { d: `M ${f(start.x)} ${f(start.y)} L ${f(end.x)} ${f(end.y)}`, start, end, mid: { x, y: (start.y + end.y) / 2 } };
  }
  const start: Point = { x: a.x + a.w, y: a.y + a.h / 2 };
  let end: Point;
  let c1: Point;
  let c2: Point;
  if (sameColumn) {
    end = { x: b.x + b.w + GAP, y: b.y + b.h / 2 };
    const out = Math.max(start.x, end.x) + LOOP;
    c1 = { x: out, y: start.y };
    c2 = { x: out, y: end.y };
  } else {
    const right = b.x >= a.x;
    end = { x: right ? b.x : b.x + b.w + GAP, y: b.y + b.h / 2 };
    const off = Math.max(OFFSET_MIN, Math.abs(end.x - start.x) / 2) * (right ? 1 : -1);
    c1 = { x: start.x + off, y: start.y };
    c2 = { x: end.x - off, y: end.y };
  }
  const f = (n: number) => Math.round(n * 10) / 10;
  return {
    d: `M ${f(start.x)} ${f(start.y)} C ${f(c1.x)} ${f(c1.y)}, ${f(c2.x)} ${f(c2.y)}, ${f(end.x)} ${f(end.y)}`,
    start,
    end,
    mid: cubicAt(start, c1, c2, end, 0.5),
  };
}

/** 点が箱の中にあるか */
export function contains(box: Box, p: Point): boolean {
  return p.x >= box.x && p.x <= box.x + box.w && p.y >= box.y && p.y <= box.y + box.h;
}
