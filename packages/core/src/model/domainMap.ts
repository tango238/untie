// コンテキストマップ (5.7) の下敷き: 保存した境界づけられたコンテキストどうしの、導いたつながり。純粋関数だけを置く。
//   イベント: あるコンテキストのイベントが、別のコンテキストのコマンドのきっかけになる (発生元が上流)
//   取得:     あるコンテキストのコマンドが、別のコンテキストの集約の情報を読む (読まれる側が上流)
// 関係の種類 (顧客 / 供給者・腐敗防止層など) は導けないので、人が決める (domain.relations)。ここは向きと根拠だけを出す。
import { aggregateInformationIds, commandSourceKey, eventCandidateKey, policyCandidateKey, SYMMETRIC_RELATION_KINDS } from "./domain";
import { deriveDomainModel, type CommandCandidate, type DomainDerivation } from "./domainModel";
import type { BoundedContext, ContextRelation, UntieModel } from "./types";

export interface ContextFlow {
  upstreamId: string;
  downstreamId: string;
  /** 上流のイベントが、下流のコマンドのきっかけになる (イベントの名前) */
  events: string[];
  /** 下流のコマンドが読む、上流の情報 (情報の名前) */
  reads: string[];
  /** この向きに保存した関係 (対等な関係は、どちら向きに保存してあってもこの向きのものとする)。無ければ null */
  relation: ContextRelation | null;
  /** 逆向きに保存した、向きのある関係 (この向きの関係が無いときだけ)。どちらも無ければ、この組は未決 */
  reverseRelation: ContextRelation | null;
}

export interface ContextMap {
  contexts: BoundedContext[];
  flows: ContextFlow[];
  /** 導いたつながりの無い、保存した関係 */
  relationsWithoutFlow: ContextRelation[];
}

