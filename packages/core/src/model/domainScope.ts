// 設計モードのドメインボード (5.7) の計算。分析から導いたドメインモデルの候補 (domainModel.ts) と気づき (domainNotices.ts) を、
// 設計の対象のシステムにしぼる。モデルには保存せず、毎回組み立てる純粋関数だけを置く。
//   コマンド・クエリ = 対象がそのシステムの操作 (直接か、そのシステムの画面を使う)
//   イベント       = そのシステムの操作かシステム自身が発生させるもの (内) と、そのシステムの操作のきっかけになる別のところのもの (外)
//   コンテキスト   = そのシステムの操作が扱う情報と、内のイベントが属するコンテキスト。集約はそのシステムの操作が扱う情報だけ
//   用語           = 上に出る情報・状態・バリエーション (と値)・条件・イベント・操作の名前と説明
// 段階 1b では保存するものは無く、しぼり込みは操作の対象から導く (境界づけられたコンテキストのシステムへの割り当ては将来)。
import { commandKey, deriveDomainModel, type AggregateCandidate, type CommandCandidate, type DomainDerivation, type DomainEventRow, type QueryCandidate } from "./domainModel";
import { domainNotices, type DomainNotice } from "./domainNotices";
import { informationPlaces } from "./placement";
import type { Activity, Business, Condition, Context, Element, EventElement, Information, State, UntieModel, Variation } from "./types";

/**
 * ドメインボードで選んでいるもの (UI の状態。保存しない)。id は、保存したものならその id (bc_ / ag_ / cm_ / de_)、候補ならもとの分析の要素の id:
 * context は分析のコンテキスト (null は未分類)、aggregate は情報、event は分析のイベント、command は操作 (作業で分けた候補は <操作の id>/<作業の id>)、query は操作
 */
export type DesignDomainSelection =
  | { kind: "context"; id: string | null }
  | { kind: "aggregate"; id: string }
  | { kind: "event"; id: string }
  | { kind: "command"; id: string }
  | { kind: "query"; id: string };

export interface ScopedAggregate {
  candidate: AggregateCandidate;
  /** このシステムの操作が書く (書かないなら、ほかのところが書く情報を読むだけ) */
  writtenHere: boolean;
  /** この情報を書くこのシステムのコマンド候補 (操作ごとに 1 つ) */
  commandsHere: CommandCandidate[];
  /** この情報を書くほかのシステム・帳票の操作 */
  commandsElsewhere: CommandCandidate[];
  /** 保存先 (システム・帳票) */
  stores: Element[];
  /** ほかに書くシステム (このシステムのほかに、この情報を書く操作の対象のシステム。帳票は入れない) */
  otherWriterSystems: Element[];
}

export interface ScopedEvent {
  row: DomainEventRow;
  /** 内: このシステムの操作かシステム自身が発生させる。外: 別のところで発生し、このシステムの操作のきっかけになる */
  origin: "inside" | "outside";
  /** 発生元の操作の対象 (システム・帳票。外のイベントの出どころを示す) */
  sources: Element[];
  /** 受け手のうち、このシステムの外の操作 (対象の名前つき) */
  outsideConsumers: { usecase: CommandCandidate["usecase"]; place: Element | null }[];
  /** 内のイベントで、このシステムのほかにも発生させるところ (システム・帳票) */
  otherSources: Element[];
}

export interface ScopedContext {
  context: Context | null;
  /** own: このシステムが書く情報か、このシステムが発生させるイベントがある。upstream: このシステムは読むだけ (上流) */
  role: "own" | "upstream";
  aggregates: ScopedAggregate[];
  events: EventElement[];
  stateGroups: string[];
  businesses: Business[];
}

export type ScopedTermKind = "information" | "state" | "variation" | "condition" | "event" | "usecase";

export const DOMAIN_TERM_KINDS: readonly ScopedTermKind[] = ["information", "state", "variation", "condition", "event", "usecase"];

