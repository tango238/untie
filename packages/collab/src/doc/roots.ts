// Y.Doc のルートの名前と、各項目の型 (設計書 4.1)。名前はここ 1 か所に書き、ほかの場所では直接書かない。
import type * as Y from "yjs";
import type { EdgeSide } from "@untie/core";

/** Y.Doc のルートの Y.Map の名前 */
export const ROOT_NAMES = {
  meta: "meta",
  elements: "elements",
  relations: "relations",
  boards: "boards",
} as const;

/** 順序キーを入れる項目名 (要素・ボードは Y.Map のキー、関係・ノード・線は値の項目) */
export const ORDER_KEY = "order";

/** 関係の値。作ったあと変えないので JSON の値ごと置く。order は配列の順 */
export interface RelationRecord {
  kind: string;
  sourceId: string;
  targetId: string;
  order: string;
}

/** ボード上のノードの値。座標とサイズをまとめて 1 つの値にする (ドラッグの確定は 1 回の書き込み)。order は配列の順 */
export interface NodeRecord {
  x: number;
  y: number;
  width?: number;
  height?: number;
  order: string;
}

/** ボード上の線の見た目の値。order は配列の順 */
export interface EdgeRecord {
  sourceSide?: EdgeSide;
  targetSide?: EdgeSide;
  order: string;
}

/** Y.Doc のルート (型付きの見方) */
export interface UntieDocRoots {
  /** { name, description? } */
  meta: Y.Map<unknown>;
  /** 要素 id → Y.Map (kind, name, ..., order, analysis は入れ子の Y.Map) */
  elements: Y.Map<Y.Map<unknown>>;
  /** 関係 id → JSON の値 */
  relations: Y.Map<RelationRecord>;
  /** ボード id → Y.Map { name, order, nodes: Y.Map<elementId, NodeRecord>, edges: Y.Map<relationId, EdgeRecord> } */
  boards: Y.Map<Y.Map<unknown>>;
}

/** Y.Doc からルートを取り出す (無ければ作られる) */
export function getRoots(doc: Y.Doc): UntieDocRoots {
  return {
    meta: doc.getMap(ROOT_NAMES.meta),
    elements: doc.getMap(ROOT_NAMES.elements),
    relations: doc.getMap(ROOT_NAMES.relations),
    boards: doc.getMap(ROOT_NAMES.boards),
  };
}
