// 設計モードのドメインボード (5.7) に出すもの: 分析から導いた候補 (domainScope.ts。対象のシステムにしぼったもの) に、保存した判断 (domain。4.6) を重ねる。純粋関数だけを置く。
//   コンテキスト: このシステムが実装する (か、未割り当ての) 保存したコンテキスト。どのコンテキストにも入らない情報は、分析のコンテキストを候補として出す
//   集約:         保存した集約 (ルートと中の情報をまとめる)。どの集約にも入らない情報は、1 情報 1 集約の候補として出す
//   コマンド:     候補を、同じ出どころ (操作と作業) の保存したコマンドで置き換え、外した候補 (excluded) は出さない。分析に無いあるべき姿のコマンドを足す
//   イベント:     同じ分析のイベントを指す保存したイベントで置き換える。あるべき姿のイベントを足す
//   ポリシー:     導いたもの (イベント → 操作) から外した候補を除き、保存したポリシーを足す
// 保存した判断が無ければ、候補だけになる (段階 1b と同じ見え方)。
import { aggregateInformationIds, commandSourceKey, eventCandidateKey, policyCandidateKey } from "./domain";
import { addAggregate, addBoundedContext } from "./domainCommands";
import type { CommandResult } from "./commands";
import { deriveDomainModel, type AggregateRole, type CommandCandidate, type DomainDerivation, type PolicyCandidate } from "./domainModel";
import { buildDomainScope, commandContextId, type DesignDomainSelection, type DomainScope, type ScopedAggregate, type ScopedContext, type ScopedEvent } from "./domainScope";
import type { Aggregate, BoundedContext, DomainCommand, DomainEvent, DomainPolicy, Element, Information, State, UntieModel } from "./types";

export interface ResolvedContext {
  /** 保存したコンテキストなら、その id。候補なら、分析のコンテキストの id (未分類は null) */
  key: string | null;
  saved: BoundedContext | null;
  name: string;
  /** own: このシステムが実装する (候補なら、このシステムが書く情報か発生させるイベントがある)。upstream: このシステムは読むだけ・ほかのシステムのコンテキスト */
  role: "own" | "upstream";
  /** 保存したコンテキストで、実装するシステムが決まっていない */
  unassigned: boolean;
  /** 候補のもと (分析のコンテキストごとのしぼり込み)。保存したコンテキストは、言語の範囲にした分析のコンテキストのもの */
  candidates: ScopedContext[];
  aggregates: ResolvedAggregate[];
}

export interface ResolvedAggregate {
  /** 保存した集約なら、その id。候補なら、情報の id */
  key: string;
  saved: Aggregate | null;
  name: string;
  english?: string;
  contextKey: string | null;
  root: Information;
  members: Information[];
  role: AggregateRole;
  stateGroups: string[];
  states: State[];
  /** このシステムの操作が、ルートか中の情報を書く */
  writtenHere: boolean;
  otherWriterSystems: Element[];
  /** 導いた、情報ごとの中身 (このシステムの操作が扱う情報だけ) */
  scoped: ScopedAggregate[];
}

export interface ResolvedCommand {
  /** 保存したコマンドなら、その id。候補なら、操作の id (作業で分けた候補は <操作の id>/<作業の id>) */
  key: string;
  saved: DomainCommand | null;
  name: string;
  english?: string;
  /** 導いた候補 (分析の操作)。分析に無いあるべき姿のコマンドは null */
  candidate: CommandCandidate | null;
  /** 候補の出どころのキー (外すときに使う)。あるべき姿のコマンドは null */
  sourceKey: string | null;
  aggregateKey: string | null;
  /** 発生させるイベント (ResolvedEvent.key) */
  eventKeys: string[];
}

export interface ResolvedEvent {
  /** 保存したイベントなら、その id。候補なら、分析のイベントの id */
  key: string;
  saved: DomainEvent | null;
  name: string;
  english?: string;
  /** 導いた候補 (分析のイベント)。あるべき姿のイベントは null */
  scoped: ScopedEvent | null;
  sourceKey: string | null;
  origin: "inside" | "outside";
  contextKey: string | null;
  aggregateKey: string | null;
}

