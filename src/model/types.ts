// 生成型 (schema.d.ts) の再エクスポートと補助型。
import type { BoardEdge, Element, IssueAnalysis, RelationKind, UntieModel } from "./schema";

export type {
  Actor,
  Board,
  BoardEdge,
  BoardNode,
  Buc,
  Activity,
  Business,
  Condition,
  Context,
  Element,
  ExternalActor,
  Information,
  Issue,
  IssueAnalysis,
  Meta,
  Relation,
  RelationKind,
  State,
  Ledger,
  Link,
  System,
  UntieModel,
  Usecase,
  Variation,
} from "./schema";

/** 要素の種類 (14 種) */
export type ElementKind = Element["kind"];

/** 種類 K の要素の型 */
export type ElementOfKind<K extends ElementKind> = Extract<Element, { kind: K }>;

/** ボード上で枠 (グループノード) として描かれる種類 */
export type FrameKind = "business" | "buc";

/** 全体的な課題の対象になれる種類 (登場人物) */
export type OverallIssueTargetKind = "actor" | "externalActor" | "system" | "ledger";
/** 具体的な課題の対象になれる種類 (業務・作業・操作) */
export type SpecificIssueTargetKind = "business" | "activity" | "usecase";
/** 課題の対象になれる種類 */
export type IssueTargetKind = OverallIssueTargetKind | SpecificIssueTargetKind;

/**
 * 課題の区分。対象の種類から決まる (モデルには保存しない)
 * - overall: 全体的な課題 (登場人物が対象)
 * - specific: 具体的な課題 (業務・作業・操作が対象)
 * - unsorted: 未整理 (対象がまだ無い)
 */
export type IssueScope = "overall" | "specific" | "unsorted";

export const ELEMENT_KINDS: readonly ElementKind[] = [
  "actor",
  "externalActor",
  "system",
  "ledger",
  "business",
  "buc",
  "activity",
  "usecase",
  "context",
  "information",
  "state",
  "variation",
  "condition",
  "issue",
];

export const RELATION_KINDS: readonly RelationKind[] = [
  "actorBusiness",
  "actorActivity",
  "activityUsecase",
  "usecaseInformation",
  "usecaseCondition",
  "informationRelated",
  "informationVariation",
  "systemInformation",
  "informationSystem",
  "conditionVariation",
  "conditionState",
  "stateUsecase",
  "usecaseState",
];

export const ELEMENT_KIND_LABELS: Record<ElementKind, string> = {
  actor: "アクター",
  externalActor: "外部アクター",
  system: "システム",
  ledger: "帳票",
  business: "業務",
  buc: "活動",
  activity: "作業",
  usecase: "操作",
  context: "コンテキスト",
  information: "情報",
  state: "状態",
  variation: "バリエーション",
  condition: "条件",
  issue: "課題",
};

export const OVERALL_ISSUE_TARGET_KINDS: readonly OverallIssueTargetKind[] = ["actor", "externalActor", "system", "ledger"];
export const SPECIFIC_ISSUE_TARGET_KINDS: readonly SpecificIssueTargetKind[] = ["business", "activity", "usecase"];
export const ISSUE_TARGET_KINDS: readonly IssueTargetKind[] = [...OVERALL_ISSUE_TARGET_KINDS, ...SPECIFIC_ISSUE_TARGET_KINDS];

export const ISSUE_SCOPES: readonly IssueScope[] = ["unsorted", "overall", "specific"];

export const ISSUE_SCOPE_LABELS: Record<IssueScope, string> = {
  overall: "全体的な課題",
  specific: "具体的な課題",
  unsorted: "未整理の課題",
};

/** 区分ごとの対象の説明 */
export const ISSUE_SCOPE_TARGETS: Record<IssueScope, string> = {
  overall: "登場人物 (アクター・外部アクター・システム・帳票) が対象",
  specific: "業務・作業・操作が対象",
  unsorted: "対象をまだ決めていない",
};

/** 課題の分析の項目 (深掘りで埋める順) */
export const ISSUE_ANALYSIS_KEYS: readonly (keyof IssueAnalysis)[] = ["phenomenon", "location", "cause", "impact"];

export const ISSUE_ANALYSIS_LABELS: Record<keyof IssueAnalysis, string> = {
  phenomenon: "現象",
  location: "所在",
  cause: "理由",
  impact: "影響",
};

/** 項目ごとの問い (プロパティ欄のプレースホルダーと AI の指示で同じ文言を使う) */
export const ISSUE_ANALYSIS_QUESTIONS: Record<keyof IssueAnalysis, string> = {
  phenomenon: "何が、いつ、どのくらいの頻度で起きるか",
  location: "どの業務・活動・作業・操作 (または登場人物) で起きるか",
  cause: "なぜそこで起きるか",
  impact: "誰にどう響くか",
};

export function isFrameKind(kind: ElementKind): kind is FrameKind {
  return kind === "business" || kind === "buc";
}

/** コンテキストに属する種類 */
export type ContextMemberKind = "information" | "state" | "condition" | "variation";

export function isContextMemberKind(kind: ElementKind): kind is ContextMemberKind {
  return kind === "information" || kind === "state" || kind === "condition" || kind === "variation";
}

export function isIssueTargetKind(kind: ElementKind): kind is IssueTargetKind {
  return (ISSUE_TARGET_KINDS as readonly ElementKind[]).includes(kind);
}

/** 対象の種類から決まる課題の区分 (全体的 / 具体的) */
export function issueScopeOfKind(kind: IssueTargetKind): Exclude<IssueScope, "unsorted"> {
  return (OVERALL_ISSUE_TARGET_KINDS as readonly ElementKind[]).includes(kind) ? "overall" : "specific";
}

/** 線を出す・入れる辺 (自由ボードごとの線の見た目) */
export type EdgeSide = NonNullable<BoardEdge["sourceSide"]>;

export const EDGE_SIDES: readonly EdgeSide[] = ["left", "right", "top", "bottom"];

export const EDGE_SIDE_LABELS: Record<EdgeSide, string> = { left: "左", right: "右", top: "上", bottom: "下" };

/** 線の辺を省略したときの既定: 始点の右から出て、終点の左に入る */
export const DEFAULT_EDGE_SIDES: { sourceSide: EdgeSide; targetSide: EdgeSide } = { sourceSide: "right", targetSide: "left" };

export type { UntieModel as Model };

/** 空のモデル (ボード 1 つだけ) */
export function emptyModel(name = "新しいモデル", boardId = "board_main"): UntieModel {
  return {
    version: 1,
    meta: { name },
    elements: [],
    relations: [],
    boards: [{ id: boardId, name: "ボード 1", nodes: [] }],
  };
}
