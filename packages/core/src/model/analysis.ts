// 分析ボードの計算。モデルには保存せず、毎回モデルから組み立てる。純粋関数だけを置く。
import { informationPlaces, screenInformations, type PlaceRole } from "./placement";
import { defaultBucOf, issueScope } from "./selectors";
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

/** ボードの選択肢に並べる順。課題から紐解くので、課題の分布を先頭に置く */
export const ANALYSIS_KINDS = ["issues", "people", "informationLocation", "storming"] as const;
export type AnalysisKind = (typeof ANALYSIS_KINDS)[number];

export const ANALYSIS_LABELS: Record<AnalysisKind, string> = {
  people: "担当別の作業一覧",
  informationLocation: "情報の所在",
  issues: "課題の分布",
  storming: "イベントストーミング",
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

/** 担い手 (アクター・外部アクター) ごとに、担当する作業を業務・活動の順に並べる。担当の無い作業は最後にまとめる (0.2.0 からシステムは作業の担当にならない) */
export function performerWorkList(model: UntieModel): { performers: PerformerWork[]; unassigned: ActivitySection[] } {
  const get = lookup(model);
  const activities = byKind(model, "activity");
  const performers = model.elements
    .filter((e) => e.kind === "actor" || e.kind === "externalActor")
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

/** 置き場所での役割 (取得元・保存先)。0.4.0 から、扱う操作の access と対象から導く (placement.ts) */
export type LocationRole = PlaceRole;

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

/** 情報ごとに、取得元・保存先のシステム・帳票を並べる (扱う操作の対象から導く) */
export function informationLocations(model: UntieModel): { places: Element[]; rows: InformationLocation[] } {
  const get = lookup(model);
  const places = model.elements.filter((e) => e.kind === "system" || e.kind === "ledger");
  const derived = informationPlaces(model);
  const rows = byKind(model, "information").map((info) => {
    const map = new Map<string, LocationRole[]>();
    for (const d of derived.get(info.id) ?? []) if (get(d.id)) map.set(d.id, [...d.roles]);
    const flags: InformationLocation["flags"] = [];
    if (map.size === 0) flags.push("noPlace");
    else if ([...map.keys()].every((id) => get(id)?.kind === "ledger")) flags.push("paperOnly");
    if ([...map.values()].filter((roles) => roles.includes("store")).length >= 2) flags.push("multipleStores");
    return { information: info, places: map, usecaseCount: sourcesOf(model, "usecaseInformation", info.id).length, flags };
  });
  return { places, rows };
}

export interface ScreenInformationRow {
  screen: Element;
  /** この画面を使う操作 (要素の並び順) */
  usecases: Element[];
  /** 情報 id → 役割 (取得・保存)。扱わない情報は入れない。扱う情報は、この画面を使う操作が扱う情報から導く */
  cells: Map<string, LocationRole[]>;
  /** 扱う情報が 1 つも無い */
  noInformation: boolean;
}

export interface ScreenInformationTable {
  system: Element;
  /** 列: このシステムの画面のどれかが扱う情報 (要素の並び順) */
  informations: Element[];
  rows: ScreenInformationRow[];
}

/**
 * システムごとに、画面 × 情報の表を組み立てる (情報の所在の分析ボードの 2 つ目の表)。
 * 画面が扱う情報は、その画面を使う操作が扱う情報から導く (0.4.0 から。画面に別に結ばないので、置き場所とずれない)。
 * 画面の無いシステムは表を作らず、systemsWithoutScreens に並べる。帳票は画面を持たないので入れない
 */
export function screenInformationTables(model: UntieModel): { tables: ScreenInformationTable[]; systemsWithoutScreens: Element[] } {
  const order = new Map(model.elements.map((e, i) => [e.id, i]));
  const get = lookup(model);
  const byOrder = (ids: Iterable<string>) => [...new Set(ids)].map((id) => get(id)).filter((e): e is Element => !!e).sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  const screens = byKind(model, "screen");
  const derived = screenInformations(model);
  const tables: ScreenInformationTable[] = [];
  const systemsWithoutScreens: Element[] = [];
  for (const sys of byKind(model, "system")) {
    const own = screens.filter((sc) => sc.systemId === sys.id);
    if (own.length === 0) {
      systemsWithoutScreens.push(sys);
      continue;
    }
    const rows = own.map((screen) => {
      const infos = (derived.get(screen.id) ?? []).filter((d) => get(d.id)?.kind === "information");
      const ordered = byOrder(infos.map((d) => d.id));
      const cells = new Map<string, LocationRole[]>(ordered.map((i) => [i.id, [...infos.find((d) => d.id === i.id)!.roles]]));
      return { screen, usecases: byOrder(sourcesOf(model, "usecaseScreen", screen.id)), cells, noInformation: cells.size === 0 };
    });
    tables.push({ system: sys, informations: byOrder(rows.flatMap((r) => [...r.cells.keys()])), rows });
  }
  return { tables, systemsWithoutScreens };
}

/** イベントをきっかけにする操作と、その操作が属する作業 */
export interface EventTrigger {
  usecase: Element;
  /** この操作を使う作業 (要素の並び順)。作業に属さない自動の処理なら空 */
  activities: Element[];
}

export interface SystemEventRow {
  event: Element;
  /** システムが直接発生させる (システム → イベント) */
  direct: boolean;
  /** このシステムを対象にした操作のうち、このイベントを発生させるもの (要素の並び順) */
  usecases: Element[];
  /** このイベントをきっかけにする操作 (要素の並び順) */
  triggers: EventTrigger[];
}

export interface SystemEventList {
  system: Element;
  /** 行: このシステムから発生するイベント (要素の並び順) */
  rows: SystemEventRow[];
}

/**
 * システムごとに、そのシステムから発生するイベントを並べる (情報の所在の分析ボードの 3 つ目の一覧)。
 * 発生のしかたは 2 つ: システムが直接発生させる (systemEvent) と、そのシステムを対象にした操作が発生させる (usecaseEvent)。
 * 操作の対象のシステムは、対象がシステムならそのシステム、画面ならその画面が属するシステム (帳票はシステムではないので数えない)。
 * イベントの無いシステムは systemsWithoutEvents に、どのシステムにもつながらないイベントは eventsWithoutSystem に並べる
 */
export function systemEventLists(model: UntieModel): { lists: SystemEventList[]; systemsWithoutEvents: Element[]; eventsWithoutSystem: Element[] } {
  const order = new Map(model.elements.map((e, i) => [e.id, i]));
  const get = lookup(model);
  const byOrder = (ids: Iterable<string>) => [...new Set(ids)].map((id) => get(id)).filter((e): e is Element => !!e).sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  /** 操作の対象のシステム (無ければ null) */
  const systemOfUsecase = (usecaseId: string): string | null => {
    for (const r of model.relations) {
      if (r.sourceId !== usecaseId) continue;
      if (r.kind === "usecaseSystem" && get(r.targetId)?.kind === "system") return r.targetId;
      if (r.kind === "usecaseScreen") {
        const screen = get(r.targetId);
        if (screen && "systemId" in screen && screen.systemId) return screen.systemId;
      }
    }
    return null;
  };
  const triggersOf = (eventId: string): EventTrigger[] =>
    byOrder(targetsOf(model, "eventUsecase", eventId))
      .filter((u) => u.kind === "usecase")
      .map((usecase) => ({ usecase, activities: byOrder(sourcesOf(model, "activityUsecase", usecase.id)).filter((a) => a.kind === "activity") }));

  const linked = new Set<string>();
  const lists: SystemEventList[] = [];
  const systemsWithoutEvents: Element[] = [];
  for (const sys of byKind(model, "system")) {
    const direct = new Set(targetsOf(model, "systemEvent", sys.id));
    const viaUsecase = new Map<string, string[]>();
    for (const r of model.relations) {
      if (r.kind !== "usecaseEvent" || systemOfUsecase(r.sourceId) !== sys.id) continue;
      viaUsecase.set(r.targetId, [...(viaUsecase.get(r.targetId) ?? []), r.sourceId]);
    }
    const events = byOrder([...direct, ...viaUsecase.keys()]).filter((e) => e.kind === "event");
    if (events.length === 0) {
      systemsWithoutEvents.push(sys);
      continue;
    }
    for (const e of events) linked.add(e.id);
    lists.push({
      system: sys,
      rows: events.map((event) => ({
        event,
        direct: direct.has(event.id),
        usecases: byOrder(viaUsecase.get(event.id) ?? []),
        triggers: triggersOf(event.id),
      })),
    });
  }
  return { lists, systemsWithoutEvents, eventsWithoutSystem: byKind(model, "event").filter((e) => !linked.has(e.id)) };
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

/**
 * 業務ごとに、業務・作業・作業が使う操作に付いた課題を集める。どの業務にも辿れない具体的な課題は最後にまとめる。
 * 対象の無い未整理の課題も入れない (この分析の別の表で見る)。
 * 登場人物が対象の全体的な課題は業務に属さないので入れない (課題一覧と、この分析の別の表で見る)
 */
export function issueDistribution(model: UntieModel): IssueByBusiness[] {
  const get = lookup(model);
  const issues = byKind(model, "issue").filter((i) => issueScope(model, i) === "specific");
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