export interface ResolvedPolicy {
  /** 保存したポリシーなら、その id。導いたものなら、出どころのキー (policy:<関係の id>) */
  key: string;
  saved: DomainPolicy | null;
  derived: PolicyCandidate | null;
  eventKey: string;
  commandKey: string;
  auto: boolean;
}

export interface ExcludedCandidate {
  key: string;
  kind: "command" | "event" | "policy";
  label: string;
}

export interface ResolvedDomain {
  systemId: string;
  /** 導いた候補 (表・用語・気づき・問い合わせは、ここから出す) */
  scope: DomainScope;
  contexts: ResolvedContext[];
  aggregates: ResolvedAggregate[];
  commands: ResolvedCommand[];
  events: ResolvedEvent[];
  policies: ResolvedPolicy[];
  /** 外した候補 (戻せるように一覧に出す) */
  excluded: ExcludedCandidate[];
  /** まだ保存していない候補の数 (「候補から作る」で作れるもの) */
  unadopted: { contexts: number; aggregates: number };
}

/** 作業で分けた候補の、選択と一覧でのキー */
export const candidateCommandKey = (c: Pick<CommandCandidate, "usecase" | "activity">) => (c.activity ? `${c.usecase.id}/${c.activity.id}` : c.usecase.id);

/** 候補に、保存した判断を重ねる。scope と derivation を渡せば使い回す */
export function resolveDomain(model: UntieModel, systemId: string, givenScope?: DomainScope, givenDerivation?: DomainDerivation): ResolvedDomain {
  const derivation = givenDerivation ?? deriveDomainModel(model);
  const scope = givenScope ?? buildDomainScope(model, systemId, derivation);
  const d = model.domain;
  const byId = new Map(model.elements.map((e) => [e.id, e]));
  const position = new Map(model.elements.map((e, i) => [e.id, i]));
  const info = (id: string): Information | undefined => {
    const e = byId.get(id);
    return e && e.kind === "information" ? e : undefined;
  };
  const statesOf = (group: string): State[] => model.elements.filter((e): e is State => e.kind === "state" && e.group === group);
  const relevant = (bc: BoundedContext) => bc.systemIds.length === 0 || bc.systemIds.includes(systemId);
  const bcById = new Map(d.contexts.map((c) => [c.id, c]));
  const scopedContextOf = new Map<string | null, ScopedContext>(scope.contexts.map((c) => [c.context?.id ?? null, c]));

  // ---- コンテキスト
  const contexts: ResolvedContext[] = [];
  const contextByKey = new Map<string | null, ResolvedContext>();
  const ensureSaved = (bc: BoundedContext, role: "own" | "upstream"): ResolvedContext => {
    let ctx = contextByKey.get(bc.id);
    if (!ctx) {
      ctx = {
        key: bc.id,
        saved: bc,
        name: bc.name,
        role,
        unassigned: bc.systemIds.length === 0,
        candidates: bc.contextIds.map((id) => scopedContextOf.get(id)).filter((c): c is ScopedContext => !!c),
        aggregates: [],
      };
      contextByKey.set(bc.id, ctx);
      contexts.push(ctx);
    }
    return ctx;
  };
  const ensureCandidate = (contextId: string | null): ResolvedContext => {
    let ctx = contextByKey.get(contextId);
    if (!ctx) {
      const sc = scopedContextOf.get(contextId);
      const el = contextId ? byId.get(contextId) : undefined;
      ctx = { key: contextId, saved: null, name: sc?.context?.name ?? el?.name ?? "未分類", role: sc?.role ?? "own", unassigned: false, candidates: sc ? [sc] : [], aggregates: [] };
      contextByKey.set(contextId, ctx);
      contexts.push(ctx);
    }
    return ctx;
  };
  /** 情報・イベントの分析のコンテキストから、保存したコンテキストを探す (このシステムが実装するものを優先。読むだけなら、ほかのシステムのものでもよい) */
  const savedContextFor = (contextId: string | null, readOnly: boolean): BoundedContext | undefined => {
    if (!contextId) return undefined;
    const owners = d.contexts.filter((c) => c.contextIds.includes(contextId));
    return owners.find((c) => c.systemIds.includes(systemId)) ?? owners.find((c) => c.systemIds.length === 0) ?? (readOnly ? owners[0] : undefined);
  };
  for (const bc of d.contexts) if (relevant(bc)) ensureSaved(bc, "own");

  // ---- 集約
  const aggregates: ResolvedAggregate[] = [];
  const aggregateByKey = new Map<string, ResolvedAggregate>();
  const aggregateOfInfo = new Map<string, ResolvedAggregate>();
  const addSavedAggregate = (a: Aggregate, role: "own" | "upstream"): ResolvedAggregate | null => {
    const existing = aggregateByKey.get(a.id);
    if (existing) return existing;
    const root = info(a.rootInformationId);
    const bc = bcById.get(a.boundedContextId);
    if (!root || !bc) return null;
    const ctx = ensureSaved(bc, role);
    const resolved: ResolvedAggregate = {
      key: a.id,
      saved: a,
      name: a.name,
      ...(a.english !== undefined ? { english: a.english } : {}),
      contextKey: bc.id,
      root,
      members: a.memberInformationIds.map(info).filter((i): i is Information => !!i),
      role: a.stateGroup !== undefined ? "lifecycle" : "written",
      stateGroups: a.stateGroup !== undefined ? [a.stateGroup] : [],
      states: a.stateGroup !== undefined ? statesOf(a.stateGroup) : [],
      writtenHere: false,
      otherWriterSystems: [],
      scoped: [],
    };
    aggregates.push(resolved);
    aggregateByKey.set(a.id, resolved);
    ctx.aggregates.push(resolved);
    // 同じ情報が、このボードに出る 2 つの集約に入っていれば、先のものに寄せる
    for (const id of aggregateInformationIds(a)) if (!aggregateOfInfo.has(id)) aggregateOfInfo.set(id, resolved);
    return resolved;
  };
  for (const a of d.aggregates) {
    const bc = bcById.get(a.boundedContextId);
    if (bc && relevant(bc)) addSavedAggregate(a, "own");
  }
  for (const sc of scope.contexts) {
    for (const sa of sc.aggregates) {
      const information = sa.candidate.information;
      let target = aggregateOfInfo.get(information.id);
      if (!target && !sa.writtenHere) {
        // 読むだけの情報は、ほかのシステムのコンテキストの集約でもよい (上流)
        const other = d.aggregates.find((a) => aggregateInformationIds(a).includes(information.id));
        if (other) target = addSavedAggregate(other, "upstream") ?? undefined;
      }
      if (!target) {
        const bc = savedContextFor(information.contextId, !sa.writtenHere);
        const ctx = bc ? ensureSaved(bc, relevant(bc) ? "own" : "upstream") : ensureCandidate(information.contextId);
        target = {
          key: information.id,
          saved: null,
          name: information.name,
          contextKey: ctx.key,
          root: information,
          members: [],
          role: sa.candidate.role,
          stateGroups: sa.candidate.stateGroups,
          states: sa.candidate.states,
          writtenHere: false,
          otherWriterSystems: [],
          scoped: [],
        };
        aggregates.push(target);
        aggregateByKey.set(target.key, target);
        aggregateOfInfo.set(information.id, target);
        ctx.aggregates.push(target);
      }
      target.scoped.push(sa);
      if (sa.writtenHere) target.writtenHere = true;
      for (const s of sa.otherWriterSystems) if (!target.otherWriterSystems.some((x) => x.id === s.id)) target.otherWriterSystems.push(s);
    }
  }
  // 候補の集約は、参照データ (書かれない) なら参照のまま。保存した集約は、このシステムが書かなければ参照として見せる (UI 側で writtenHere を見る)

  // ---- コマンド
  const excludedSet = new Set(d.excluded);
  const excluded: ExcludedCandidate[] = [];
  const savedBySource = new Map<string, DomainCommand>();
  for (const c of d.commands) if (c.source) savedBySource.set(commandSourceKey(c.source), c);
  const candidateByKey = new Map<string, CommandCandidate>();
  for (const c of derivation.commands) candidateByKey.set(c.key, c);
  const commands: ResolvedCommand[] = [];
  const commandBySavedId = new Map<string, ResolvedCommand>();
  const commandsOfUsecase = new Map<string, ResolvedCommand[]>();
  const used = new Set<string>();
  /** 保存したコマンドの集約が、このボードに出るようにする (ほかのシステムのコンテキストなら上流として足す) */
  const aggregateKeyOfSaved = (c: DomainCommand): string | null => {
    const shown = aggregateByKey.get(c.aggregateId);
    if (shown) return shown.key;
    const a = d.aggregates.find((x) => x.id === c.aggregateId);
    return a ? (addSavedAggregate(a, "upstream")?.key ?? null) : null;
  };
  const pushCommand = (cand: CommandCandidate | null, saved: DomainCommand | null) => {
    const usecase = cand?.usecase;
    const resolved: ResolvedCommand = {
      key: saved?.id ?? candidateCommandKey(cand!),
      saved,
      name: saved?.name ?? usecase!.name,
      ...(saved?.english !== undefined ? { english: saved.english } : {}),
      candidate: cand,
      sourceKey: saved?.source ? commandSourceKey(saved.source) : (cand?.key ?? null),
      aggregateKey: saved ? aggregateKeyOfSaved(saved) : cand!.aggregate ? (aggregateOfInfo.get(cand!.aggregate.id)?.key ?? null) : null,
      eventKeys: [],
    };
    commands.push(resolved);
    if (saved) {
      commandBySavedId.set(saved.id, resolved);
      used.add(saved.id);
    }
    if (usecase) {
      const list = commandsOfUsecase.get(usecase.id);
      if (list) list.push(resolved);
      else commandsOfUsecase.set(usecase.id, [resolved]);
    }
    return resolved;
  };
  const splitsOf = new Map<string, CommandCandidate[]>();
  for (const c of scope.splitCommands) {
    const list = splitsOf.get(c.usecase.id);
    if (list) list.push(c);
    else splitsOf.set(c.usecase.id, [c]);
  }
  for (const merged of scope.commands) {
    const splits = splitsOf.get(merged.usecase.id) ?? [];
    // 作業ごとのコマンドを 1 つでも保存したか外したら、その操作は作業ごとに出す
    const bySplit = splits.length > 1 && splits.some((s) => savedBySource.has(s.key) || excludedSet.has(s.key));
    for (const cand of bySplit ? splits : [merged]) {
      if (excludedSet.has(cand.key)) {
        excluded.push({ key: cand.key, kind: "command", label: cand.activity ? `${cand.usecase.name} (作業: ${cand.activity.name})` : cand.usecase.name });
        continue;
      }
      pushCommand(cand, savedBySource.get(cand.key) ?? null);
    }
  }
  // あるべき姿のコマンドと、対象がこのシステムでなくなった操作から採用したコマンド。このシステムが実装する (か、未割り当ての) コンテキストの集約のものだけ
  // (読むだけの上流のコンテキストのコマンドは出さない)
  const ownAggregateIds = new Set(d.aggregates.filter((a) => bcById.get(a.boundedContextId) && relevant(bcById.get(a.boundedContextId)!)).map((a) => a.id));
  for (const c of d.commands) {
    if (used.has(c.id) || !ownAggregateIds.has(c.aggregateId) || !aggregateByKey.has(c.aggregateId)) continue;
    const cand = c.source ? (candidateByKey.get(commandSourceKey(c.source)) ?? null) : null;
    pushCommand(cand, c);
  }

  // ---- イベント
  const savedByEvent = new Map<string, DomainEvent>();
  for (const e of d.events) if (e.eventId !== undefined) savedByEvent.set(e.eventId, e);
  const events: ResolvedEvent[] = [];
  const eventByKey = new Map<string, ResolvedEvent>();
  const eventOfAnalysis = new Map<string, ResolvedEvent>();
  const usedEvents = new Set<string>();
  const contextKeyOfSavedEvent = (e: DomainEvent): string | null => {
    const bc = bcById.get(e.boundedContextId);
    return bc ? ensureSaved(bc, relevant(bc) ? "own" : "upstream").key : null;
  };
  for (const se of scope.events) {
    const ev = se.row.event;
    const sourceKey = eventCandidateKey(ev.id);
    if (excludedSet.has(sourceKey)) {
      excluded.push({ key: sourceKey, kind: "event", label: ev.name });
      continue;
    }
    const saved = savedByEvent.get(ev.id) ?? null;
    let aggregateKey: string | null = null;
    let contextKey: string | null = null;
    if (saved) {
      contextKey = contextKeyOfSavedEvent(saved);
      aggregateKey = saved.aggregateId !== undefined ? (aggregateByKey.get(saved.aggregateId)?.key ?? null) : null;
    } else if (se.origin === "inside") {
      // 発生させるコマンドの集約。無ければ、分析のコンテキストから
      const emitter = commands.find((c) => c.candidate?.events.some((x) => x.id === ev.id) && c.aggregateKey !== null);
      aggregateKey = emitter?.aggregateKey ?? null;
      const aggregate = aggregateKey !== null ? aggregateByKey.get(aggregateKey) : undefined;
      if (aggregate) contextKey = aggregate.contextKey;
      else {
        const bc = savedContextFor(ev.contextId, false);
        contextKey = bc ? ensureSaved(bc, "own").key : ensureCandidate(ev.contextId).key;
      }
    } else {
      // 外のイベント: 分析のコンテキストを持つ保存したコンテキストがあれば、そこ (上流)
      const bc = savedContextFor(ev.contextId, true);
      contextKey = bc && !relevant(bc) ? ensureSaved(bc, "upstream").key : null;
    }
    const resolved: ResolvedEvent = {
      key: saved?.id ?? ev.id,
      saved,
      name: saved?.name ?? ev.name,
      ...(saved?.english !== undefined ? { english: saved.english } : {}),
      scoped: se,
      sourceKey,
      // 保存したイベントが、このシステムの外のコンテキストのものなら外
      origin: saved ? (bcById.get(saved.boundedContextId) && relevant(bcById.get(saved.boundedContextId)!) && se.origin === "inside" ? "inside" : se.origin) : se.origin,
      contextKey,
      aggregateKey,
    };
    events.push(resolved);
    eventByKey.set(resolved.key, resolved);
    eventOfAnalysis.set(ev.id, resolved);
    if (saved) usedEvents.add(saved.id);
  }
  // あるべき姿のイベント: このシステムが実装する (か、未割り当ての) コンテキストのものと、ほかのコンテキストのイベントで、このボードのコマンドのきっかけになる (保存したポリシー)・このボードのコマンドが発生させるもの
  const linkedEvents = new Set<string>();
  for (const p of d.policies) if (commandBySavedId.has(p.commandId)) linkedEvents.add(p.eventId);
  for (const c of commands) for (const id of c.saved?.emits ?? []) linkedEvents.add(id);
  for (const e of d.events) {
    if (usedEvents.has(e.id)) continue;
    const bc = bcById.get(e.boundedContextId);
    if (!bc || (!relevant(bc) && !linkedEvents.has(e.id))) continue;
    ensureSaved(bc, relevant(bc) ? "own" : "upstream");
    const resolved: ResolvedEvent = {
      key: e.id,
      saved: e,
      name: e.name,
      ...(e.english !== undefined ? { english: e.english } : {}),
      scoped: null,
      sourceKey: e.eventId !== undefined ? eventCandidateKey(e.eventId) : null,
      origin: relevant(bc) ? "inside" : "outside",
      contextKey: bc.id,
      aggregateKey: e.aggregateId !== undefined ? (aggregateByKey.get(e.aggregateId)?.key ?? null) : null,
    };
    events.push(resolved);
    eventByKey.set(resolved.key, resolved);
    if (e.eventId !== undefined) eventOfAnalysis.set(e.eventId, resolved);
  }
  // コマンドが発生させるイベント (導いたものと、保存した emits)
  for (const c of commands) {
    const keys = new Set<string>();
    for (const ev of c.candidate?.events ?? []) {
      const r = eventOfAnalysis.get(ev.id);
      if (r) keys.add(r.key);
    }
    for (const id of c.saved?.emits ?? []) if (eventByKey.has(id)) keys.add(id);
    c.eventKeys = [...keys];
  }

  // ---- ポリシー
  const policies: ResolvedPolicy[] = [];
  const pairs = new Set<string>();
  for (const p of derivation.policies) {
    const targets = commandsOfUsecase.get(p.usecase.id);
    const event = eventOfAnalysis.get(p.event.id);
    const sourceKey = policyCandidateKey(p.key);
    if (excludedSet.has(sourceKey)) {
      if (scope.commands.some((c) => c.usecase.id === p.usecase.id)) excluded.push({ key: sourceKey, kind: "policy", label: `${p.event.name} → ${p.usecase.name}` });
      continue;
    }
    if (!targets || !event) continue;
    for (const target of targets) {
      pairs.add(`${event.key}\n${target.key}`);
      policies.push({ key: targets.length > 1 ? `${sourceKey}@${target.key}` : sourceKey, saved: null, derived: p, eventKey: event.key, commandKey: target.key, auto: p.auto });
    }
  }
  for (const p of d.policies) {
    const event = eventByKey.get(p.eventId);
    const command = commandBySavedId.get(p.commandId);
    if (!event || !command || pairs.has(`${event.key}\n${command.key}`)) continue;
    policies.push({ key: p.id, saved: p, derived: null, eventKey: event.key, commandKey: command.key, auto: p.auto });
  }

  // 並び: コンテキストは 自分 → 上流。集約は要素の並び順 (保存した集約はルートの情報の位置)
  const rank = (c: ResolvedContext) => (c.role === "own" ? 0 : 1);
  const sortedContexts = contexts.map((c, i) => ({ c, i })).sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i).map((x) => x.c);
  for (const c of sortedContexts) c.aggregates.sort((a, b) => (position.get(a.root.id) ?? 0) - (position.get(b.root.id) ?? 0));
  // 候補のコンテキストの役割は、中の集約から決め直す (このシステムが書く情報か、発生させるイベントがあれば自分)
  for (const c of sortedContexts) {
    if (c.saved) continue;
    const own = c.aggregates.some((a) => a.writtenHere) || events.some((e) => e.origin === "inside" && e.contextKey === c.key);
    c.role = own ? "own" : "upstream";
  }
  sortedContexts.sort((a, b) => rank(a) - rank(b));

  const unadopted = {
    contexts: sortedContexts.filter((c) => !c.saved && c.key !== null && c.role === "own").length,
    aggregates: aggregates.filter((a) => !a.saved && a.writtenHere && a.root.contextId !== null).length,
  };
  return { systemId, scope, contexts: sortedContexts, aggregates, commands, events, policies, excluded, unadopted };
}