export interface ScopedTerm {
  element: Element;
  kind: ScopedTermKind;
  /** 属するコンテキスト (操作は書く情報か読む情報のコンテキスト) */
  context: Context | null;
  description: string;
  /** バリエーションの値 */
  values: string[];
  /** 同じ語が別のコンテキストに出ている (問い「同じ語が別のコンテキストに出ている」に入っている) */
  homonym: boolean;
}

export interface DomainScope {
  systemId: string;
  /** 操作ごとに 1 つ。作業で分けた候補は、使う作業と担い手を合わせた代表にする (キーは usecase:<id>)。分けた候補はすべて splitCommands に入る */
  commands: CommandCandidate[];
  /** 作業で分けた候補を含むすべて (表で使う) */
  splitCommands: CommandCandidate[];
  queries: QueryCandidate[];
  events: ScopedEvent[];
  contexts: ScopedContext[];
  notices: DomainNotice[];
  terms: ScopedTerm[];
}

const EMPTY: Omit<DomainScope, "systemId"> = { commands: [], splitCommands: [], queries: [], events: [], contexts: [], notices: [], terms: [] };

/** 設計の対象のシステムにしぼる。derivation と notices を渡せば使い回す */
export function buildDomainScope(model: UntieModel, systemId: string, givenDerivation?: DomainDerivation, givenNotices?: DomainNotice[]): DomainScope {
  const byId = new Map(model.elements.map((e) => [e.id, e]));
  const system = byId.get(systemId);
  if (!system || system.kind !== "system") return { systemId, ...EMPTY };
  // システムでないときは導出しない (渡されなければ、ここで初めて導く)
  const derivation = givenDerivation ?? deriveDomainModel(model);
  const notices = givenNotices ?? domainNotices(model, derivation);
  const position = new Map(model.elements.map((e, i) => [e.id, i]));
  const order = <T extends { id: string }>(xs: T[]) => [...xs].sort((a, b) => (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0));

  // コマンド・クエリ (対象がこのシステム)
  const splitCommands = derivation.commands.filter((c) => c.place?.id === systemId);
  // 操作ごとの代表: 作業で分けた候補は、使う作業と担い手を和にする
  const byUsecase = new Map<string, CommandCandidate[]>();
  for (const c of splitCommands) {
    const list = byUsecase.get(c.usecase.id);
    if (list) list.push(c);
    else byUsecase.set(c.usecase.id, [c]);
  }
  const commands: CommandCandidate[] = [...byUsecase.values()].map((cs) => {
    if (cs.length === 1) return cs[0]!;
    const uniqBy = <T extends { id: string }>(xs: T[]) => [...new Map(xs.map((x) => [x.id, x])).values()];
    return { ...cs[0]!, key: commandKey(cs[0]!.usecase.id), activity: null, activities: order(uniqBy(cs.flatMap((c) => c.activities))), actors: order(uniqBy(cs.flatMap((c) => c.actors))) };
  });
  const queries = derivation.queries.filter((q) => q.place?.id === systemId);
  const scopeUsecaseIds = new Set([...commands.map((c) => c.usecase.id), ...queries.map((q) => q.usecase.id)]);

  // 操作 id → 対象 (受け手・発生元の場所を示す)
  const placeOfUsecase = new Map<string, Element | null>();
  for (const c of derivation.commands) placeOfUsecase.set(c.usecase.id, c.place);
  for (const q of derivation.queries) placeOfUsecase.set(q.usecase.id, q.place);

  // イベント
  const insideIds = new Set<string>();
  for (const c of commands) for (const e of c.events) insideIds.add(e.id);
  const outsideIds = new Set<string>();
  for (const c of commands) for (const e of c.triggeredBy) if (!insideIds.has(e.id)) outsideIds.add(e.id);
  const events: ScopedEvent[] = [];
  for (const row of derivation.events) {
    const direct = row.systems.some((s) => s.id === systemId);
    const inside = direct || insideIds.has(row.event.id);
    if (!inside && !outsideIds.has(row.event.id)) continue;
    const sources = order(
      [...new Map([...row.usecases.map((u) => placeOfUsecase.get(u.id)), ...row.systems].filter((p): p is Element => !!p).map((p) => [p.id, p])).values()],
    );
    events.push({
      row,
      origin: inside ? "inside" : "outside",
      sources,
      otherSources: inside ? sources.filter((p) => p.id !== systemId) : [],
      outsideConsumers: row.consumers.usecases.filter((u) => !scopeUsecaseIds.has(u.id)).map((usecase) => ({ usecase, place: placeOfUsecase.get(usecase.id) ?? null })),
    });
  }

  // 集約 (このシステムの操作が扱う情報だけ)
  const handled = new Set<string>();
  for (const c of commands) for (const i of [...c.writes, ...c.reads]) handled.add(i.id);
  for (const q of queries) for (const i of q.reads) handled.add(i.id);
  // 読むだけで状態を変える操作の集約 (持ち主) も入れる
  for (const c of commands) if (c.aggregate) handled.add(c.aggregate.id);
  const places = informationPlaces(model);
  const scopedAggregates = new Map<string, ScopedAggregate>();
  for (const candidate of derivation.aggregates) {
    if (!handled.has(candidate.information.id)) continue;
    const here: CommandCandidate[] = [];
    const elsewhere: CommandCandidate[] = [];
    const seen = new Set<string>();
    for (const c of candidate.commands) {
      if (seen.has(c.usecase.id)) continue;
      seen.add(c.usecase.id);
      (c.place?.id === systemId ? here : elsewhere).push(c);
    }
    const stores = (places.get(candidate.information.id) ?? [])
      .filter((d) => d.roles.includes("store"))
      .map((d) => byId.get(d.id))
      .filter((e): e is Element => !!e);
    const otherWriterSystems = order([...new Map(elsewhere.map((c) => c.place).filter((p): p is Element => !!p && p.kind === "system").map((p) => [p.id, p])).values()]);
    scopedAggregates.set(candidate.information.id, { candidate, writtenHere: here.length > 0, commandsHere: here, commandsElsewhere: elsewhere, stores: order(stores), otherWriterSystems });
  }

  // コンテキスト: このシステムが書く情報か、このシステムが発生させるイベントがあるもの (own) を先に、読むだけのもの (上流) を後に。
  // それぞれ分析のコンテキストの並び順 (未分類は最後)。関わる業務は、このシステムの操作がそのコンテキストの情報を扱う作業の業務だけ
  const insideEventIds = new Set(events.filter((e) => e.origin === "inside").map((e) => e.row.event.id));
  const businessOfActivity = (a: Activity): Business | null => {
    const buc = a.bucId ? byId.get(a.bucId) : undefined;
    const biz = buc && buc.kind === "buc" ? byId.get(buc.businessId) : undefined;
    return biz && biz.kind === "business" ? biz : null;
  };
  const businessesOfInfo = new Map<string, Business[]>();
  const scopeUsecases = [...commands.map((c) => ({ infos: [...c.writes, ...c.reads], activities: c.activities })), ...queries.map((q) => ({ infos: q.reads, activities: q.activities }))];
  for (const u of scopeUsecases) {
    const bizs = u.activities.map(businessOfActivity).filter((b): b is Business => !!b);
    for (const i of u.infos) businessesOfInfo.set(i.id, [...(businessesOfInfo.get(i.id) ?? []), ...bizs]);
  }
  const own: ScopedContext[] = [];
  const upstream: ScopedContext[] = [];
  for (const c of derivation.contexts) {
    const aggregates = c.aggregates.map((a) => scopedAggregates.get(a.information.id)).filter((a): a is ScopedAggregate => !!a);
    const ctxEvents = c.events.filter((e) => insideEventIds.has(e.id));
    if (aggregates.length === 0 && ctxEvents.length === 0) continue;
    const groups = new Set(aggregates.flatMap((a) => a.candidate.stateGroups));
    const businesses = order([...new Map(aggregates.flatMap((a) => businessesOfInfo.get(a.candidate.information.id) ?? []).map((b) => [b.id, b])).values()]);
    const role = aggregates.some((a) => a.writtenHere) || ctxEvents.length > 0 ? "own" : "upstream";
    (role === "own" ? own : upstream).push({ context: c.context, role, aggregates, events: ctxEvents, stateGroups: c.stateGroups.filter((g) => groups.has(g)), businesses });
  }
  const contexts = [...own, ...upstream];

  // 気づき: 主役 (先頭の要素) がしぼった操作・情報・イベント・コンテキストのもの。
  // モデル全体の数を言う気づき (イベントがまだ無い・少ない) は、このシステムの操作が入っているときだけ「モデル全体で」と添えて出す
  const scopeIds = new Set<string>([...scopeUsecaseIds, ...scopedAggregates.keys(), ...events.map((e) => e.row.event.id), ...contexts.map((c) => c.context?.id).filter((id): id is string => !!id)]);
  const scopedNotices: DomainNotice[] = [];
  for (const n of notices) {
    if (n.type === "noEvents" || n.type === "fewEvents") {
      if (n.elementIds.some((id) => scopeUsecaseIds.has(id))) scopedNotices.push({ ...n, message: `モデル全体で、${n.message}` });
      continue;
    }
    const lead = n.elementIds[0];
    if (lead !== undefined && scopeIds.has(lead)) scopedNotices.push(n);
  }

  return {
    systemId,
    commands,
    splitCommands,
    queries,
    events,
    contexts,
    notices: scopedNotices,
    // 用語の「同じ語が別の文脈に」は語そのものの話なので、しぼる前の気づきで見る (相手がほかのシステムの情報でも印を付ける)
    terms: buildTerms(model, byId, order, { commands, queries, events, contexts, notices }),
  };
}

