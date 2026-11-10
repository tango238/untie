// 分析からドメインモデル (DDD) の候補を導く。モデルには保存せず、毎回モデルから組み立てる純粋関数だけを置く。
// 分析 (RDRA) の要素は変えず、「導けるものは導き、決めるのは人」の線で候補と根拠を出す。
//   コマンド候補  = 情報を書く (access が write か省略) 操作。複数の作業が使う操作は (作業 × 操作) の組ごとに分ける (意図が違いうる)
//   クエリ候補    = 扱う情報がすべて read の操作と、その画面 (読み取りモデルの表示先)
//   ドメインイベント = 分析のイベント。発生元 (操作・システム・時間)、属性候補 (発生元が書く情報)、受け手
//   ポリシー候補  = イベント → 操作 (eventUsecase)。起こされる操作が作業に属さなければ自動
//   集約候補      = 状態グループの持ち主の情報 (ルート候補)、書かれる情報 (1 情報 1 集約の仮置き)、書かれない情報 (参照データ)
//   コンテキスト候補 = 分析のコンテキストごとの所属要素と、関わる業務・担当
// 気づき (問い・情報) は domainNotices.ts で、ここの結果から組み立てる。
import { accessRoles, usecasePlaces } from "./placement";
import type {
  Activity,
  Business,
  Condition,
  Context,
  Element,
  EventElement,
  Information,
  Relation,
  Screen,
  State,
  UntieModel,
  Usecase,
  Variation,
} from "./types";

// ---------------------------------------------------------------- 型

/** コマンド候補の出どころのキー。操作だけなら "usecase:<id>"、作業で分けたら "usecase:<id>/activity:<id>" */
export type CommandKey = string;

export function commandKey(usecaseId: string, activityId?: string | null): CommandKey {
  return activityId ? `usecase:${usecaseId}/activity:${activityId}` : `usecase:${usecaseId}`;
}

export interface CommandCandidate {
  key: CommandKey;
  usecase: Usecase;
  /** 作業ごとに分けたときの作業。分けていなければ null */
  activity: Activity | null;
  /** この操作を使う作業 (分けたときはその 1 つ)。作業に属さない自動の処理なら空 */
  activities: Activity[];
  /** 実行する人 (作業の担当。アクター・外部アクター)。自動の処理なら空 */
  actors: Element[];
  /** 作業に属さず、イベントをきっかけに動く自動の処理 */
  auto: boolean;
  /** 書く情報 (access が write か省略) */
  writes: Information[];
  /** 読む情報 (access が read か省略) */
  reads: Information[];
  /** 実行できる状態 (stateUsecase) */
  preStates: State[];
  /** 実行後の状態 (usecaseState) */
  postStates: State[];
  /** 判断に使う条件 */
  conditions: Condition[];
  /** 発生させるイベント */
  events: EventElement[];
  /** きっかけのイベント */
  triggeredBy: EventElement[];
  /** 対象 (システム・帳票。画面ならその画面のシステム) */
  place: Element | null;
  /** 集約の候補 (書く情報のうち、状態グループの持ち主を優先。無ければ最初に書く情報) */
  aggregate: Information | null;
}

export interface QueryCandidate {
  usecase: Usecase;
  reads: Information[];
  screen: Screen | null;
  activities: Activity[];
  /** 読むだけなのに発生させるイベント (純粋な問い合わせではない) */
  events: EventElement[];
  /** 読むだけなのに遷移させる状態 */
  postStates: State[];
}

export interface DomainEventRow {
  event: EventElement;
  /** 発生させる操作 */
  usecases: Usecase[];
  /** 直接発生させるシステム */
  systems: Element[];
  /** 発生タイミングを持つ (時間のイベント。コマンド無しで発生元はシステム) */
  timed: boolean;
  /** 属性の候補 = 発生させる操作が書く情報 */
  properties: Information[];
  /** 受け手 */
  consumers: { usecases: Usecase[]; activities: Activity[] };
  /** 分析のコンテキスト */
  context: Context | null;
}

