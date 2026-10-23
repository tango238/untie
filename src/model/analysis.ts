// 分析ボードの計算。モデルには保存せず、毎回モデルから組み立てる。純粋関数だけを置く。
import { defaultBucOf } from "./selectors";
import {
  type Activity,
  type Buc,
  type Business,
  type Element,
  type Issue,
  type Relation,
  type UntieModel,
  type Usecase,
} from "./types";

export const ANALYSIS_KINDS = ["people", "informationLocation", "issues"] as const;
export type AnalysisKind = (typeof ANALYSIS_KINDS)[number];

export const ANALYSIS_LABELS: Record<AnalysisKind, string> = {
  people: "担当別の作業一覧",
  informationLocation: "情報の所在",
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

// ---------------------------------------------------------------- 2. 情報の所在

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

// ---------------------------------------------------------------- 3. 課題の分布

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