/** 保存したコンテキストどうしの、導いたつながりと保存した関係。derivation を渡せば使い回す */
export function deriveContextMap(model: UntieModel, derivation: DomainDerivation = deriveDomainModel(model)): ContextMap {
  const d = model.domain;
  const contextOfAggregate = new Map(d.aggregates.map((a) => [a.id, a.boundedContextId]));
  /** 情報 id → それを集約に持つコンテキスト */
  const contextsOfInfo = new Map<string, string[]>();
  for (const a of d.aggregates) {
    for (const id of aggregateInformationIds(a)) {
      const list = contextsOfInfo.get(id);
      if (list) {
        if (!list.includes(a.boundedContextId)) list.push(a.boundedContextId);
      } else contextsOfInfo.set(id, [a.boundedContextId]);
    }
  }
  const withAggregates = new Set(d.aggregates.map((a) => a.boundedContextId));
  /** そのシステムだけを実装先にする、集約の無いコンテキスト (外部のコンテキスト) */
  const externalOfSystem = (systemId: string | undefined): string | undefined =>
    systemId === undefined ? undefined : d.contexts.find((c) => !withAggregates.has(c.id) && c.systemIds.includes(systemId))?.id;
  const savedBySource = new Map(d.commands.filter((c) => c.source).map((c) => [commandSourceKey(c.source!), c]));
  const excluded = new Set(d.excluded);

  /** コマンド候補のコンテキスト: 保存したコマンドの集約 → 書く情報の集約 (対象のシステムが実装するものを優先) → 対象のシステムの外部のコンテキスト */
  const contextOfCandidate = (c: CommandCandidate): string | undefined => {
    const saved = savedBySource.get(c.key) ?? savedBySource.get(commandSourceKey({ usecaseId: c.usecase.id }));
    if (saved) return contextOfAggregate.get(saved.aggregateId);
    const owners = [...new Set(c.writes.flatMap((w) => contextsOfInfo.get(w.id) ?? []))];
    if (owners.length > 0) {
      const placeId = c.place?.id;
      return owners.find((id) => placeId !== undefined && d.contexts.find((x) => x.id === id)?.systemIds.includes(placeId)) ?? owners[0];
    }
    return externalOfSystem(c.place?.kind === "system" ? c.place.id : undefined);
  };
  const candidatesOfUsecase = new Map<string, CommandCandidate[]>();
  for (const c of derivation.commands) {
    const list = candidatesOfUsecase.get(c.usecase.id);
    if (list) list.push(c);
    else candidatesOfUsecase.set(c.usecase.id, [c]);
  }
  const savedByEvent = new Map(d.events.filter((e) => e.eventId !== undefined).map((e) => [e.eventId!, e]));
  /** 分析のイベントのコンテキスト: 保存したイベント → 発生させるコマンド → 直接発生させるシステムの外部のコンテキスト */
  const contextOfEvent = (eventId: string): string | undefined => {
    const saved = savedByEvent.get(eventId);
    if (saved) return saved.boundedContextId;
    const row = derivation.events.find((e) => e.event.id === eventId);
    if (!row) return undefined;
    for (const u of row.usecases) {
      for (const c of candidatesOfUsecase.get(u.id) ?? []) {
        const ctx = contextOfCandidate(c);
        if (ctx) return ctx;
      }
    }
    for (const s of row.systems) {
      const ctx = externalOfSystem(s.id);
      if (ctx) return ctx;
    }
    return undefined;
  };

  const flows = new Map<string, ContextFlow>();
  const flow = (upstreamId: string, downstreamId: string): ContextFlow => {
    const key = `${upstreamId}\n${downstreamId}`;
    let f = flows.get(key);
    if (!f) {
      f = { upstreamId, downstreamId, events: [], reads: [], relation: null, reverseRelation: null };
      flows.set(key, f);
    }
    return f;
  };
  const push = (list: string[], name: string) => {
    if (!list.includes(name)) list.push(name);
  };

  // イベント → 操作 (導いたポリシー。外した候補は除く)
  for (const p of derivation.policies) {
    if (excluded.has(policyCandidateKey(p.key)) || excluded.has(eventCandidateKey(p.event.id))) continue;
    const up = contextOfEvent(p.event.id);
    if (!up) continue;
    for (const c of candidatesOfUsecase.get(p.usecase.id) ?? []) {
      if (excluded.has(c.key)) continue;
      const down = contextOfCandidate(c);
      if (down && down !== up) push(flow(up, down).events, savedByEvent.get(p.event.id)?.name ?? p.event.name);
    }
  }
  // 保存したポリシー
  const eventById = new Map(d.events.map((e) => [e.id, e]));
  const commandById = new Map(d.commands.map((c) => [c.id, c]));
  for (const p of d.policies) {
    const event = eventById.get(p.eventId);
    const command = commandById.get(p.commandId);
    const down = command ? contextOfAggregate.get(command.aggregateId) : undefined;
    if (event && down && event.boundedContextId !== down) push(flow(event.boundedContextId, down).events, event.name);
  }
  // 取得: コマンドが、別のコンテキストの集約の情報を読む
  for (const c of derivation.commands) {
    if (excluded.has(c.key)) continue;
    const down = contextOfCandidate(c);
    if (!down) continue;
    for (const r of c.reads) {
      const owners = contextsOfInfo.get(r.id) ?? [];
      if (owners.length === 0 || owners.includes(down)) continue;
      for (const up of owners) push(flow(up, down).reads, r.name);
    }
  }

  // 保存した関係を組に付ける。同じ向きのもの (対等な関係は向きを問わない) を先に探し、無ければ逆向きのものを添える
  const used = new Set<string>();
  const known = new Set(d.contexts.map((c) => c.id));
  const list = [...flows.values()].filter((f) => known.has(f.upstreamId) && known.has(f.downstreamId));
  for (const f of list) {
    const same = d.relations.find((r) => r.upstreamId === f.upstreamId && r.downstreamId === f.downstreamId);
    const reverse = d.relations.find((r) => r.upstreamId === f.downstreamId && r.downstreamId === f.upstreamId);
    if (same) f.relation = same;
    else if (reverse && SYMMETRIC_RELATION_KINDS.has(reverse.kind)) f.relation = reverse;
    else if (reverse) f.reverseRelation = reverse;
    const hit = f.relation ?? f.reverseRelation;
    if (hit) used.add(hit.id);
  }
  const order = new Map(d.contexts.map((c, i) => [c.id, i]));
  list.sort((a, b) => (order.get(a.upstreamId) ?? 0) - (order.get(b.upstreamId) ?? 0) || (order.get(a.downstreamId) ?? 0) - (order.get(b.downstreamId) ?? 0));
  return { contexts: d.contexts, flows: list, relationsWithoutFlow: d.relations.filter((r) => !used.has(r.id)) };
}
