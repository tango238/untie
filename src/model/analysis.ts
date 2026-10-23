// 分析ボードの計算。モデルには保存せず、毎回モデルから組み立てる。純粋関数だけを置く。
import { defaultBucOf } from "./selectors";
import {
  isContextMemberKind,
  type Activity,
  type Buc,
  type Business,
  type Element,
  type Issue,
  type Relation,
  type UntieModel,
  type Usecase,
} from "./types";

export const ANALYSIS_KINDS = [
  "people",
  "businessContext",
  "contextCoupling",
  "informationLocation",
  "workFlow",
  "issues",
] as const;
export type AnalysisKind = (typeof ANALYSIS_KINDS)[number];

export const ANALYSIS_LABELS: Record<AnalysisKind, string> = {
  people: "担当別の作業一覧",
  businessContext: "業務とコンテキストの結合",
  contextCoupling: "コンテキストの結合",
  informationLocation: "情報の所在",
  workFlow: "作業の流れ",
  issues: "課題の分布",
};

const PREFIX = "analysis:";

export function analysisBoardId(kind: AnalysisKind): string {
  return `${PREFIX}${kind}`;
}

/** 分析ボードの id なら種類を返す */
export function parseAnalysisBoardId(boardId: string): AnalysisKind | null {
  if (!boardId.startsWith(PREFIX)) return null;
  const kind = boardId.slice(PREFIX.length);
  return (ANALYSIS_KINDS as readonly string[]).includes(kind) ? (kind as AnalysisKind) : null;
}

// ---------------------------------------------------------------- 共通

const byKind = <K extends Element["kind"]>(model: UntieModel, kind: K) =>
  model.elements.filter((e): e is Extract<Element, { kind: K }> => e.kind === kind);

const targetsOf = (model: UntieModel, kind: Relation["kind"], sourceId: string) =>
  model.relations.filter((r) => r.kind === kind && r.sourceId === sourceId).map((r) => r.targetId);

const sourcesOf = (model: UntieModel, kind: Relation["kind"], targetId: string) =>
  model.relations.filter((r) => r.kind === kind && r.targetId === targetId).map((r) => r.sourceId);

function lookup(model: UntieModel) {
  const byId = new Map(model.elements.map((e) => [e.id, e]));
  return <T extends Element = Element>(id: string) => byId.get(id) as T | undefined;
}

/** 業務 → (既定 BUC, BUC...) の順に、所属する作業を並べた区切り */
export interface ActivitySection {
  business: Business | null;
  /** 既定 BUC (業務に直接) なら null */
  buc: Buc | null;
  activities: Activity[];
}

function activitySections(model: UntieModel, activities: Activity[]): ActivitySection[] {
  const sections: ActivitySection[] = [];
  for (const biz of byKind(model, "business")) {
    const def = defaultBucOf(model, biz.id);
    const inDef = def ? activities.filter((a) => a.bucId === def.id) : [];
    if (inDef.length > 0) sections.push({ business: biz, buc: null, activities: inDef });
    for (const buc of byKind(model, "buc").filter((b) => b.businessId === biz.id && !b.isDefault)) {
      const acts = activities.filter((a) => a.bucId === buc.id);
      if (acts.length > 0) sections.push({ business: biz, buc, activities: acts });
    }
  }
  const orphans = activities.filter((a) => a.bucId === null);
  if (orphans.length > 0) sections.push({ business: null, buc: null, activities: orphans });
  return sections;
}

// ---------------------------------------------------------------- 1. 担当別の作業一覧

export interface PerformerWork {
  performer: Element;
  sections: ActivitySection[];
}

/** 担い手 (アクター・外部アクター・システム) ごとに、担当する作業を業務・活動の順に並べる。担当の無い作業は最後にまとめる */
export function performerWorkList(model: UntieModel): { performers: PerformerWork[]; unassigned: ActivitySection[] } {
  const get = lookup(model);
  const activities = byKind(model, "activity");
  const performers = model.elements
    .filter((e) => e.kind === "actor" || e.kind === "externalActor" || e.kind === "system")
    .map((performer) => {
      const ids = new Set(targetsOf(model, "actorActivity", performer.id));
      return { performer, sections: activitySections(model, activities.filter((a) => ids.has(a.id))) };
    });
  const assigned = new Set(model.relations.filter((r) => r.kind === "actorActivity" && get(r.sourceId)).map((r) => r.targetId));
  return { performers, unassigned: activitySections(model, activities.filter((a) => !assigned.has(a.id))) };
}

/** 作業が使う操作 */
export function usecasesOfActivity(model: UntieModel, activityId: string): Usecase[] {
  const get = lookup(model);
  return targetsOf(model, "activityUsecase", activityId)
    .map((id) => get<Usecase>(id))
    .filter((u): u is Usecase => !!u);
}

// ---------------------------------------------------------------- 2. 業務とコンテキストの結合

export type BusinessUnit = "business" | "buc";

/** 結合の元になった道筋 (作業 → 操作 → 情報) */
export interface BridgePath {
  activityId: string;
  usecaseId: string;
  informationId: string;
}

