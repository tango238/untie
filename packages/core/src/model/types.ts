// 生成型 (schema.d.ts) の再エクスポートと補助型。
import type { BoardEdge, DomainModel, Element, EventTiming, IssueAnalysis, Persona, Relation, RelationKind, UntieModel } from "./schema";

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
  EventTiming,
  Persona,
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
  SystemDesign,
  DesignScreen,
  Transition,
  Layout,
  NavGroup,
  Database,
  DomainModel,
  BoundedContext,
  Aggregate,
  DomainCommand,
  DomainEvent,
  DomainPolicy,
  ContextRelation,
  DomainTerm,
  Event as EventElement,
  Screen,
  Nfr,
} from "./schema";

/** 要素の種類 (17 種) */
export type ElementKind = Element["kind"];

/** 種類 K の要素の型 */
export type ElementOfKind<K extends ElementKind> = Extract<Element, { kind: K }>;

/** ボード上で枠 (グループノード) として描かれる種類 */
export type FrameKind = "business" | "buc";

/** 全体的な課題の対象になれる種類 (登場人物) */
export type OverallIssueTargetKind = "actor" | "externalActor" | "system" | "ledger";
/** 具体的な課題の対象になれる種類 (業務・作業・操作・画面) */
export type SpecificIssueTargetKind = "business" | "activity" | "usecase" | "screen";
/** 課題の対象になれる種類 */
export type IssueTargetKind = OverallIssueTargetKind | SpecificIssueTargetKind;

/**
 * 課題の区分。対象の種類から決まる (モデルには保存しない)
 * - overall: 全体的な課題 (登場人物が対象)
 * - specific: 具体的な課題 (業務・作業・操作・画面が対象)
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
  "event",
  "screen",
  "nfr",
];

export const RELATION_KINDS: readonly RelationKind[] = [
  "actorBusiness",
  "actorActivity",
  "activityUsecase",
  "usecaseInformation",
  "usecaseCondition",
  "informationRelated",
  "informationVariation",
  "conditionVariation",
  "conditionState",
  "stateUsecase",
  "usecaseState",
  "usecaseSystem",
  "usecaseEvent",
  "systemEvent",
  "eventUsecase",
  "usecaseNext",
  "activityTrigger",
  "eventActivity",
  "usecaseScreen",
  "actorNfr",
];

/** 操作が情報をどう扱うか (usecaseInformation の access)。省略は取得も保存もする */
export type InformationAccess = NonNullable<Relation["access"]>;

/** 代替パターン (操作が条件を判断した結果、ふだんと違う流れになるときの中身。usecaseCondition の関係に付ける。0.6.1) */
export type RelationAlternate = NonNullable<Relation["alternate"]>;
export type AlternateWhen = RelationAlternate["when"];
export const ALTERNATE_WHENS: readonly AlternateWhen[] = ["met", "unmet"];
export const ALTERNATE_WHEN_LABELS: Record<AlternateWhen, string> = { met: "条件を満たすとき", unmet: "条件を満たさないとき" };

export const INFORMATION_ACCESSES: readonly InformationAccess[] = ["read", "write"];

export const INFORMATION_ACCESS_LABELS: Record<InformationAccess, string> = { read: "取得", write: "保存" };

/** access を省略したときの表示 (取得も保存もする) */
export const INFORMATION_ACCESS_BOTH_LABEL = "取得・保存";

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
  event: "イベント",
  screen: "画面",
  nfr: "非機能要件",
};

/** 非機能要件の分類 (IPA 非機能要求グレードの大項目) */
export type NfrCategory = NonNullable<import("./schema").Nfr["category"]>;

export const NFR_CATEGORIES: readonly NfrCategory[] = ["availability", "performance", "operability", "migration", "security", "environment"];

export const NFR_CATEGORY_LABELS: Record<NfrCategory, string> = {
  availability: "可用性",
  performance: "性能・拡張性",
  operability: "運用・保守性",
  migration: "移行性",
  security: "セキュリティ",
  environment: "システム環境・エコロジー",
};

