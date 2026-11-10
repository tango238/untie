// ドメインボード (5.7) で、分析から導いた候補を採用して保存する (domain。4.6)。純粋関数だけを置く。
// 候補のコマンドやイベントに名前・英語名を付けるには、受け持つ集約とコンテキストが保存されている必要があるので、要るものを続けて保存する (1 回の変更にまとめる)。
import type { CommandResult, Fail } from "./commands";
import { addAggregate, addBoundedContext, addDomainCommand, addDomainEvent, addDomainPolicy, type DomainCommandInput, type DomainEventInput } from "./domainCommands";
import { resolveDomain, type ResolvedDomain } from "./domainResolve";
import type { UntieModel } from "./types";

const fail = (reason: string): Fail => ({ ok: false, reason });

/** 候補のコンテキストを保存する (すでに保存してあれば、その id)。実装先はこのシステム */
function ensureContext(model: UntieModel, systemId: string, r: ResolvedDomain, contextKey: string | null): CommandResult<{ id: string }> {
  const ctx = r.contexts.find((c) => c.key === contextKey);
  if (ctx?.saved) return { ok: true, model, id: ctx.saved.id };
  if (!ctx || contextKey === null) return fail("コンテキストに属していない情報です。先に境界づけられたコンテキストを作って、そこへ入れてください");
  return addBoundedContext(model, { name: ctx.name, contextIds: [contextKey], systemIds: [systemId] });
}

/**
 * 候補の集約 (1 情報 1 集約) を保存する。コンテキストがまだ候補なら、一緒に保存する。
 * key は ResolvedAggregate.key (保存した集約なら、何もせずその id を返す)。boundedContextId を渡すと、そのコンテキストに入れる
 */
export function adoptAggregateCandidate(model: UntieModel, payload: { systemId: string; key: string; boundedContextId?: string }): CommandResult<{ id: string }> {
  const r = resolveDomain(model, payload.systemId);
  const a = r.aggregates.find((x) => x.key === payload.key);
  if (!a) return fail(`集約の候補が見つかりません: ${payload.key}`);
  if (a.saved) return { ok: true, model, id: a.saved.id };
  const ctx = payload.boundedContextId !== undefined ? ({ ok: true, model, id: payload.boundedContextId } as const) : ensureContext(model, payload.systemId, r, a.contextKey);
  if (!ctx.ok) return ctx;
  return addAggregate(ctx.model, { boundedContextId: ctx.id, rootInformationId: a.root.id, ...(a.stateGroups[0] !== undefined ? { stateGroup: a.stateGroups[0] } : {}) });
}

/**
 * 候補のコマンドを保存する (名前・英語名を決めるため)。受け持つ集約がまだ候補なら、一緒に保存する。
 * key は ResolvedCommand.key (保存したコマンドなら、何もせずその id を返す)
 */
export function adoptCommandCandidate(model: UntieModel, payload: { systemId: string; key: string; patch?: Pick<DomainCommandInput, "name" | "english"> }): CommandResult<{ id: string }> {
  const r = resolveDomain(model, payload.systemId);
  const c = r.commands.find((x) => x.key === payload.key);
  if (!c) return fail(`コマンドの候補が見つかりません: ${payload.key}`);
  if (c.saved) return { ok: true, model, id: c.saved.id };
  if (!c.candidate) return fail("コマンドの候補ではありません");
  if (c.aggregateKey === null) return fail("このコマンドは、どの集約のものか決まっていません (情報を書かず、状態の持ち主も決まらない操作)。あるべき姿のコマンドとして、集約に足してください");
  const aggregate = adoptAggregateCandidate(model, { systemId: payload.systemId, key: c.aggregateKey });
  if (!aggregate.ok) return aggregate;
  const cand = c.candidate;
  return addDomainCommand(aggregate.model, {
    aggregateId: aggregate.id,
    source: { usecaseId: cand.usecase.id, ...(cand.activity ? { activityId: cand.activity.id } : {}) },
    // 作業ごとに分けた候補は、名前で見分けられるように作業の名前を添える
    name: payload.patch?.name ?? (cand.activity ? `${cand.usecase.name} (${cand.activity.name})` : cand.usecase.name),
    ...(payload.patch?.english !== undefined ? { english: payload.patch.english } : {}),
  });
}