export interface PolicyCandidate {
  /** 出どころのキー (eventUsecase の関係の id) */
  key: string;
  event: EventElement;
  usecase: Usecase;
  /** 起こされる操作が作業に属さない (自動) */
  auto: boolean;
  activities: Activity[];
  /** イベントのコンテキストと、操作が書く情報のコンテキストが違う (コンテキストをまたぐ統合イベント) */
  crossesContext: boolean;
}

export type AggregateRole = "lifecycle" | "written" | "reference";

export const AGGREGATE_ROLE_LABELS: Record<AggregateRole, string> = {
  lifecycle: "ルート候補 (状態を持つ)",
  written: "集約候補",
  reference: "参照データ (書く操作なし)",
};

export interface AggregateCandidate {
  information: Information;
  role: AggregateRole;
  context: Context | null;
  /** 持ち主になっている状態グループ (lifecycle のとき) */
  stateGroup: string | null;
  states: State[];
  /** 書くコマンド候補 */
  commands: CommandCandidate[];
  /** 関連する情報 (informationRelated。無向)。既定は ID 参照とみなす */
  related: Information[];
  /** 同じ操作で一緒に書かれる情報 (同じ集約かの問い) */
  coWritten: Information[];
}

export interface StateGroupOwner {
  group: string;
  states: State[];
  /** 持ち主の情報 (遷移させる操作が最も多く書く情報。決まらなければ null) */
  owner: Information | null;
  /** 候補 (書かれる回数の多い順) */
  candidates: { information: Information; count: number }[];
  /** この状態グループの状態へ遷移させる操作 (usecaseState) */
  usecases: Usecase[];
}

export interface ContextCandidate {
  /** 分析のコンテキスト (未分類なら null) */
  context: Context | null;
  informations: Information[];
  states: State[];
  stateGroups: string[];
  conditions: Condition[];
  variations: Variation[];
  events: EventElement[];
  /** 所属する情報を扱う操作を使う業務 */
  businesses: Business[];
  aggregates: AggregateCandidate[];
}

export interface DomainDerivation {
  commands: CommandCandidate[];
  queries: QueryCandidate[];
  events: DomainEventRow[];
  policies: PolicyCandidate[];
  stateGroups: StateGroupOwner[];
  aggregates: AggregateCandidate[];
  contexts: ContextCandidate[];
}

// ---------------------------------------------------------------- 共通

type Lookup = <T extends Element = Element>(id: string) => T | undefined;

function lookup(model: UntieModel): Lookup {
  const byId = new Map(model.elements.map((e) => [e.id, e]));
  return <T extends Element = Element>(id: string) => byId.get(id) as T | undefined;
}

function byKind<K extends Element["kind"]>(model: UntieModel, kind: K): Extract<Element, { kind: K }>[] {
  return model.elements.filter((e): e is Extract<Element, { kind: K }> => e.kind === kind);
}

function orderOf(model: UntieModel) {
  const order = new Map(model.elements.map((e, i) => [e.id, i]));
  return <T extends Element>(xs: T[]): T[] => [...xs].sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
}

function uniq<T extends { id: string }>(xs: T[]): T[] {
  const seen = new Set<string>();
  return xs.filter((x) => (seen.has(x.id) ? false : (seen.add(x.id), true)));
}

/** 関係を種類ごとに引く索引 */
function index(model: UntieModel) {
  const bySource = new Map<string, Relation[]>();
  const byTarget = new Map<string, Relation[]>();
  for (const r of model.relations) {
    bySource.set(`${r.kind}:${r.sourceId}`, [...(bySource.get(`${r.kind}:${r.sourceId}`) ?? []), r]);
    byTarget.set(`${r.kind}:${r.targetId}`, [...(byTarget.get(`${r.kind}:${r.targetId}`) ?? []), r]);
  }
  return {
    targets: (kind: Relation["kind"], sourceId: string) => bySource.get(`${kind}:${sourceId}`) ?? [],
    sources: (kind: Relation["kind"], targetId: string) => byTarget.get(`${kind}:${targetId}`) ?? [],
  };
}