/** 用語: しぼった範囲に出る要素の名前と説明。コンテキストの並び順 → 種類の順 → 要素の並び順 */
function buildTerms(
  model: UntieModel,
  byId: Map<string, Element>,
  order: <T extends { id: string }>(xs: T[]) => T[],
  scope: Pick<DomainScope, "commands" | "queries" | "events" | "contexts" | "notices">,
): ScopedTerm[] {
  const contextOf = (id: string | null | undefined): Context | null => {
    const c = id ? byId.get(id) : undefined;
    return c && c.kind === "context" ? c : null;
  };
  const homonymIds = new Set(scope.notices.filter((n) => n.type === "homonym").flatMap((n) => n.elementIds));
  const terms = new Map<string, ScopedTerm>();
  const add = (element: Element, kind: ScopedTermKind, context: Context | null, values: string[] = []) => {
    if (terms.has(element.id)) return;
    terms.set(element.id, { element, kind, context, description: element.description ?? "", values, homonym: homonymIds.has(element.id) });
  };
  const infos: Information[] = scope.contexts.flatMap((c) => c.aggregates.map((a) => a.candidate.information));
  for (const i of infos) add(i, "information", contextOf(i.contextId));
  const states: State[] = [
    ...scope.contexts.flatMap((c) => c.aggregates.flatMap((a) => a.candidate.states)),
    ...scope.commands.flatMap((c) => [...c.preStates, ...c.postStates]),
  ];
  for (const s of order(states)) add(s, "state", contextOf(s.contextId));
  // バリエーション: 情報の種別と、条件が参照する種別
  const infoIds = new Set(infos.map((i) => i.id));
  const conditions: Condition[] = order(scope.commands.flatMap((c) => c.conditions));
  const conditionIds = new Set(conditions.map((c) => c.id));
  const variations: Variation[] = [];
  for (const r of model.relations) {
    if ((r.kind === "informationVariation" && infoIds.has(r.sourceId)) || (r.kind === "conditionVariation" && conditionIds.has(r.sourceId))) {
      const v = byId.get(r.targetId);
      if (v && v.kind === "variation") variations.push(v);
    }
  }
  for (const v of order(variations)) add(v, "variation", contextOf(v.contextId), v.values);
  for (const c of conditions) add(c, "condition", contextOf(c.contextId));
  for (const e of scope.events) add(e.row.event, "event", e.row.context);
  for (const c of scope.commands) add(c.usecase, "usecase", contextOf(commandContextId(c)));
  for (const q of scope.queries) add(q.usecase, "usecase", contextOf(q.reads[0]?.contextId));
  const contextRank = new Map<string | null, number>(scope.contexts.map((c, i) => [c.context?.id ?? null, i]));
  const rank = (t: ScopedTerm) => contextRank.get(t.context?.id ?? null) ?? contextRank.size;
  const position = new Map(model.elements.map((e, i) => [e.id, i]));
  return [...terms.values()].sort(
    (a, b) => rank(a) - rank(b) || DOMAIN_TERM_KINDS.indexOf(a.kind) - DOMAIN_TERM_KINDS.indexOf(b.kind) || (position.get(a.element.id) ?? 0) - (position.get(b.element.id) ?? 0),
  );
}