/** 複数の作業が使う操作を、作業ごとのコマンドに分けて保存する (すでに操作ごとに保存してあれば、分けない) */
export function splitCommandByActivity(model: UntieModel, payload: { systemId: string; usecaseId: string }): CommandResult<{ ids: string[] }> {
  const r = resolveDomain(model, payload.systemId);
  const splits = r.scope.splitCommands.filter((c) => c.usecase.id === payload.usecaseId);
  if (splits.length < 2) return fail("この操作を使う作業は 1 つだけです");
  const merged = r.commands.find((c) => c.candidate?.usecase.id === payload.usecaseId && !c.candidate.activity);
  if (merged?.saved) return fail("この操作は、操作ごとのコマンドとして保存してあります。保存をやめてから分けてください");
  if (!merged || merged.aggregateKey === null) return fail("この操作は、どの集約のものか決まっていません");
  const aggregate = adoptAggregateCandidate(model, { systemId: payload.systemId, key: merged.aggregateKey });
  if (!aggregate.ok) return aggregate;
  let next = aggregate.model;
  const ids: string[] = [];
  for (const s of splits) {
    const added = addDomainCommand(next, { aggregateId: aggregate.id, source: { usecaseId: s.usecase.id, activityId: s.activity!.id }, name: `${s.usecase.name} (${s.activity!.name})` });
    if (!added.ok) return added;
    next = added.model;
    ids.push(added.id);
  }
  return { ok: true, model: next, ids };
}

/**
 * 候補のイベントを保存する (名前・英語名・属性を決めるため)。発生させる集約がまだ候補なら、一緒に保存する。
 * key は ResolvedEvent.key (保存したイベントなら、何もせずその id を返す)。別のところで発生するイベント (外) は、boundedContextId で発生元のコンテキストを指す
 */
export function adoptEventCandidate(model: UntieModel, payload: { systemId: string; key: string; boundedContextId?: string; patch?: Pick<DomainEventInput, "name" | "english"> }): CommandResult<{ id: string }> {
  const r = resolveDomain(model, payload.systemId);
  const e = r.events.find((x) => x.key === payload.key);
  if (!e) return fail(`イベントの候補が見つかりません: ${payload.key}`);
  if (e.saved) return { ok: true, model, id: e.saved.id };
  if (!e.scoped) return fail("イベントの候補ではありません");
  const eventId = e.scoped.row.event.id;
  if (payload.boundedContextId !== undefined) return addDomainEvent(model, { boundedContextId: payload.boundedContextId, eventId, ...payload.patch });
  if (e.aggregateKey !== null) {
    const aggregate = adoptAggregateCandidate(model, { systemId: payload.systemId, key: e.aggregateKey });
    if (!aggregate.ok) return aggregate;
    return addDomainEvent(aggregate.model, { aggregateId: aggregate.id, eventId, ...payload.patch });
  }
  if (e.origin === "outside" && (e.contextKey === null || !r.contexts.find((c) => c.key === e.contextKey)?.saved)) {
    return fail("別のところで発生するイベントです。発生元の境界づけられたコンテキストを選んでください (無ければ、先に作ってください)");
  }
  const ctx = ensureContext(model, payload.systemId, r, e.contextKey);
  if (!ctx.ok) return ctx;
  return addDomainEvent(ctx.model, { boundedContextId: ctx.id, eventId, ...payload.patch });
}

/** イベントが起きたらコマンドを実行するポリシーを足す。イベントとコマンドがまだ候補なら、一緒に保存する */
export function addPolicyBetween(model: UntieModel, payload: { systemId: string; eventKey: string; commandKey: string; auto: boolean; eventContextId?: string }): CommandResult<{ id: string }> {
  const event = adoptEventCandidate(model, { systemId: payload.systemId, key: payload.eventKey, ...(payload.eventContextId !== undefined ? { boundedContextId: payload.eventContextId } : {}) });
  if (!event.ok) return event;
  // イベントを保存すると、候補のキーが保存した id に変わるので、コマンドはもとのモデルのキーで探し直す
  const before = resolveDomain(model, payload.systemId).commands.find((c) => c.key === payload.commandKey);
  if (!before) return fail(`コマンドが見つかりません: ${payload.commandKey}`);
  const after = resolveDomain(event.model, payload.systemId).commands.find((c) => (before.saved ? c.saved?.id === before.saved.id : c.sourceKey === before.sourceKey && !c.saved));
  if (!after) return fail(`コマンドが見つかりません: ${payload.commandKey}`);
  const command = adoptCommandCandidate(event.model, { systemId: payload.systemId, key: after.key });
  if (!command.ok) return command;
  return addDomainPolicy(command.model, { eventId: event.id, commandId: command.id, auto: payload.auto });
}