export interface BusinessContextMatrix {
  /** elementId は見出しから選ぶ要素 (業務に直接属する作業の行は業務) */
  rows: { id: string; elementId: string; label: string; sub?: string }[];
  /** コンテキスト (未分類の情報があれば最後に id "__none") */
  columns: { id: string; label: string }[];
  /** `${rowId}|${columnId}` → 道筋 */
  cells: Map<string, BridgePath[]>;
  /** 列ごとに、つながる行の数 (多いほどリソース系) */
  columnReach: Map<string, number>;
}

/**
 * 業務 (または活動) と、操作を通して扱うコンテキストの結合。
 * 活動の単位では、業務に直接属する作業は「業務名 (活動なし)」の行にまとめる。
 */
export function businessContextMatrix(model: UntieModel, unit: BusinessUnit): BusinessContextMatrix {
  const get = lookup(model);
  const rows: BusinessContextMatrix["rows"] = [];
  const rowOfBuc = new Map<string, string>();
  for (const biz of byKind(model, "business")) {
    if (unit === "business") {
      rows.push({ id: biz.id, elementId: biz.id, label: biz.name || "(名前なし)" });
      for (const b of byKind(model, "buc").filter((x) => x.businessId === biz.id)) rowOfBuc.set(b.id, biz.id);
      continue;
    }
    const def = defaultBucOf(model, biz.id);
    if (def) {
      rows.push({ id: def.id, elementId: biz.id, label: biz.name || "(名前なし)", sub: "業務 (活動なし)" });
      rowOfBuc.set(def.id, def.id);
    }
    for (const b of byKind(model, "buc").filter((x) => x.businessId === biz.id && !x.isDefault)) {
      rows.push({ id: b.id, elementId: b.id, label: b.name || "(名前なし)", sub: `活動 (業務: ${biz.name})` });
      rowOfBuc.set(b.id, b.id);
    }
  }

  const cells = new Map<string, BridgePath[]>();
  let hasUnclassified = false;
  for (const act of byKind(model, "activity")) {
    const rowId = act.bucId ? rowOfBuc.get(act.bucId) : undefined;
    if (!rowId) continue;
    for (const ucId of targetsOf(model, "activityUsecase", act.id)) {
      for (const infoId of targetsOf(model, "usecaseInformation", ucId)) {
        const info = get(infoId);
        if (!info || info.kind !== "information") continue;
        const col = info.contextId ?? "__none";
        if (col === "__none") hasUnclassified = true;
        const key = `${rowId}|${col}`;
        cells.set(key, [...(cells.get(key) ?? []), { activityId: act.id, usecaseId: ucId, informationId: infoId }]);
      }
    }
  }
  const columns = byKind(model, "context").map((c) => ({ id: c.id, label: c.name || "(名前なし)" }));
  if (hasUnclassified) columns.push({ id: "__none", label: "未分類" });
  const columnReach = new Map(columns.map((c) => [c.id, rows.filter((r) => cells.has(`${r.id}|${c.id}`)).length]));
  return { rows, columns, cells, columnReach };
}

// ---------------------------------------------------------------- 3. コンテキストの結合

export interface ContextCoupling {
  contexts: { id: string; label: string }[];
  /** `${a}|${b}` (a <= b の順、同じなら中の関係) → 関係 */
  pairs: Map<string, Relation[]>;
  /** コンテキストごとの、中で閉じた関係と外へ出る関係の数 */
  cohesion: Map<string, { internal: number; external: number }>;
}

export const pairKey = (a: string, b: string) => (a <= b ? `${a}|${b}` : `${b}|${a}`);

/** 所属する要素 (情報・状態・条件・バリエーション) どうしの関係から、コンテキストどうしの結合と凝集を数える */
export function contextCoupling(model: UntieModel): ContextCoupling {
  const get = lookup(model);
  const ctxOf = (id: string) => {
    const e = get(id);
    return e && isContextMemberKind(e.kind) && "contextId" in e ? e.contextId : null;
  };
  const contexts = byKind(model, "context").map((c) => ({ id: c.id, label: c.name || "(名前なし)" }));
  const pairs = new Map<string, Relation[]>();
  const cohesion = new Map(contexts.map((c) => [c.id, { internal: 0, external: 0 }]));
  for (const r of model.relations) {
    const a = ctxOf(r.sourceId);
    const b = ctxOf(r.targetId);
    if (!a || !b) continue;
    const key = pairKey(a, b);
    pairs.set(key, [...(pairs.get(key) ?? []), r]);
    if (a === b) cohesion.get(a)!.internal++;
    else {
      cohesion.get(a)!.external++;
      cohesion.get(b)!.external++;
    }
  }
  return { contexts, pairs, cohesion };
}

// ---------------------------------------------------------------- 4. 情報の所在

export type LocationRole = "source" | "store";

export interface InformationLocation {
  information: Element;
  /** 置き場所 id → 役割 (取得元・保存先) */
  places: Map<string, LocationRole[]>;
  /** 扱う操作の数 */
  usecaseCount: number;
  /** 気をつけること */
  flags: ("noPlace" | "paperOnly" | "multipleStores")[];
}

