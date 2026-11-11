// Y.Doc のルートの名前と、各項目の型 (設計書 4.1)。名前はここ 1 か所に書き、ほかの場所では直接書かない。
import type * as Y from "yjs";
import type { EdgeSide } from "@untie/core";

/** Y.Doc のルートの Y.Map の名前 */
export const ROOT_NAMES = {
  meta: "meta",
  elements: "elements",
  relations: "relations",
  boards: "boards",
  designs: "designs",
  designScreens: "designScreens",
  designTransitions: "designTransitions",
  designNav: "designNav",
  databases: "databases",
  domain: "domain",
} as const;

/** 順序キーを入れる項目名 (要素・ボードは Y.Map のキー、関係・ノード・線は値の項目) */
export const ORDER_KEY = "order";

/** 関係の値。JSON の値ごと置く (access を変えるときも値ごと置き直す)。order は配列の順 */
export interface RelationRecord {
  kind: string;
  sourceId: string;
  targetId: string;
  /** 操作が情報をどう扱うか (usecaseInformation だけ。read / write。無ければ取得も保存も) */
  access?: string;
  /** 代替パターン (usecaseCondition だけ。0.6.1。エラーの種類は 0.6.2)。値ごと置く */
  alternate?: { when: string; then: string; eventId?: string; error?: { type: string; status?: number } };
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

// 設計データ (0.5.0) は、入れ子の Y.Map を使わず、ルートごとに平らな「キー → JSON の値」で置く。
// 決まったキーに Y.Map を新しく set する作りだと、2 人が同時に作ったときに片方が丸ごと消える (後から作った Y.Map ごと負ける)。
// 値だけなら、別々のキーに足したものは両方残り、同じキーへの同時の書き込みは後勝ちで 1 つになる。

/** `${systemId}/meta` の値。設計があるかは、このキーの有無で決める */
export interface DesignMetaRecord {
  databaseIds: string[];
  order: string;
}

/** `${systemId}/layout` の値。ナビゲーション以外のレイアウト (ナビのグループは designNav に別のキーで置く) */
export interface DesignLayoutRecord {
  shell: string;
  header?: unknown;
}

/** designScreens の値 (キーは DesignScreen.id)。order は設計の中での並び */
export interface DesignScreenRecord {
  systemId: string;
  id: string;
  source: unknown;
  shell?: string;
  view?: unknown;
  bindings?: unknown;
  order: string;
}

/** designTransitions の値 (キーは Transition.id) */
export interface TransitionRecord {
  systemId: string;
  id: string;
  from: string;
  to: string;
  via?: string;
  label?: string;
  order: string;
}

/** designNav の値 (キーはナビゲーションのグループの id) */
export interface NavGroupRecord {
  systemId: string;
  id: string;
  group: string;
  items: unknown;
  order: string;
}

// ドメインモデル (0.6.0) も、1 つのルートに平らな「キー → JSON の値」で置く。部品 (コンテキスト・集約・コマンド・イベント・ポリシー・関係・用語) は
// id をキーにし、値に部品の種類 (part) と並び (order) を持つ。親 (集約のコンテキスト、コマンドの集約) は値の中の id で指すので、付け替えてもキーは変わらない。
// 別々の部品を 2 人が同時に直しても両方残り、同じ部品への同時の書き込みは後勝ちで 1 つになる (集約の中の情報・不変条件は集約の値の中なので、同じ集約を同時に直すと後勝ち)。
// 外した候補 (excluded) は 1 件 1 キー (`x:` + 候補のキー) で置く。

/** domain の値の種類 */
export const DOMAIN_PARTS = ["context", "aggregate", "command", "event", "policy", "relation", "term"] as const;
export type DomainPart = (typeof DOMAIN_PARTS)[number];

/** domain の値 (キーは部品の id)。part と order のほかは、部品の JSON そのまま (id を含む) */
export interface DomainPartRecord {
  part: DomainPart;
  id: string;
  order: string;
  [key: string]: unknown;
}

/** domain の値 (キーは `x:` + 候補のキー)。外した候補 */
export interface DomainExcludedRecord {
  part: "excluded";
  key: string;
  order: string;
}

/** 外した候補の Y.Map のキー (部品の id は [A-Za-z0-9_-] だけなので、`:` を含むキーとは重ならない) */
export const excludedKey = (key: string) => `x:${key}`;

/** designs のキー。systemId・データベースの id は [A-Za-z0-9_-] だけなので、`/` で区切れる */
export const designKey = (systemId: string, part: "meta" | "layout") => `${systemId}/${part}`;
/** databases のキー。データベースがあるかは `${id}/name` の有無で決める */
export const databaseKey = (id: string, part: "name" | "dsl" | "tables" | "order") => `${id}/${part}`;
/** キーの `/` の前 (systemId・データベースの id) */
export const keyOwner = (key: string) => (key.includes("/") ? key.slice(0, key.lastIndexOf("/")) : key);

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
  /** `${systemId}/meta` → DesignMetaRecord、`${systemId}/layout` → DesignLayoutRecord */
  designs: Y.Map<unknown>;
  /** DesignScreen.id → DesignScreenRecord */
  designScreens: Y.Map<DesignScreenRecord>;
  /** Transition.id → TransitionRecord */
  designTransitions: Y.Map<TransitionRecord>;
  /** ナビゲーションのグループの id → NavGroupRecord */
  designNav: Y.Map<NavGroupRecord>;
  /** `${id}/name`・`${id}/dsl` (文字列)、`${id}/tables` (JSON)、`${id}/order` */
  databases: Y.Map<unknown>;
  /** ドメインモデルの部品の id → DomainPartRecord、`x:` + 候補のキー → DomainExcludedRecord */
  domain: Y.Map<DomainPartRecord | DomainExcludedRecord>;
}

/** Y.Doc からルートを取り出す (無ければ作られる) */
export function getRoots(doc: Y.Doc): UntieDocRoots {
  return {
    meta: doc.getMap(ROOT_NAMES.meta),
    elements: doc.getMap(ROOT_NAMES.elements),
    relations: doc.getMap(ROOT_NAMES.relations),
    boards: doc.getMap(ROOT_NAMES.boards),
    designs: doc.getMap(ROOT_NAMES.designs),
    designScreens: doc.getMap(ROOT_NAMES.designScreens),
    designTransitions: doc.getMap(ROOT_NAMES.designTransitions),
    designNav: doc.getMap(ROOT_NAMES.designNav),
    databases: doc.getMap(ROOT_NAMES.databases),
    domain: doc.getMap(ROOT_NAMES.domain),
  };
}