/** 選んでいるものが、このボードに出ているか */
export function resolvedSelectionExists(r: ResolvedDomain, sel: DesignDomainSelection): boolean {
  if (sel.kind === "context") return r.contexts.some((c) => c.key === sel.id);
  if (sel.kind === "aggregate") return r.aggregates.some((a) => a.key === sel.id);
  if (sel.kind === "event") return r.events.some((e) => e.key === sel.id);
  if (sel.kind === "query") return r.scope.queries.some((q) => q.usecase.id === sel.id);
  return r.commands.some((c) => c.key === sel.id);
}

/**
 * 選択を、いまボードに出ているもののキーに合わせる (出ていなければ undefined)。
 * 候補を選んでいるあいだに保存される (自分が名前を付ける・ほかの人が採用する) と、キーが分析の要素の id から保存した id に変わるので、もとの要素から探し直す
 */
export function normalizeDomainSelection(r: ResolvedDomain, sel: DesignDomainSelection | undefined): DesignDomainSelection | undefined {
  if (!sel) return undefined;
  if (resolvedSelectionExists(r, sel)) return sel;
  const id = sel.id;
  if (id === null) return undefined;
  if (sel.kind === "context") {
    const c = r.contexts.find((x) => x.saved?.contextIds.includes(id));
    return c ? { kind: "context", id: c.key } : undefined;
  }
  if (sel.kind === "aggregate") {
    const a = r.aggregates.find((x) => x.root.id === id) ?? r.aggregates.find((x) => x.members.some((m) => m.id === id));
    return a ? { kind: "aggregate", id: a.key } : undefined;
  }
  if (sel.kind === "event") {
    const e = r.events.find((x) => x.scoped?.row.event.id === id);
    return e ? { kind: "event", id: e.key } : undefined;
  }
  if (sel.kind === "command") {
    const c = r.commands.find((x) => x.candidate && candidateCommandKey(x.candidate) === id) ?? r.commands.find((x) => x.candidate?.usecase.id === id.split("/")[0]);
    return c ? { kind: "command", id: c.key } : undefined;
  }
  return undefined;
}

