import type { ElementKind, Relation, RelationKind } from "./types";

export interface RelationRule {
  kind: RelationKind;
  /** 始点になれる種類 */
  sources: readonly ElementKind[];
  /** 終点になれる種類 */
  targets: readonly ElementKind[];
  /** 線の上に出す短いラベル */
  label: string;
  /** 向きを持たない関係か */
  undirected: boolean;
}

/** 設計書 3 章の表 */
export const RELATION_RULES: readonly RelationRule[] = [
  { kind: "actorBusiness", sources: ["actor"], targets: ["business"], label: "主担当", undirected: false },
  { kind: "actorActivity", sources: ["actor", "externalActor"], targets: ["activity"], label: "担当", undirected: false },
  { kind: "activityUsecase", sources: ["activity"], targets: ["usecase"], label: "使う", undirected: false },
  { kind: "usecaseInformation", sources: ["usecase"], targets: ["information"], label: "扱う", undirected: false },
  { kind: "usecaseCondition", sources: ["usecase"], targets: ["condition"], label: "判断", undirected: false },
  { kind: "informationRelated", sources: ["information"], targets: ["information"], label: "関連", undirected: true },
  { kind: "informationVariation", sources: ["information"], targets: ["variation"], label: "種別", undirected: false },
  { kind: "systemInformation", sources: ["system"], targets: ["information"], label: "取得元", undirected: false },
  { kind: "informationSystem", sources: ["information"], targets: ["system"], label: "保存先", undirected: false },
  { kind: "conditionVariation", sources: ["condition"], targets: ["variation"], label: "区分", undirected: false },
  { kind: "conditionState", sources: ["condition"], targets: ["state"], label: "状態参照", undirected: false },
  { kind: "stateUsecase", sources: ["state"], targets: ["usecase"], label: "実行可", undirected: false },
  { kind: "usecaseState", sources: ["usecase"], targets: ["state"], label: "次の状態", undirected: false },
];

const RULE_BY_KIND = new Map<RelationKind, RelationRule>(RELATION_RULES.map((r) => [r.kind, r]));

/** 両端の種類から関係の種類を引く。表にない組み合わせは null */
export function relationKindFor(sourceKind: ElementKind, targetKind: ElementKind): RelationKind | null {
  const rule = RELATION_RULES.find((r) => r.sources.includes(sourceKind) && r.targets.includes(targetKind));
  return rule ? rule.kind : null;
}

export function relationRule(kind: RelationKind): RelationRule {
  return RULE_BY_KIND.get(kind)!;
}

/** 線の上に出す短い日本語ラベル */
export function relationLabel(kind: RelationKind): string {
  return relationRule(kind).label;
}

/** 向きを持たない関係か (informationRelated のみ) */
export function isUndirected(kind: RelationKind): boolean {
  return relationRule(kind).undirected;
}

/** キャンバスに線を引かず、相手の枠・カードにアクター名のラベルで出す関係 */
export function isShownAsLabel(kind: RelationKind): boolean {
  return kind === "actorBusiness" || kind === "actorActivity";
}

type RelationLike = Pick<Relation, "kind" | "sourceId" | "targetId">;

/** 同じ関係か。無向関係は向きを無視する */
export function sameRelation(a: RelationLike, b: RelationLike): boolean {
  if (a.kind !== b.kind) return false;
  if (a.sourceId === b.sourceId && a.targetId === b.targetId) return true;
  return isUndirected(a.kind) && a.sourceId === b.targetId && a.targetId === b.sourceId;
}