export const LOCATION_FLAG_LABELS: Record<InformationLocation["flags"][number], string> = {
  noPlace: "置き場所なし",
  paperOnly: "紙だけ",
  multipleStores: "保存先が複数 (二重管理の可能性)",
};

/** 情報ごとに、取得元・保存先のシステム・帳票を並べる */
export function informationLocations(model: UntieModel): { places: Element[]; rows: InformationLocation[] } {
  const get = lookup(model);
  const places = model.elements.filter((e) => e.kind === "system" || e.kind === "ledger");
  const rows = byKind(model, "information").map((info) => {
    const map = new Map<string, LocationRole[]>();
    const add = (placeId: string, role: LocationRole) => {
      if (!get(placeId)) return;
      map.set(placeId, [...(map.get(placeId) ?? []), role]);
    };
    for (const id of sourcesOf(model, "systemInformation", info.id)) add(id, "source");
    for (const id of targetsOf(model, "informationSystem", info.id)) add(id, "store");
    const flags: InformationLocation["flags"] = [];
    if (map.size === 0) flags.push("noPlace");
    else if ([...map.keys()].every((id) => get(id)?.kind === "ledger")) flags.push("paperOnly");
    if ([...map.values()].filter((roles) => roles.includes("store")).length >= 2) flags.push("multipleStores");
    return { information: info, places: map, usecaseCount: sourcesOf(model, "usecaseInformation", info.id).length, flags };
  });
  return { places, rows };
}

// ---------------------------------------------------------------- 5. 作業の流れ

export interface WorkFlowRow {
  activity: Activity;
  performers: Element[];
  usecases: {
    usecase: Usecase;
    informations: Element[];
    conditions: Element[];
    /** 実行できる状態 */
    fromStates: Element[];
    /** 実行後の状態 */
    toStates: Element[];
  }[];
}

/** 活動ごとに、作業 → 担当・操作 → 情報・条件・状態の遷移を並べる */
export function workFlow(model: UntieModel): { section: ActivitySection; rows: WorkFlowRow[] }[] {
  const get = lookup(model);
  const els = (ids: string[]) => ids.map((id) => get(id)).filter((e): e is Element => !!e);
  return activitySections(model, byKind(model, "activity")).map((section) => ({
    section,
    rows: section.activities.map((activity) => ({
      activity,
      performers: els(sourcesOf(model, "actorActivity", activity.id)),
      usecases: usecasesOfActivity(model, activity.id).map((usecase) => ({
        usecase,
        informations: els(targetsOf(model, "usecaseInformation", usecase.id)),
        conditions: els(targetsOf(model, "usecaseCondition", usecase.id)),
        fromStates: els(sourcesOf(model, "stateUsecase", usecase.id)),
        toStates: els(targetsOf(model, "usecaseState", usecase.id)),
      })),
    })),
  }));
}

// ---------------------------------------------------------------- 6. 課題の分布

export interface IssueSpot {
  element: Element;
  issues: Issue[];
}

export interface IssueByBusiness {
  business: Business | null;
  /** 業務・その作業・その作業が使う操作に付いた課題 (重複なし) */
  issues: Issue[];
  maxSeverity: number;
  /** 課題が付いている要素 (業務 → 作業 → 操作の順) */
  spots: IssueSpot[];
}

/** 業務ごとに、業務・作業・作業が使う操作に付いた課題を集める。どの業務にも辿れない課題は最後にまとめる */
export function issueDistribution(model: UntieModel): IssueByBusiness[] {
  const get = lookup(model);
  const issues = byKind(model, "issue");
  const issuesOn = (id: string) => issues.filter((i) => i.targetIds.includes(id));
  const counted = new Set<string>();
  const build = (business: Business | null, elementIds: string[]): IssueByBusiness => {
    const spots: IssueSpot[] = [];
    const seen = new Set<string>();
    for (const id of elementIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      const on = issuesOn(id);
      const el = get(id);
      if (on.length > 0 && el) spots.push({ element: el, issues: on });
    }
    const all = [...new Map(spots.flatMap((s) => s.issues).map((i) => [i.id, i])).values()].sort((a, b) => b.severity - a.severity);
    for (const i of all) counted.add(i.id);
    return { business, issues: all, maxSeverity: all[0]?.severity ?? 0, spots };
  };
  const result = byKind(model, "business").map((biz) => {
    const bucIds = new Set(byKind(model, "buc").filter((b) => b.businessId === biz.id).map((b) => b.id));
    const acts = byKind(model, "activity").filter((a) => a.bucId && bucIds.has(a.bucId));
    const ucs = acts.flatMap((a) => targetsOf(model, "activityUsecase", a.id));
    return build(biz, [biz.id, ...acts.map((a) => a.id), ...ucs]);
  });
  const rest = issues.filter((i) => !counted.has(i.id));
  if (rest.length > 0) {
    result.push({
      business: null,
      issues: [...rest].sort((a, b) => b.severity - a.severity),
      maxSeverity: Math.max(...rest.map((i) => i.severity)),
      spots: [],
    });
  }
  return result;
}