/** コマンドのコンテキスト (集約のコンテキスト。集約が無ければ、候補の操作が扱う情報のコンテキストから) */
export function resolvedCommandContextKey(r: ResolvedDomain, c: ResolvedCommand): string | null {
  const aggregate = c.aggregateKey !== null ? r.aggregates.find((a) => a.key === c.aggregateKey) : undefined;
  if (aggregate) return aggregate.contextKey;
  return c.candidate ? commandContextId(c.candidate) : null;
}

/**
 * まだ保存していない候補を、まとめて保存する (AI を使わない下書き)。
 * このシステムが書く情報か発生させるイベントのある分析のコンテキストを、境界づけられたコンテキスト (実装先はこのシステム) にし、
 * このシステムが書く情報を、1 情報 1 集約 (状態グループの持ち主ならその状態グループつき) にする。コンテキストに属していない情報は採用しない。
 * すでに保存したものは変えない
 */
export function adoptDomainCandidates(model: UntieModel, payload: { systemId: string }): CommandResult<{ contexts: number; aggregates: number }> {
  const system = model.elements.find((e) => e.id === payload.systemId);
  if (!system || system.kind !== "system") return { ok: false, reason: `システムが存在しません: ${payload.systemId}` };
  const resolved = resolveDomain(model, payload.systemId);
  let next = model;
  let contexts = 0;
  let aggregates = 0;
  for (const ctx of resolved.contexts) {
    if (ctx.role !== "own" || (ctx.saved === null && ctx.key === null)) continue;
    let bcId = ctx.saved?.id;
    if (bcId === undefined) {
      const r = addBoundedContext(next, { name: ctx.name, contextIds: [ctx.key!], systemIds: [payload.systemId] });
      if (!r.ok) return r;
      next = r.model;
      bcId = r.id;
      contexts++;
    }
    for (const a of ctx.aggregates) {
      if (a.saved || !a.writtenHere) continue;
      const r = addAggregate(next, { boundedContextId: bcId, rootInformationId: a.root.id, ...(a.stateGroups[0] !== undefined ? { stateGroup: a.stateGroups[0] } : {}) });
      // ほかの集約に入っているなどで足せないものは飛ばす
      if (!r.ok) continue;
      next = r.model;
      aggregates++;
    }
  }
  return { ok: true, model: next, contexts, aggregates };
}
