// 分析からドメインモデル (DDD) の候補を導く。モデルには保存せず、毎回モデルから組み立てる純粋関数だけを置く。
// 分析 (RDRA) の要素は変えず、「導けるものは導き、決めるのは人」の線で候補と根拠を出す。
//   コマンド候補  = 情報を書く (access が write か省略) か、イベントを発生させるか、次の状態へ遷移させる操作。
//                   複数の作業が使う操作は (作業 × 操作) の組ごとに分ける (意図が違いうる)
//   クエリ候補    = 情報を読むだけで、イベントも状態の遷移も持たない操作と、その画面 (読み取りモデルの表示先)
//   ドメインイベント = 分析のイベント。発生元 (操作・システム・時間)、属性候補 (発生元が書く情報)、受け手
//   ポリシー候補  = イベント → 操作 (eventUsecase)。起こされる操作が作業に属さなければ自動
//   集約候補      = 状態グループの持ち主の情報 (ルート候補)、書かれる情報 (1 情報 1 集約の仮置き)、書かれない情報 (参照データ)
//   コンテキスト候補 = 分析のコンテキストごとの所属要素と、関わる業務
// 気づき (問い・情報) は domainNotices.ts で、ここの結果から組み立てる。
// 要素 数千・関係 数万でも使えるよう、関係は種類ごとの索引を 1 回作って引く (O(要素 + 関係))。
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
  /** この操作を使う作業 (分けたときはその 1 つ)。作業に属さなければ空 */
  activities: Activity[];
  /** 実行する人 (作業の担当。アクター・外部アクター)。作業に属さなければ空 */
  actors: Element[];
  /** 作業に属さず、イベントをきっかけに動く自動の処理 (作業にもきっかけにも結んでいない書きかけの操作は自動にしない) */
  auto: boolean;
  /** 情報を書かない (読むだけでイベントを発生させる、または状態を変える) */
  readOnly: boolean;
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
  /** 集約の候補 (書く情報のうち、状態グループの持ち主を優先。書かない操作なら、変える状態グループの持ち主。無ければ最初に書く情報) */
  aggregate: Information | null;
}

