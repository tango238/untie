// 生成型 (schema.d.ts) の再エクスポートと補助型。
import type { Element, RelationKind, UntieModel } from "./schema";

export type {
  Actor,
  Board,
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
  Meta,
  Relation,
  RelationKind,
  State,
  Ledger,
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

/** 課題の対象になれる種類 */
export type IssueTargetKind = "business" | "activity" | "usecase";

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

export const ISSUE_TARGET_KINDS: readonly IssueTargetKind[] = ["business", "activity", "usecase"];

export function isFrameKind(kind: ElementKind): kind is FrameKind {
  return kind === "business" || kind === "buc";
}

export function isIssueTargetKind(kind: ElementKind): kind is IssueTargetKind {
  return kind === "business" || kind === "activity" || kind === "usecase";
}

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