/** 操作が扱う情報を、書く (write か省略) と読む (read か省略) に分ける */
function informationAccess(get: Lookup, rels: ReturnType<typeof index>, usecaseId: string) {
  const writes: Information[] = [];
  const reads: Information[] = [];
  for (const r of rels.targets("usecaseInformation", usecaseId)) {
    const info = get<Information>(r.targetId);
    if (!info || info.kind !== "information") continue;
    const roles = accessRoles(r.access);
    if (roles.includes("store")) writes.push(info);
    if (roles.includes("source")) reads.push(info);
  }
  return { writes, reads };
}

// ---------------------------------------------------------------- 導出

/** 状態グループごとに、遷移させる操作と持ち主の候補を集める */
export function stateGroupOwners(model: UntieModel): StateGroupOwner[] {
  const get = lookup(model);
  const rels = index(model);
  const order = orderOf(model);
  const groups = new Map<string, State[]>();
  for (const s of byKind(model, "state")) {
    if (!s.group) continue;
    groups.set(s.group, [...(groups.get(s.group) ?? []), s]);
  }
  const result: StateGroupOwner[] = [];
  for (const [group, states] of groups) {
    // 持ち主は「次の状態」(usecaseState) へ遷移させる操作が書く情報で決める。「実行できる状態」(stateUsecase) は前提なので数えない
    const usecaseIds = new Set<string>();
    for (const s of states) for (const r of rels.sources("usecaseState", s.id)) usecaseIds.add(r.sourceId);
    const usecases = order([...usecaseIds].map((id) => get<Usecase>(id)).filter((u): u is Usecase => !!u && u.kind === "usecase"));
    const counts = new Map<string, { information: Information; count: number }>();
    for (const u of usecases) {
      for (const info of informationAccess(get, rels, u.id).writes) {
        const cur = counts.get(info.id) ?? { information: info, count: 0 };
        counts.set(info.id, { information: info, count: cur.count + 1 });
      }
    }
    const candidates = [...counts.values()].sort((a, b) => b.count - a.count);
    const owner = candidates.length > 0 && (candidates.length === 1 || candidates[0]!.count > candidates[1]!.count) ? candidates[0]!.information : null;
    result.push({ group, states, owner, candidates, usecases });
  }
  return result;
}