/** 選んでいるものが、しぼった範囲にあるか */
export function domainSelectionExists(scope: DomainScope, sel: DesignDomainSelection): boolean {
  if (sel.kind === "context") return scope.contexts.some((c) => (c.context?.id ?? null) === sel.id);
  if (sel.kind === "aggregate") return scope.contexts.some((c) => c.aggregates.some((a) => a.candidate.information.id === sel.id));
  if (sel.kind === "event") return scope.events.some((e) => e.row.event.id === sel.id);
  if (sel.kind === "query") return scope.queries.some((q) => q.usecase.id === sel.id);
  return scope.commands.some((c) => c.usecase.id === sel.id);
}

/**
 * 選んでいるものが、モデルにまだあるか。保存したもの (domain の id) か、候補のもとの分析の要素 (種類も合うか) を見る。
 * このボードに出ているかは見ない (ストアの整合で、毎回しぼり込みをやり直さないため)
 */
export function domainSelectionElementExists(model: UntieModel, sel: DesignDomainSelection): boolean {
  const d = model.domain;
  const has = (id: string, kind: Element["kind"]) => model.elements.some((e) => e.id === id && e.kind === kind);
  if (sel.kind === "context") return sel.id === null || d.contexts.some((c) => c.id === sel.id) || has(sel.id, "context");
  if (sel.kind === "aggregate") return d.aggregates.some((a) => a.id === sel.id) || has(sel.id, "information");
  if (sel.kind === "event") return d.events.some((e) => e.id === sel.id) || has(sel.id, "event");
  if (sel.kind === "query") return has(sel.id, "usecase");
  if (d.commands.some((c) => c.id === sel.id)) return true;
  // 候補のコマンド: 操作の id か、作業で分けた候補の <操作の id>/<作業の id>
  const [usecaseId, activityId] = sel.id.split("/");
  return has(usecaseId ?? "", "usecase") && (activityId === undefined || has(activityId, "activity"));
}

/** 操作のコンテキスト: 集約 (書く情報のうち状態グループの持ち主) → 最初に書く情報 → 最初に読む情報 のコンテキスト */
export function commandContextId(c: Pick<CommandCandidate, "aggregate" | "writes" | "reads">): string | null {
  return (c.aggregate ?? c.writes[0] ?? c.reads[0])?.contextId ?? null;
}

/** 気づきのうち、この要素 (操作・情報・イベント・コンテキスト) が入っているもの */
export function noticesAbout(scope: DomainScope, elementId: string): DomainNotice[] {
  return scope.notices.filter((n) => n.elementIds.includes(elementId));
}