/** 読むだけで、イベントも状態の遷移も持たない操作 (純粋な問い合わせ) */
export interface QueryCandidate {
  usecase: Usecase;
  reads: Information[];
  screen: Screen | null;
  activities: Activity[];
  place: Element | null;
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
  /** 持ち主になっている状態グループ (lifecycle のとき。ふつう 1 つ) */
  stateGroups: string[];
  /** 持ち主になっている状態グループの状態 (グループの順) */
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
  /** 持ち主の情報 (次の状態へ遷移させる操作が最も多く書く情報。決まらなければ null) */
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

// ---------------------------------------------------------------- 索引

type Lookup = <T extends Element = Element>(id: string) => T | undefined;

interface Index {
  get: Lookup;
  /** 要素の並び順で並べ替える */
  order: <T extends Element>(xs: T[]) => T[];
  targets: (kind: Relation["kind"], sourceId: string) => Relation[];
  sources: (kind: Relation["kind"], targetId: string) => Relation[];
  /** 種類 K の要素 */
  ofKind: <K extends Element["kind"]>(kind: K) => Extract<Element, { kind: K }>[];
}

function buildIndex(model: UntieModel): Index {
  const byId = new Map<string, Element>();
  const position = new Map<string, number>();
  const kinds = new Map<Element["kind"], Element[]>();
  model.elements.forEach((e, i) => {
    byId.set(e.id, e);
    position.set(e.id, i);
    const list = kinds.get(e.kind);
    if (list) list.push(e);
    else kinds.set(e.kind, [e]);
  });
  const bySource = new Map<string, Relation[]>();
  const byTarget = new Map<string, Relation[]>();
  const add = (map: Map<string, Relation[]>, key: string, r: Relation) => {
    const list = map.get(key);
    if (list) list.push(r);
    else map.set(key, [r]);
  };
  for (const r of model.relations) {
    add(bySource, `${r.kind}:${r.sourceId}`, r);
    add(byTarget, `${r.kind}:${r.targetId}`, r);
  }
  return {
    get: <T extends Element = Element>(id: string) => byId.get(id) as T | undefined,
    order: <T extends Element>(xs: T[]) => [...xs].sort((a, b) => (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0)),
    targets: (kind, sourceId) => bySource.get(`${kind}:${sourceId}`) ?? [],
    sources: (kind, targetId) => byTarget.get(`${kind}:${targetId}`) ?? [],
    ofKind: <K extends Element["kind"]>(kind: K) => (kinds.get(kind) ?? []) as Extract<Element, { kind: K }>[],
  };
}

function uniq<T extends { id: string }>(xs: T[]): T[] {
  const seen = new Set<string>();
  return xs.filter((x) => (seen.has(x.id) ? false : (seen.add(x.id), true)));
}

/** 関係の相手を、種類で絞って並び順で返す (存在しない id・別の種類は捨てる。同じ相手が 2 本あっても 1 つ) */
function related<K extends Element["kind"]>(ix: Index, rels: Relation[], side: "source" | "target", kind: K): Extract<Element, { kind: K }>[] {
  type T = Extract<Element, { kind: K }>;
  return ix.order(uniq(rels.map((r) => ix.get<T>(side === "source" ? r.sourceId : r.targetId)).filter((e): e is T => !!e && e.kind === kind)));
}

/** 操作が扱う情報を、書く (write か省略) と読む (read か省略) に分ける (同じ情報が複数の関係で結ばれていても 1 つ) */
function informationAccess(ix: Index, usecaseId: string): { writes: Information[]; reads: Information[] } {
  const writes: Information[] = [];
  const reads: Information[] = [];
  for (const r of ix.targets("usecaseInformation", usecaseId)) {
    const info = ix.get<Information>(r.targetId);
    if (!info || info.kind !== "information") continue;
    const roles = accessRoles(r.access);
    if (roles.includes("store")) writes.push(info);
    if (roles.includes("source")) reads.push(info);
  }
  return { writes: ix.order(uniq(writes)), reads: ix.order(uniq(reads)) };
}

// ---------------------------------------------------------------- 導出

function stateGroupOwnersWith(ix: Index): StateGroupOwner[] {
  const groups = new Map<string, State[]>();
  for (const s of ix.ofKind("state")) {
    if (!s.group) continue;
    const list = groups.get(s.group);
    if (list) list.push(s);
    else groups.set(s.group, [s]);
  }
  const result: StateGroupOwner[] = [];
  for (const [group, states] of groups) {
    // 持ち主は「次の状態」(usecaseState) へ遷移させる操作が書く情報で決める。「実行できる状態」(stateUsecase) は前提なので数えない
    const usecases = related(ix, states.flatMap((s) => ix.sources("usecaseState", s.id)), "source", "usecase");
    const counts = new Map<string, { information: Information; count: number }>();
    for (const u of usecases) {
      for (const info of informationAccess(ix, u.id).writes) {
        const cur = counts.get(info.id);
        if (cur) cur.count += 1;
        else counts.set(info.id, { information: info, count: 1 });
      }
    }
    const candidates = [...counts.values()].sort((a, b) => b.count - a.count);
    const owner = candidates.length > 0 && (candidates.length === 1 || candidates[0]!.count > candidates[1]!.count) ? candidates[0]!.information : null;
    result.push({ group, states, owner, candidates, usecases });
  }
  return result;
}

/** 状態グループごとに、遷移させる操作と持ち主の候補を集める */
export function stateGroupOwners(model: UntieModel): StateGroupOwner[] {
  return stateGroupOwnersWith(buildIndex(model));
}

/** 分析からドメインモデルの候補を導く */
export function deriveDomainModel(model: UntieModel): DomainDerivation {
  const ix = buildIndex(model);
  const places = usecasePlaces(model);
  const stateGroups = stateGroupOwnersWith(ix);
  const ownerOf = new Map<string, string[]>(); // 情報 id → 持ち主になっている状態グループ
  for (const g of stateGroups) {
    if (!g.owner) continue;
    const list = ownerOf.get(g.owner.id);
    if (list) list.push(g.group);
    else ownerOf.set(g.owner.id, [g.group]);
  }
  const ownerByGroup = new Map(stateGroups.map((g) => [g.group, g]));

  const activitiesOf = (usecaseId: string) => related(ix, ix.sources("activityUsecase", usecaseId), "source", "activity");
  const actorsOf = (activities: Activity[]): Element[] =>
    ix.order(
      uniq(
        activities.flatMap((a) =>
          ix.sources("actorActivity", a.id).map((r) => ix.get(r.sourceId)).filter((e): e is Element => !!e && (e.kind === "actor" || e.kind === "externalActor")),
        ),
      ),
    );
  const placeOf = (usecaseId: string): Element | null => {
    const p = places.get(usecaseId);
    return p ? (ix.get(p) ?? null) : null;
  };
  const contextOf = (id: string | null | undefined): Context | null => {
    const c = id ? ix.get<Context>(id) : undefined;
    return c && c.kind === "context" ? c : null;
  };

  // コマンド候補とクエリ候補
  const commands: CommandCandidate[] = [];
  const queries: QueryCandidate[] = [];
  for (const u of ix.ofKind("usecase")) {
    const { writes, reads } = informationAccess(ix, u.id);
    const activities = activitiesOf(u.id);
    const events = related(ix, ix.targets("usecaseEvent", u.id), "target", "event");
    const postStates = related(ix, ix.targets("usecaseState", u.id), "target", "state");
    const place = placeOf(u.id);
    if (writes.length === 0 && events.length === 0 && postStates.length === 0) {
      if (reads.length > 0) {
        const screen = ix.targets("usecaseScreen", u.id).map((r) => ix.get<Screen>(r.targetId)).find((s): s is Screen => !!s && s.kind === "screen") ?? null;
        queries.push({ usecase: u, reads, screen, activities, place });
      }
      continue;
    }
    const triggeredBy = related(ix, ix.sources("eventUsecase", u.id), "source", "event");
    const postGroupOwner = postStates.map((s) => (s.group ? ownerByGroup.get(s.group)?.owner : undefined)).find((o): o is Information => !!o);
    const aggregate = writes.find((w) => ownerOf.has(w.id)) ?? (writes.length > 0 ? writes[0]! : (postGroupOwner ?? null));
    const base = {
      usecase: u,
      auto: activities.length === 0 && triggeredBy.length > 0,
      readOnly: writes.length === 0,
      writes,
      reads,
      preStates: related(ix, ix.sources("stateUsecase", u.id), "source", "state"),
      postStates,
      conditions: related(ix, ix.targets("usecaseCondition", u.id), "target", "condition"),
      events,
      triggeredBy,
      place,
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
  const events: DomainEventRow[] = ix.ofKind("event").map((event) => {
    const usecases = related(ix, ix.sources("usecaseEvent", event.id), "source", "usecase");
    return {
      event,
      usecases,
      systems: related(ix, ix.sources("systemEvent", event.id), "source", "system"),
      timed: !!event.timing,
      properties: ix.order(uniq(usecases.flatMap((u) => informationAccess(ix, u.id).writes))),
      consumers: {
        usecases: related(ix, ix.targets("eventUsecase", event.id), "target", "usecase"),
        activities: related(ix, ix.targets("eventActivity", event.id), "target", "activity"),
      },
      context: contextOf(event.contextId),
    };
  });

  // ポリシー候補
  const policies: PolicyCandidate[] = [];
  for (const r of model.relations) {
    if (r.kind !== "eventUsecase") continue;
    const event = ix.get<EventElement>(r.sourceId);
    const usecase = ix.get<Usecase>(r.targetId);
    if (!event || event.kind !== "event" || !usecase || usecase.kind !== "usecase") continue;
    const activities = activitiesOf(usecase.id);
    const writeContexts = new Set(informationAccess(ix, usecase.id).writes.map((w) => w.contextId).filter((c): c is string => !!c));
    const crossesContext = !!event.contextId && writeContexts.size > 0 && !writeContexts.has(event.contextId);
    policies.push({ key: r.id, event, usecase, auto: activities.length === 0, activities, crossesContext });
  }

  // 集約候補 (情報 id → 書くコマンド候補 の索引を先に作る)
  const writersOf = new Map<string, CommandCandidate[]>();
  for (const c of commands) {
    for (const w of c.writes) {
      const list = writersOf.get(w.id);
      if (list) list.push(c);
      else writersOf.set(w.id, [c]);
    }
  }
  const aggregates: AggregateCandidate[] = ix.ofKind("information").map((info) => {
    const writers = writersOf.get(info.id) ?? [];
    const groups = ownerOf.get(info.id) ?? [];
    const role: AggregateRole = groups.length > 0 ? "lifecycle" : writers.length > 0 ? "written" : "reference";
    const relatedInfos = ix.order(
      uniq(
        [
          ...ix.targets("informationRelated", info.id).map((r) => ix.get<Information>(r.targetId)),
          ...ix.sources("informationRelated", info.id).map((r) => ix.get<Information>(r.sourceId)),
        ].filter((i): i is Information => !!i && i.kind === "information"),
      ),
    );
    const coWritten = ix.order(uniq(writers.flatMap((c) => c.writes).filter((w) => w.id !== info.id)));
    return {
      information: info,
      role,
      context: contextOf(info.contextId),
      stateGroups: groups,
      states: groups.flatMap((g) => ownerByGroup.get(g)?.states ?? []),
      commands: writers,
      related: relatedInfos,
      coWritten,
    };
  });

  // コンテキスト候補 (分析のコンテキストごと + 未分類)。所属要素は 1 回の走査で contextId 別に振り分ける
  interface Members {
    informations: Information[];
    states: State[];
    conditions: Condition[];
    variations: Variation[];
    events: EventElement[];
  }
  const members = new Map<string | null, Members>();
  const bucket = (cid: string | null): Members => {
    let b = members.get(cid);
    if (!b) {
      b = { informations: [], states: [], conditions: [], variations: [], events: [] };
      members.set(cid, b);
    }
    return b;
  };
  for (const e of model.elements) {
    if (e.kind === "information") bucket(e.contextId).informations.push(e);
    else if (e.kind === "state") bucket(e.contextId).states.push(e);
    else if (e.kind === "condition") bucket(e.contextId).conditions.push(e);
    else if (e.kind === "variation") bucket(e.contextId).variations.push(e);
    else if (e.kind === "event") bucket(e.contextId).events.push(e);
  }
  // 情報 id → 扱う操作を使う業務
  const businessOfActivity = (a: Activity): Business | null => {
    const buc = a.bucId ? ix.get(a.bucId) : undefined;
    const biz = buc && buc.kind === "buc" ? ix.get<Business>(buc.businessId) : undefined;
    return biz && biz.kind === "business" ? biz : null;
  };
  const businessesOfInfo = new Map<string, Business[]>();
  for (const u of ix.ofKind("usecase")) {
    const bizs = activitiesOf(u.id).map(businessOfActivity).filter((b): b is Business => !!b);
    if (bizs.length === 0) continue;
    for (const r of ix.targets("usecaseInformation", u.id)) {
      const list = businessesOfInfo.get(r.targetId);
      if (list) list.push(...bizs);
      else businessesOfInfo.set(r.targetId, [...bizs]);
    }
  }
  const aggregatesByContext = new Map<string | null, AggregateCandidate[]>();
  for (const a of aggregates) {
    const list = aggregatesByContext.get(a.information.contextId);
    if (list) list.push(a);
    else aggregatesByContext.set(a.information.contextId, [a]);
  }
  const contextIds: (string | null)[] = [...ix.ofKind("context").map((c) => c.id), null];
  const contexts: ContextCandidate[] = contextIds
    .map((cid) => {
      const b = members.get(cid) ?? { informations: [], states: [], conditions: [], variations: [], events: [] };
      return {
        context: contextOf(cid),
        ...b,
        stateGroups: [...new Set(b.states.map((s) => s.group).filter((g): g is string => !!g))],
        businesses: ix.order(uniq(b.informations.flatMap((i) => businessesOfInfo.get(i.id) ?? []))),
        aggregates: aggregatesByContext.get(cid) ?? [],
      };
    })
    // 未分類は、入るものがあるときだけ
    .filter((c) => c.context || c.informations.length + c.states.length + c.conditions.length + c.variations.length + c.events.length > 0);

  return { commands, queries, events, policies, stateGroups, aggregates, contexts };
}