/** 分析からドメインモデルの候補を導く */
export function deriveDomainModel(model: UntieModel): DomainDerivation {
  const get = lookup(model);
  const rels = index(model);
  const order = orderOf(model);
  const places = usecasePlaces(model);
  const stateGroups = stateGroupOwners(model);
  const ownerOf = new Map<string, string>(); // 情報 id → 持ち主になっている状態グループ
  for (const g of stateGroups) if (g.owner && !ownerOf.has(g.owner.id)) ownerOf.set(g.owner.id, g.group);

  const activitiesOf = (usecaseId: string): Activity[] =>
    order(rels.sources("activityUsecase", usecaseId).map((r) => get<Activity>(r.sourceId)).filter((a): a is Activity => !!a && a.kind === "activity"));
  const actorsOf = (activities: Activity[]): Element[] =>
    uniq(
      order(
        activities.flatMap((a) =>
          rels.sources("actorActivity", a.id).map((r) => get(r.sourceId)).filter((e): e is Element => !!e && (e.kind === "actor" || e.kind === "externalActor")),
        ),
      ),
    );
  const eventsOf = (usecaseId: string): EventElement[] =>
    order(rels.targets("usecaseEvent", usecaseId).map((r) => get<EventElement>(r.targetId)).filter((e): e is EventElement => !!e && e.kind === "event"));
  const triggersOf = (usecaseId: string): EventElement[] =>
    order(rels.sources("eventUsecase", usecaseId).map((r) => get<EventElement>(r.sourceId)).filter((e): e is EventElement => !!e && e.kind === "event"));
  const statesOf = (kind: "stateUsecase" | "usecaseState", usecaseId: string): State[] => {
    const ids = kind === "stateUsecase" ? rels.sources(kind, usecaseId).map((r) => r.sourceId) : rels.targets(kind, usecaseId).map((r) => r.targetId);
    return order(ids.map((id) => get<State>(id)).filter((s): s is State => !!s && s.kind === "state"));
  };
  const conditionsOf = (usecaseId: string): Condition[] =>
    order(rels.targets("usecaseCondition", usecaseId).map((r) => get<Condition>(r.targetId)).filter((c): c is Condition => !!c && c.kind === "condition"));
  const screenOf = (usecaseId: string): Screen | null => {
    const r = rels.targets("usecaseScreen", usecaseId)[0];
    const s = r ? get<Screen>(r.targetId) : undefined;
    return s && s.kind === "screen" ? s : null;
  };
  const contextOf = (id: string | null | undefined): Context | null => {
    const c = id ? get<Context>(id) : undefined;
    return c && c.kind === "context" ? c : null;
  };

  // コマンド候補とクエリ候補
  const commands: CommandCandidate[] = [];
  const queries: QueryCandidate[] = [];
  for (const u of byKind(model, "usecase")) {
    const { writes, reads } = informationAccess(get, rels, u.id);
    const activities = activitiesOf(u.id);
    const events = eventsOf(u.id);
    const postStates = statesOf("usecaseState", u.id);
    if (writes.length === 0) {
      if (reads.length > 0) queries.push({ usecase: u, reads, screen: screenOf(u.id), activities, events, postStates });
      continue;
    }
    const aggregate = writes.find((w) => ownerOf.has(w.id)) ?? writes[0] ?? null;
    const base = {
      usecase: u,
      auto: activities.length === 0,
      writes,
      reads,
      preStates: statesOf("stateUsecase", u.id),
      postStates,
      conditions: conditionsOf(u.id),
      events,
      triggeredBy: triggersOf(u.id),
      place: (() => {
        const p = places.get(u.id);
        return p ? (get(p) ?? null) : null;
      })(),
      aggregate,
    };
    if (activities.length >= 2) {
      // 複数の作業が使う操作は、作業ごとに意図が違いうるので (作業 × 操作) の組に分ける
      for (const a of activities) commands.push({ key: commandKey(u.id, a.id), activity: a, activities: [a], actors: actorsOf([a]), ...base });
    } else {
      commands.push({ key: commandKey(u.id), activity: null, activities, actors: actorsOf(activities), ...base });
    }
  }

  // ドメインイベント
  const events: DomainEventRow[] = byKind(model, "event").map((event) => {
    const usecases = order(rels.sources("usecaseEvent", event.id).map((r) => get<Usecase>(r.sourceId)).filter((u): u is Usecase => !!u && u.kind === "usecase"));
    const systems = order(rels.sources("systemEvent", event.id).map((r) => get(r.sourceId)).filter((s): s is Element => !!s && s.kind === "system"));
    const properties = uniq(order(usecases.flatMap((u) => informationAccess(get, rels, u.id).writes)));
    const consumerUsecases = order(rels.targets("eventUsecase", event.id).map((r) => get<Usecase>(r.targetId)).filter((u): u is Usecase => !!u && u.kind === "usecase"));
    const consumerActivities = order(rels.targets("eventActivity", event.id).map((r) => get<Activity>(r.targetId)).filter((a): a is Activity => !!a && a.kind === "activity"));
    return {
      event,
      usecases,
      systems,
      timed: !!event.timing,
      properties,
      consumers: { usecases: consumerUsecases, activities: consumerActivities },
      context: contextOf(event.contextId),
    };
  });

  // ポリシー候補
  const policies: PolicyCandidate[] = [];
  for (const r of model.relations) {
    if (r.kind !== "eventUsecase") continue;
    const event = get<EventElement>(r.sourceId);
    const usecase = get<Usecase>(r.targetId);
    if (!event || event.kind !== "event" || !usecase || usecase.kind !== "usecase") continue;
    const activities = activitiesOf(usecase.id);
    const writes = informationAccess(get, rels, usecase.id).writes;
    const writeContexts = new Set(writes.map((w) => w.contextId).filter((c): c is string => !!c));
    const crossesContext = !!event.contextId && writeContexts.size > 0 && !writeContexts.has(event.contextId);
    policies.push({ key: r.id, event, usecase, auto: activities.length === 0, activities, crossesContext });
  }

  // 集約候補
  const writesByUsecase = new Map(commands.map((c) => [c.usecase.id, c.writes]));
  const aggregates: AggregateCandidate[] = byKind(model, "information").map((info) => {
    const writers = commands.filter((c) => c.writes.some((w) => w.id === info.id));
    const group = ownerOf.get(info.id) ?? null;
    const role: AggregateRole = group ? "lifecycle" : writers.length > 0 ? "written" : "reference";
    const related = order(
      uniq(
        [...rels.targets("informationRelated", info.id).map((r) => r.targetId), ...rels.sources("informationRelated", info.id).map((r) => r.sourceId)]
          .map((id) => get<Information>(id))
          .filter((i): i is Information => !!i && i.kind === "information"),
      ),
    );
    const coWritten = order(uniq(uniq(writers.map((c) => c.usecase)).flatMap((u) => (writesByUsecase.get(u.id) ?? []).filter((w) => w.id !== info.id))));
    return {
      information: info,
      role,
      context: contextOf(info.contextId),
      stateGroup: group,
      states: group ? (stateGroups.find((g) => g.group === group)?.states ?? []) : [],
      commands: writers,
      related,
      coWritten,
    };
  });

  // コンテキスト候補 (分析のコンテキストごと + 未分類)
  const contextIds: (string | null)[] = [...byKind(model, "context").map((c) => c.id), null];
  const contexts: ContextCandidate[] = contextIds
    .map((cid) => {
      const inCtx = <T extends { contextId: string | null }>(xs: T[]) => xs.filter((x) => x.contextId === cid);
      const informations = inCtx(byKind(model, "information"));
      const states = inCtx(byKind(model, "state"));
      const infoIds = new Set(informations.map((i) => i.id));
      const businesses = uniq(
        order(
          byKind(model, "usecase")
            .filter((u) => rels.targets("usecaseInformation", u.id).some((r) => infoIds.has(r.targetId)))
            .flatMap((u) => activitiesOf(u.id))
            .flatMap((a) => {
              const buc = a.bucId ? get(a.bucId) : undefined;
              const biz = buc && buc.kind === "buc" ? get<Business>(buc.businessId) : undefined;
              return biz && biz.kind === "business" ? [biz] : [];
            }),
        ),
      );
      return {
        context: contextOf(cid),
        informations,
        states,
        stateGroups: [...new Set(states.map((s) => s.group).filter((g): g is string => !!g))],
        conditions: inCtx(byKind(model, "condition")),
        variations: inCtx(byKind(model, "variation")),
        events: inCtx(byKind(model, "event")),
        businesses,
        aggregates: aggregates.filter((a) => a.information.contextId === cid),
      };
    })
    // 未分類は、入るものがあるときだけ
    .filter((c) => c.context || c.informations.length + c.states.length + c.conditions.length + c.variations.length + c.events.length > 0);

  return { commands, queries, events, policies, stateGroups, aggregates, contexts };
}