export const OVERALL_ISSUE_TARGET_KINDS: readonly OverallIssueTargetKind[] = ["actor", "externalActor", "system", "ledger"];
export const SPECIFIC_ISSUE_TARGET_KINDS: readonly SpecificIssueTargetKind[] = ["business", "activity", "usecase", "screen"];
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
  specific: "業務・作業・操作・画面が対象",
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

/** ペルソナの IT の習熟の表示名 */
export const PERSONA_IT_SKILL_LABELS: Record<NonNullable<Persona["itSkill"]>, string> = {
  comfortable: "慣れている",
  normal: "普通",
  uncomfortable: "苦手",
};

/** IT の習熟の値 (PERSONA_IT_SKILL_LABELS のキー。列挙の定義はここ 1 か所) */
export const PERSONA_IT_SKILLS = Object.keys(PERSONA_IT_SKILL_LABELS) as NonNullable<Persona["itSkill"]>[];

export function isPersonaItSkill(value: unknown): value is NonNullable<Persona["itSkill"]> {
  return typeof value === "string" && (PERSONA_IT_SKILLS as string[]).includes(value);
}

/** ペルソナの項目 (表示と AI の指示で使う順) */
export const PERSONA_FIELD_KEYS: readonly (keyof Persona)[] = ["handle", "attributes", "background", "goals", "itSkill", "notes"];

/** ペルソナの項目の表示名 */
export const PERSONA_FIELD_LABELS: Record<keyof Persona, string> = {
  handle: "呼び名",
  attributes: "属性",
  background: "背景と役割",
  goals: "目標",
  itSkill: "IT の習熟",
  notes: "備考",
};

/** ペルソナを持てる種類 */
export type PersonaOwnerKind = "actor" | "externalActor";

export function isPersonaOwnerKind(kind: ElementKind): kind is PersonaOwnerKind {
  return kind === "actor" || kind === "externalActor";
}

/**
 * ペルソナを正規化する。文字列は前後の空白を除き、空の項目と不正な itSkill を外す。
 * 何も残らなければ null (persona ごと持たない)
 */
export function normalizePersona(persona: unknown): Persona | null {
  if (typeof persona !== "object" || persona === null || Array.isArray(persona)) return null;
  const src = persona as Record<string, unknown>;
  const out: Persona = {};
  for (const key of ["handle", "attributes", "background", "goals", "notes"] as const) {
    const v = src[key];
    if (typeof v === "string" && v.trim() !== "") out[key] = v.trim();
  }
  if (isPersonaItSkill(src.itSkill)) out.itSkill = src.itSkill;
  return Object.keys(out).length > 0 ? out : null;
}

/** イベントの発生タイミングの種類の表示名 */
export const EVENT_TIMING_TYPE_LABELS: Record<EventTiming["type"], string> = {
  scheduled: "定期",
  adhoc: "不定期 (随時)",
};

/** 発生タイミングの種類 (EVENT_TIMING_TYPE_LABELS のキー。列挙の定義はここ 1 か所) */
export const EVENT_TIMING_TYPES = Object.keys(EVENT_TIMING_TYPE_LABELS) as EventTiming["type"][];

/** 定期の周期の表示名 */
export const EVENT_TIMING_EVERY_LABELS: Record<NonNullable<EventTiming["every"]>, string> = {
  month: "毎月",
  day: "毎日",
  hour: "毎時",
};

/** 定期の周期 (EVENT_TIMING_EVERY_LABELS のキー) */
export const EVENT_TIMING_EVERIES = Object.keys(EVENT_TIMING_EVERY_LABELS) as NonNullable<EventTiming["every"]>[];

export function isEventTimingType(value: unknown): value is EventTiming["type"] {
  return typeof value === "string" && (EVENT_TIMING_TYPES as string[]).includes(value);
}

export function isEventTimingEvery(value: unknown): value is NonNullable<EventTiming["every"]> {
  return typeof value === "string" && (EVENT_TIMING_EVERIES as string[]).includes(value);
}

