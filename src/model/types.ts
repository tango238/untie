// 生成型 (schema.d.ts) の再エクスポートと補助型。
import type { Element, RelationKind, System, UntieModel } from "./schema";

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
  System,
  UntieModel,
  Usecase,
  Variation,
} from "./schema";

/** 要素の種類 (13 種) */
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
  business: "業務",
  buc: "BUC",
  activity: "アクティビティ",
  usecase: "ユースケース",
  context: "コンテキスト",
  information: "情報",
  state: "状態",
  variation: "バリエーション",
  condition: "条件",
  issue: "課題",
};

/** システムの媒体 */
export type SystemMedium = System["medium"];

export const SYSTEM_MEDIUM_LABELS: Record<SystemMedium, string> = {
  system: "システム",
  paper: "紙媒体",
};

/** 種類の表示名。システムは媒体 (システム / 紙媒体) で出す */
export function kindLabelOf(element: Element): string {
  return element.kind === "system" ? SYSTEM_MEDIUM_LABELS[element.medium] : ELEMENT_KIND_LABELS[element.kind];
}

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