const intIn = (v: unknown, min: number, max: number): number | undefined => (typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : undefined);

/**
 * 発生タイミングを正規化する。種類が分からなければ null (timing ごと持たない)。
 * 定期は、周期 (無ければ毎日) と、周期に合う項目だけを残す (日は毎月だけ、時は毎月・毎日だけ、分は定期だけ。範囲外の数は外す)。
 * 不定期は、周期と時刻を持たない。補足は前後の空白を除き、空なら持たない
 */
export function normalizeEventTiming(timing: unknown): EventTiming | null {
  if (typeof timing !== "object" || timing === null || Array.isArray(timing)) return null;
  const src = timing as Record<string, unknown>;
  if (!isEventTimingType(src.type)) return null;
  const out: EventTiming = { type: src.type };
  if (src.type === "scheduled") {
    const every = isEventTimingEvery(src.every) ? src.every : "day";
    out.every = every;
    const day = every === "month" ? intIn(src.day, 1, 31) : undefined;
    const hour = every !== "hour" ? intIn(src.hour, 0, 23) : undefined;
    const minute = intIn(src.minute, 0, 59);
    if (day !== undefined) out.day = day;
    if (hour !== undefined) out.hour = hour;
    if (minute !== undefined) out.minute = minute;
  }
  if (typeof src.note === "string" && src.note.trim() !== "") out.note = src.note.trim();
  return out;
}

/**
 * 発生タイミングの短い表記。例: 「定期: 毎月 25日 9:00」「定期: 毎日 2:30」「定期: 毎時 15分」「不定期: 入金の Webhook を受けたとき」。
 * 決まっていない時刻は「--」にする (例: 毎日 --:--)
 */
export function describeEventTiming(timing: EventTiming): string {
  if (timing.type === "adhoc") return `不定期${timing.note ? `: ${timing.note}` : ""}`;
  const every = timing.every ?? "day";
  const mm = timing.minute === undefined ? "--" : String(timing.minute).padStart(2, "0");
  const hh = timing.hour === undefined ? "--" : String(timing.hour);
  const when = every === "hour" ? `${timing.minute === undefined ? "--" : timing.minute}分` : `${hh}:${mm}`;
  const day = every === "month" ? `${timing.day === undefined ? "--" : timing.day}日 ` : "";
  return `定期: ${EVENT_TIMING_EVERY_LABELS[every]} ${day}${when}${timing.note ? ` (${timing.note})` : ""}`;
}

export function isFrameKind(kind: ElementKind): kind is FrameKind {
  return kind === "business" || kind === "buc";
}

/** コンテキストに属する種類 */
export type ContextMemberKind = "information" | "state" | "condition" | "variation" | "event";

export function isContextMemberKind(kind: ElementKind): kind is ContextMemberKind {
  return kind === "information" || kind === "state" || kind === "condition" || kind === "variation" || kind === "event";
}

/** システムに属する種類 (systemId で属するシステムを指す。システムを消すと一緒に消える) */
export type SystemMemberKind = "screen" | "nfr";

export function isSystemMemberKind(kind: ElementKind): kind is SystemMemberKind {
  return kind === "screen" || kind === "nfr";
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

/**
 * 現行のモデルの形式 (スキーマ) のバージョン。JSON の version に入れる。
 * 上げるときの手順と、古い版からの変換は migrate.ts
 */
export const MODEL_VERSION = "0.6.1";

/** 空のドメインモデル (0.6.0) */
export function emptyDomain(): DomainModel {
  return { contexts: [], aggregates: [], commands: [], events: [], policies: [], excluded: [], relations: [], terms: [] };
}

/** 空のモデル (ボード 1 つだけ) */
export function emptyModel(name = "新しいモデル", boardId = "board_main"): UntieModel {
  return {
    version: MODEL_VERSION,
    meta: { name },
    elements: [],
    relations: [],
    boards: [{ id: boardId, name: "ボード 1", nodes: [] }],
    designs: [],
    databases: [],
    domain: emptyDomain(),
  };
}
