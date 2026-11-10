// ドメインモデル (domain。0.6.0) を変えるコマンド。commands.ts と同じく (model, payload) => 結果 の純粋関数で、失敗は { ok: false, reason } で返す。
// 参照の規則は domain.ts の inspectDomain と同じ (コマンドは、壊れた参照を作る入力を断る)。
import { produce } from "immer";
import type { CommandResult, Fail } from "./commands";
import { aggregateInformationIds, commandSourceKey, CONTEXT_RELATION_KINDS, inspectDomain, INTEGRATIONS, isEnglishName, parseExcludedKey, SUBDOMAINS, SYMMETRIC_RELATION_KINDS, usedDomainIds, type ContextRelationKind, type Integration, type Subdomain } from "./domain";
import { newUniqueId, type IdKind } from "./id";
import { checkLength, EXCLUDED_KEY_MAX_LENGTH, type LimitKey } from "./limits";
import { isValidDesignShape, type DomainPartKind } from "./validate";
import type { Aggregate, BoundedContext, ContextRelation, DomainCommand, DomainEvent, DomainModel, DomainTerm, Element, UntieModel } from "./types";

const fail = (reason: string): Fail => ({ ok: false, reason });
const isFail = (v: unknown): v is Fail => typeof v === "object" && v !== null && (v as Fail).ok === false;

const elementOf = (model: UntieModel, id: string): Element | undefined => model.elements.find((e) => e.id === id);
const nameOrNone = (name: string) => name || "(名前なし)";

const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** 新しい id (渡された id があれば、使われていないことを確かめる) */
function takeId(model: UntieModel, kind: IdKind, given: string | undefined): string | Fail {
  const used = usedDomainIds(model.domain);
  if (given !== undefined) {
    if (!ID.test(given)) return fail(`id に使えない文字があります: ${given}`);
    return used.has(given) ? fail(`id がすでに使われています: ${given}`) : given;
  }
  return newUniqueId(kind, used);
}

/** 必須の名前 (前後の空白を除く) */
function requiredText(text: string, key: LimitKey, label: string): string | Fail {
  const t = text.trim();
  if (t === "") return fail(`${label}が必要です`);
  const tooLong = checkLength(key, t);
  return tooLong ? fail(tooLong) : t;
}

/** 任意の文字列 (空なら項目を持たない = undefined) */
function optionalText(text: string | null | undefined, key: LimitKey): string | undefined | Fail {
  const t = (text ?? "").trim();
  if (t === "") return undefined;
  const tooLong = checkLength(key, t);
  return tooLong ? fail(tooLong) : t;
}

/** 英語名 (空なら持たない)。英字で始まり、英数字とアンダースコアだけ */
function englishName(text: string | null | undefined): string | undefined | Fail {
  const t = (text ?? "").trim();
  if (t === "") return undefined;
  const tooLong = checkLength("english", t);
  if (tooLong) return fail(tooLong);
  return isEnglishName(t) ? t : fail(`英語名は、英字で始まる英数字とアンダースコアで書いてください: ${t}`);
}

/** 種類の決まった要素の id の一覧 (重複を除く) */
function elementIds(model: UntieModel, ids: readonly string[], kind: Element["kind"], label: string): string[] | Fail {
  const unique = [...new Set(ids)];
  for (const id of unique) if (elementOf(model, id)?.kind !== kind) return fail(`${label}が存在しません: ${id}`);
  return unique;
}

/** 項目を置く (undefined なら消す) */
function setOptional<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void {
  if (value === undefined) delete target[key];
  else target[key] = value;
}

/** 変更後のドメインモデルで、消えた参照を掃除する (コンテキストや集約を消したあとの連鎖) */
function sweep(draft: UntieModel): void {
  const result = inspectDomain(draft.domain, draft.elements);
  if (result.problems.length > 0) draft.domain = result.domain;
}

// ---------------------------------------------------------------- 境界づけられたコンテキスト

export interface BoundedContextInput {
  name?: string;
  /** 空文字・null で消す */
  english?: string | null;
  description?: string | null;
  /** null で未定に戻す */
  subdomain?: Subdomain | null;
  team?: string | null;
  contextIds?: string[];
  systemIds?: string[];
}

function contextFields(model: UntieModel, input: BoundedContextInput, base: BoundedContext | null): BoundedContext | Fail {
  const next: BoundedContext = base ? { ...base } : { id: "", name: "", contextIds: [], systemIds: [] };
  if (input.name !== undefined || !base) {
    const name = requiredText(input.name ?? "", "name", "名前");
    if (isFail(name)) return name;
    next.name = name;
  }
  if (input.english !== undefined) {
    const v = englishName(input.english);
    if (isFail(v)) return v;
    setOptional(next, "english", v);
  }
  if (input.description !== undefined) {
    const v = optionalText(input.description, "description");
    if (isFail(v)) return v;
    setOptional(next, "description", v);
  }
  if (input.subdomain !== undefined) {
    if (input.subdomain !== null && !SUBDOMAINS.includes(input.subdomain)) return fail(`サブドメインの分類が正しくありません: ${String(input.subdomain)}`);
    setOptional(next, "subdomain", input.subdomain ?? undefined);
  }
  if (input.team !== undefined) {
    const v = optionalText(input.team, "team");
    if (isFail(v)) return v;
    setOptional(next, "team", v);
  }
  if (input.contextIds !== undefined) {
    const ids = elementIds(model, input.contextIds, "context", "分析のコンテキスト");
    if (isFail(ids)) return ids;
    next.contextIds = ids;
  }
  if (input.systemIds !== undefined) {
    const ids = elementIds(model, input.systemIds, "system", "システム");
    if (isFail(ids)) return ids;
    next.systemIds = ids;
  }
  return next;
}

/** 境界づけられたコンテキストを足す */
export function addBoundedContext(model: UntieModel, payload: BoundedContextInput & { id?: string; name: string }): CommandResult<{ id: string }> {
  const id = takeId(model, "boundedContext", payload.id);
  if (isFail(id)) return id;
  const fields = contextFields(model, payload, null);
  if (isFail(fields)) return fields;
  const next = produce(model, (draft) => {
    draft.domain.contexts.push({ ...fields, id });
  });
  return { ok: true, model: next, id };
}

export function updateBoundedContext(model: UntieModel, payload: { id: string; patch: BoundedContextInput }): CommandResult {
  const index = model.domain.contexts.findIndex((c) => c.id === payload.id);
  if (index < 0) return fail(`境界づけられたコンテキストが存在しません: ${payload.id}`);
  const fields = contextFields(model, payload.patch, model.domain.contexts[index]!);
  if (isFail(fields)) return fields;
  const next = produce(model, (draft) => {
    draft.domain.contexts[index] = fields;
  });
  return { ok: true, model: next };
}

/** 境界づけられたコンテキストを消す。その集約 (とコマンド・ポリシー)・イベント・関係も消え、用語は全体で共通になる */
export function removeBoundedContext(model: UntieModel, payload: { id: string }): CommandResult {
  if (!model.domain.contexts.some((c) => c.id === payload.id)) return fail(`境界づけられたコンテキストが存在しません: ${payload.id}`);
  const next = produce(model, (draft) => {
    draft.domain.contexts = draft.domain.contexts.filter((c) => c.id !== payload.id);
    sweep(draft);
  });
  return { ok: true, model: next };
}

// ---------------------------------------------------------------- 集約

export interface InvariantInput {
  /** 省略すると作る */
  id?: string;
  text: string;
  conditionId?: string;
}

export interface AggregateInput {
  boundedContextId?: string;
  name?: string;
  english?: string | null;
  rootInformationId?: string;
  memberInformationIds?: string[];
  /** 空文字・null で外す */
  stateGroup?: string | null;
  invariants?: InvariantInput[];
}

function aggregateFields(model: UntieModel, input: AggregateInput, base: Aggregate | null, selfId: string): Aggregate | Fail {
  const next: Aggregate = base ? { ...base } : { id: "", boundedContextId: "", name: "", rootInformationId: "", memberInformationIds: [], invariants: [] };
  if (input.boundedContextId !== undefined || !base) {
    const bc = model.domain.contexts.find((c) => c.id === input.boundedContextId);
    if (!bc) return fail(`境界づけられたコンテキストが存在しません: ${String(input.boundedContextId)}`);
    next.boundedContextId = bc.id;
  }
  if (input.rootInformationId !== undefined || !base) {
    const root = input.rootInformationId === undefined ? undefined : elementOf(model, input.rootInformationId);
    if (!root || root.kind !== "information") return fail(`ルートの情報が存在しません: ${String(input.rootInformationId)}`);
    next.rootInformationId = root.id;
  }
  if (input.memberInformationIds !== undefined) {
    const ids = elementIds(model, input.memberInformationIds, "information", "情報");
    if (isFail(ids)) return ids;
    next.memberInformationIds = ids;
  }
  // ルートを変えたとき、新しいルートが中の情報にあれば外す
  next.memberInformationIds = next.memberInformationIds.filter((id) => id !== next.rootInformationId);
  if (input.name !== undefined || !base) {
    // 名前を省くと、ルートの情報の名前にする
    const fallback = elementOf(model, next.rootInformationId)?.name ?? "";
    const name = requiredText(input.name?.trim() ? input.name : fallback, "name", "名前");
    if (isFail(name)) return name;
    next.name = name;
  }
  if (input.english !== undefined) {
    const v = englishName(input.english);
    if (isFail(v)) return v;
    setOptional(next, "english", v);
  }
  if (input.stateGroup !== undefined) {
    const group = (input.stateGroup ?? "").trim();
    if (group !== "" && !model.elements.some((e) => e.kind === "state" && e.group === group)) return fail(`状態グループが存在しません: ${group}`);
    setOptional(next, "stateGroup", group === "" ? undefined : group);
  }
  if (input.invariants !== undefined) {
    // id は domain の中で一意。この集約の id (足すときは、これから使う id) とも重ねない
    const used = usedDomainIds(model.domain);
    used.add(selfId);
    const own = new Set((base?.invariants ?? []).map((i) => i.id));
    const seen = new Set<string>();
    const invariants: Aggregate["invariants"] = [];
    for (const inv of input.invariants) {
      const text = requiredText(inv.text, "invariant", "不変条件");
      if (isFail(text)) return text;
      if (inv.conditionId !== undefined && elementOf(model, inv.conditionId)?.kind !== "condition") return fail(`条件が存在しません: ${inv.conditionId}`);
      let id = inv.id;
      // 形の正しくない id・重なる id は、作り直す
      if (id === undefined || !ID.test(id) || seen.has(id) || (used.has(id) && !own.has(id))) id = newUniqueId("invariant", new Set([...used, ...seen]));
      seen.add(id);
      invariants.push({ id, text, ...(inv.conditionId !== undefined ? { conditionId: inv.conditionId } : {}) });
    }
    next.invariants = invariants;
  }
  // 同じコンテキストのほかの集約に入っている情報は入れない (別のコンテキストなら、別のモデルとして持ってよい)
  const mine = new Set(aggregateInformationIds(next));
  for (const other of model.domain.aggregates) {
    if (other.id === base?.id || other.boundedContextId !== next.boundedContextId) continue;
    const clash = aggregateInformationIds(other).find((id) => mine.has(id));
    if (clash) return fail(`情報「${nameOrNone(elementOf(model, clash)?.name ?? "")}」は、同じコンテキストの集約「${nameOrNone(other.name)}」に入っています`);
  }
  return next;
}

/** 集約を足す。名前を省くと、ルートの情報の名前にする */
export function addAggregate(model: UntieModel, payload: AggregateInput & { id?: string; boundedContextId: string; rootInformationId: string }): CommandResult<{ id: string }> {
  const id = takeId(model, "aggregate", payload.id);
  if (isFail(id)) return id;
  const fields = aggregateFields(model, payload, null, id);
  if (isFail(fields)) return fields;
  const next = produce(model, (draft) => {
    draft.domain.aggregates.push({ ...fields, id });
  });
  return { ok: true, model: next, id };
}

/** 集約を変える。別のコンテキストへ移すと、その集約が発生させるイベントも一緒に移る */
export function updateAggregate(model: UntieModel, payload: { id: string; patch: AggregateInput }): CommandResult {
  const index = model.domain.aggregates.findIndex((a) => a.id === payload.id);
  if (index < 0) return fail(`集約が存在しません: ${payload.id}`);
  const before = model.domain.aggregates[index]!;
  const fields = aggregateFields(model, payload.patch, before, before.id);
  if (isFail(fields)) return fields;
  const next = produce(model, (draft) => {
    draft.domain.aggregates[index] = fields;
    if (fields.boundedContextId !== before.boundedContextId) {
      for (const e of draft.domain.events) if (e.aggregateId === fields.id) e.boundedContextId = fields.boundedContextId;
    }
  });
  return { ok: true, model: next };
}

/** 集約を消す。そのコマンド (とポリシー) も消え、イベントは集約の参照だけ外れる */
export function removeAggregate(model: UntieModel, payload: { id: string }): CommandResult {
  if (!model.domain.aggregates.some((a) => a.id === payload.id)) return fail(`集約が存在しません: ${payload.id}`);
  const next = produce(model, (draft) => {
    draft.domain.aggregates = draft.domain.aggregates.filter((a) => a.id !== payload.id);
    sweep(draft);
  });
  return { ok: true, model: next };
}

// ---------------------------------------------------------------- コマンド

export interface DomainCommandInput {
  aggregateId?: string;
  name?: string;
  english?: string | null;
  /** null で出どころを外す (あるべき姿のコマンドにする) */
  source?: { usecaseId: string; activityId?: string } | null;
  emits?: string[];
}

function commandFields(model: UntieModel, input: DomainCommandInput, base: DomainCommand | null): DomainCommand | Fail {
  const next: DomainCommand = base ? { ...base } : { id: "", aggregateId: "", name: "", emits: [] };
  if (input.aggregateId !== undefined || !base) {
    if (!model.domain.aggregates.some((a) => a.id === input.aggregateId)) return fail(`集約が存在しません: ${String(input.aggregateId)}`);
    next.aggregateId = input.aggregateId!;
  }
  if (input.source !== undefined) {
    if (input.source === null) delete next.source;
    else {
      if (elementOf(model, input.source.usecaseId)?.kind !== "usecase") return fail(`操作が存在しません: ${input.source.usecaseId}`);
      if (input.source.activityId !== undefined && elementOf(model, input.source.activityId)?.kind !== "activity") return fail(`作業が存在しません: ${input.source.activityId}`);
      next.source = { usecaseId: input.source.usecaseId, ...(input.source.activityId !== undefined ? { activityId: input.source.activityId } : {}) };
      const key = commandSourceKey(next.source);
      if (model.domain.commands.some((c) => c.id !== base?.id && c.source && commandSourceKey(c.source) === key)) return fail("同じ操作 (と作業) から採用したコマンドが、すでにあります");
    }
  }
  if (input.name !== undefined || !base) {
    // 名前を省くと、出どころの操作の名前にする
    const fallback = next.source ? (elementOf(model, next.source.usecaseId)?.name ?? "") : "";
    const name = requiredText(input.name?.trim() ? input.name : fallback, "name", "名前");
    if (isFail(name)) return name;
    next.name = name;
  }
  if (input.english !== undefined) {
    const v = englishName(input.english);
    if (isFail(v)) return v;
    setOptional(next, "english", v);
  }
  if (input.emits !== undefined) {
    const ids = [...new Set(input.emits)];
    for (const id of ids) if (!model.domain.events.some((e) => e.id === id)) return fail(`ドメインイベントが存在しません: ${id}`);
    next.emits = ids;
  }
  return next;
}

/** コマンドを足す。source があれば分析の操作から採用したもの (名前を省くと操作の名前)、無ければあるべき姿のコマンド */
export function addDomainCommand(model: UntieModel, payload: DomainCommandInput & { id?: string; aggregateId: string }): CommandResult<{ id: string }> {
  const id = takeId(model, "domainCommand", payload.id);
  if (isFail(id)) return id;
  const fields = commandFields(model, payload, null);
  if (isFail(fields)) return fields;
  const next = produce(model, (draft) => {
    draft.domain.commands.push({ ...fields, id });
  });
  return { ok: true, model: next, id };
}

export function updateDomainCommand(model: UntieModel, payload: { id: string; patch: DomainCommandInput }): CommandResult {
  const index = model.domain.commands.findIndex((c) => c.id === payload.id);
  if (index < 0) return fail(`コマンドが存在しません: ${payload.id}`);
  const fields = commandFields(model, payload.patch, model.domain.commands[index]!);
  if (isFail(fields)) return fields;
  const next = produce(model, (draft) => {
    draft.domain.commands[index] = fields;
  });
  return { ok: true, model: next };
}

/** コマンドを消す。それを実行するポリシーも消える */
export function removeDomainCommand(model: UntieModel, payload: { id: string }): CommandResult {
  if (!model.domain.commands.some((c) => c.id === payload.id)) return fail(`コマンドが存在しません: ${payload.id}`);
  const next = produce(model, (draft) => {
    draft.domain.commands = draft.domain.commands.filter((c) => c.id !== payload.id);
    sweep(draft);
  });
  return { ok: true, model: next };
}

// ---------------------------------------------------------------- ドメインイベント

export interface DomainEventInput {
  boundedContextId?: string;
  /** null で集約の参照を外す */
  aggregateId?: string | null;
  name?: string;
  english?: string | null;
  /** null で分析のイベントの参照を外す */
  eventId?: string | null;
  properties?: { name: string; informationId?: string }[];
}

function eventFields(model: UntieModel, input: DomainEventInput, base: DomainEvent | null): DomainEvent | Fail {
  const next: DomainEvent = base ? { ...base } : { id: "", boundedContextId: "", name: "" };
  if (input.aggregateId !== undefined) {
    if (input.aggregateId === null) delete next.aggregateId;
    else {
      const aggregate = model.domain.aggregates.find((a) => a.id === input.aggregateId);
      if (!aggregate) return fail(`集約が存在しません: ${input.aggregateId}`);
      next.aggregateId = aggregate.id;
      // 集約を指したら、コンテキストは集約のコンテキストにそろえる (指定があれば下で確かめる)
      if (input.boundedContextId === undefined) next.boundedContextId = aggregate.boundedContextId;
    }
  }
  if (input.boundedContextId !== undefined || (!base && next.boundedContextId === "")) {
    if (!model.domain.contexts.some((c) => c.id === input.boundedContextId)) return fail(`境界づけられたコンテキストが存在しません: ${String(input.boundedContextId)}`);
    next.boundedContextId = input.boundedContextId!;
  }
  if (next.aggregateId !== undefined && model.domain.aggregates.find((a) => a.id === next.aggregateId)?.boundedContextId !== next.boundedContextId) {
    return fail("イベントの集約は、同じコンテキストの集約にしてください");
  }
  if (input.eventId !== undefined) {
    if (input.eventId === null) delete next.eventId;
    else {
      if (elementOf(model, input.eventId)?.kind !== "event") return fail(`分析のイベントが存在しません: ${input.eventId}`);
      if (model.domain.events.some((e) => e.id !== base?.id && e.eventId === input.eventId)) return fail("同じ分析のイベントを指すドメインイベントが、すでにあります");
      next.eventId = input.eventId;
    }
  }
  if (input.name !== undefined || !base) {
    // 名前を省くと、分析のイベントの名前にする
    const fallback = next.eventId ? (elementOf(model, next.eventId)?.name ?? "") : "";
    const name = requiredText(input.name?.trim() ? input.name : fallback, "name", "名前");
    if (isFail(name)) return name;
    next.name = name;
  }
  if (input.english !== undefined) {
    const v = englishName(input.english);
    if (isFail(v)) return v;
    setOptional(next, "english", v);
  }
  if (input.properties !== undefined) {
    const properties: NonNullable<DomainEvent["properties"]> = [];
    for (const p of input.properties) {
      const name = requiredText(p.name, "propertyName", "属性の名前");
      if (isFail(name)) return name;
      if (p.informationId !== undefined && elementOf(model, p.informationId)?.kind !== "information") return fail(`情報が存在しません: ${p.informationId}`);
      properties.push({ name, ...(p.informationId !== undefined ? { informationId: p.informationId } : {}) });
    }
    setOptional(next, "properties", properties.length > 0 ? properties : undefined);
  }
  return next;
}

/** ドメインイベントを足す。eventId があれば分析のイベントを指すもの (名前を省くとそのイベントの名前)、無ければあるべき姿のイベント */
export function addDomainEvent(model: UntieModel, payload: DomainEventInput & { id?: string }): CommandResult<{ id: string }> {
  const id = takeId(model, "domainEvent", payload.id);
  if (isFail(id)) return id;
  const fields = eventFields(model, payload, null);
  if (isFail(fields)) return fields;
  const next = produce(model, (draft) => {
    draft.domain.events.push({ ...fields, id });
  });
  return { ok: true, model: next, id };
}

export function updateDomainEvent(model: UntieModel, payload: { id: string; patch: DomainEventInput }): CommandResult {
  const index = model.domain.events.findIndex((e) => e.id === payload.id);
  if (index < 0) return fail(`ドメインイベントが存在しません: ${payload.id}`);
  const fields = eventFields(model, payload.patch, model.domain.events[index]!);
  if (isFail(fields)) return fields;
  const next = produce(model, (draft) => {
    draft.domain.events[index] = fields;
  });
  return { ok: true, model: next };
}

/** ドメインイベントを消す。コマンドの emits から外れ、それをきっかけにするポリシーも消える */
export function removeDomainEvent(model: UntieModel, payload: { id: string }): CommandResult {
  if (!model.domain.events.some((e) => e.id === payload.id)) return fail(`ドメインイベントが存在しません: ${payload.id}`);
  const next = produce(model, (draft) => {
    draft.domain.events = draft.domain.events.filter((e) => e.id !== payload.id);
    sweep(draft);
  });
  return { ok: true, model: next };
}

// ---------------------------------------------------------------- ポリシー

/** ポリシーを足す (イベントが起きたらコマンドを実行する) */
export function addDomainPolicy(model: UntieModel, payload: { id?: string; eventId: string; commandId: string; auto?: boolean }): CommandResult<{ id: string }> {
  const id = takeId(model, "domainPolicy", payload.id);
  if (isFail(id)) return id;
  if (!model.domain.events.some((e) => e.id === payload.eventId)) return fail(`ドメインイベントが存在しません: ${payload.eventId}`);
  if (!model.domain.commands.some((c) => c.id === payload.commandId)) return fail(`コマンドが存在しません: ${payload.commandId}`);
  if (model.domain.policies.some((p) => p.eventId === payload.eventId && p.commandId === payload.commandId)) return fail("同じイベントとコマンドのポリシーが、すでにあります");
  const next = produce(model, (draft) => {
    draft.domain.policies.push({ id, eventId: payload.eventId, commandId: payload.commandId, auto: payload.auto ?? true });
  });
  return { ok: true, model: next, id };
}

export function updateDomainPolicy(model: UntieModel, payload: { id: string; auto: boolean }): CommandResult {
  const index = model.domain.policies.findIndex((p) => p.id === payload.id);
  if (index < 0) return fail(`ポリシーが存在しません: ${payload.id}`);
  const next = produce(model, (draft) => {
    draft.domain.policies[index]!.auto = payload.auto;
  });
  return { ok: true, model: next };
}

export function removeDomainPolicy(model: UntieModel, payload: { id: string }): CommandResult {
  if (!model.domain.policies.some((p) => p.id === payload.id)) return fail(`ポリシーが存在しません: ${payload.id}`);
  const next = produce(model, (draft) => {
    draft.domain.policies = draft.domain.policies.filter((p) => p.id !== payload.id);
  });
  return { ok: true, model: next };
}

// ---------------------------------------------------------------- コンテキスト間の関係

export interface ContextRelationInput {
  upstreamId?: string;
  downstreamId?: string;
  kind?: ContextRelationKind;
  /** null で未定に戻す */
  integration?: Integration | null;
  note?: string | null;
}

function relationFields(model: UntieModel, input: ContextRelationInput, base: ContextRelation | null): ContextRelation | Fail {
  const next: ContextRelation = base ? { ...base } : { id: "", upstreamId: "", downstreamId: "", kind: "customerSupplier" };
  for (const end of ["upstreamId", "downstreamId"] as const) {
    if (input[end] === undefined && base) continue;
    if (!model.domain.contexts.some((c) => c.id === input[end])) return fail(`境界づけられたコンテキストが存在しません: ${String(input[end])}`);
    next[end] = input[end]!;
  }
  if (next.upstreamId === next.downstreamId) return fail("同じコンテキストどうしは結べません");
  if (model.domain.relations.some((r) => r.id !== base?.id && r.upstreamId === next.upstreamId && r.downstreamId === next.downstreamId)) return fail("同じ向きの関係が、すでにあります");
  if (input.kind !== undefined || !base) {
    if (input.kind === undefined || !CONTEXT_RELATION_KINDS.includes(input.kind)) return fail(`関係の種類が正しくありません: ${String(input.kind)}`);
    next.kind = input.kind;
  }
  // 対等な関係 (パートナーシップなど) は向きを持たないので、逆向きのものとは並べない
  const reverse = model.domain.relations.find((r) => r.id !== base?.id && r.upstreamId === next.downstreamId && r.downstreamId === next.upstreamId);
  if (reverse && (SYMMETRIC_RELATION_KINDS.has(next.kind) || SYMMETRIC_RELATION_KINDS.has(reverse.kind))) return fail("この組には、対等な関係 (向きを持たない関係) があるので、逆向きの関係は足せません");
  if (input.integration !== undefined) {
    if (input.integration !== null && !INTEGRATIONS.includes(input.integration)) return fail(`統合の方式が正しくありません: ${String(input.integration)}`);
    setOptional(next, "integration", input.integration ?? undefined);
  }
  if (input.note !== undefined) {
    const v = optionalText(input.note, "relationNote");
    if (isFail(v)) return v;
    setOptional(next, "note", v);
  }
  return next;
}

/** コンテキスト間の関係を足す (upstreamId が上流、downstreamId が下流) */
export function addContextRelation(model: UntieModel, payload: ContextRelationInput & { id?: string; upstreamId: string; downstreamId: string; kind: ContextRelationKind }): CommandResult<{ id: string }> {
  const id = takeId(model, "contextRelation", payload.id);
  if (isFail(id)) return id;
  const fields = relationFields(model, payload, null);
  if (isFail(fields)) return fields;
  const next = produce(model, (draft) => {
    draft.domain.relations.push({ ...fields, id });
  });
  return { ok: true, model: next, id };
}

export function updateContextRelation(model: UntieModel, payload: { id: string; patch: ContextRelationInput }): CommandResult {
  const index = model.domain.relations.findIndex((r) => r.id === payload.id);
  if (index < 0) return fail(`関係が存在しません: ${payload.id}`);
  const fields = relationFields(model, payload.patch, model.domain.relations[index]!);
  if (isFail(fields)) return fields;
  const next = produce(model, (draft) => {
    draft.domain.relations[index] = fields;
  });
  return { ok: true, model: next };
}

export function removeContextRelation(model: UntieModel, payload: { id: string }): CommandResult {
  if (!model.domain.relations.some((r) => r.id === payload.id)) return fail(`関係が存在しません: ${payload.id}`);
  const next = produce(model, (draft) => {
    draft.domain.relations = draft.domain.relations.filter((r) => r.id !== payload.id);
  });
  return { ok: true, model: next };
}

// ---------------------------------------------------------------- 用語

export interface DomainTermInput {
  /** 既にある用語を変えるときの id */
  id?: string;
  /** 分析の要素の用語なら、その要素の id (同じ要素の用語があれば、それを変える) */
  elementId?: string;
  /** 省略すると、要素の名前 (要素の用語のとき) か、今の値 */
  term?: string;
  english?: string | null;
  definition?: string | null;
  /** null は全体で共通 */
  boundedContextId?: string | null;
}

/**
 * 用語を置く。id か elementId (どちらか一方) で既にある用語を見つけたら変え、無ければ足す。
 * 要素の用語の語は、いつも要素の名前 (写し。term は見ない)。英語も定義もコンテキストも無くなったら消す (分析の名前と説明から導けるので、持つ意味が無い)
 */
export function setDomainTerm(model: UntieModel, payload: DomainTermInput): CommandResult<{ id: string | null }> {
  const terms = model.domain.terms;
  if (payload.id !== undefined && payload.elementId !== undefined) return fail("用語は、id か elementId のどちらか一方で指してください");
  const element = payload.elementId === undefined ? undefined : elementOf(model, payload.elementId);
  if (payload.elementId !== undefined && !element) return fail(`要素が存在しません: ${payload.elementId}`);
  const index = payload.id !== undefined ? terms.findIndex((t) => t.id === payload.id) : element ? terms.findIndex((t) => t.elementId === element.id) : -1;
  if (payload.id !== undefined && index < 0) return fail(`用語が存在しません: ${payload.id}`);
  const base = index >= 0 ? terms[index]! : null;
  const next: DomainTerm = base ? { ...base } : { id: "", term: "", definition: "", boundedContextId: null, ...(element ? { elementId: element.id } : {}) };
  const owner = next.elementId === undefined ? undefined : elementOf(model, next.elementId);
  if (owner && owner.name.trim() !== "") {
    // 要素の用語の語は、要素の名前の写し
    next.term = owner.name.trim();
  } else if (payload.term !== undefined || !base) {
    const term = requiredText(payload.term ?? "", "term", "用語");
    if (isFail(term)) return term;
    next.term = term;
  }
  if (payload.english !== undefined) {
    const v = optionalText(payload.english, "termEnglish");
    if (isFail(v)) return v;
    setOptional(next, "english", v);
  }
  if (payload.definition !== undefined) {
    const v = optionalText(payload.definition, "definition");
    if (isFail(v)) return v;
    next.definition = v ?? "";
  }
  if (payload.boundedContextId !== undefined) {
    if (payload.boundedContextId !== null && !model.domain.contexts.some((c) => c.id === payload.boundedContextId)) return fail(`境界づけられたコンテキストが存在しません: ${payload.boundedContextId}`);
    next.boundedContextId = payload.boundedContextId;
  }
  const empty = next.elementId !== undefined && next.english === undefined && next.definition === "" && next.boundedContextId === null;
  if (empty) {
    if (!base) return { ok: true, model, id: null };
    const removed = produce(model, (draft) => {
      draft.domain.terms.splice(index, 1);
    });
    return { ok: true, model: removed, id: null };
  }
  if (base) {
    const updated = produce(model, (draft) => {
      draft.domain.terms[index] = next;
    });
    return { ok: true, model: updated, id: base.id };
  }
  const id = newUniqueId("domainTerm", usedDomainIds(model.domain));
  const added = produce(model, (draft) => {
    draft.domain.terms.push({ ...next, id });
  });
  return { ok: true, model: added, id };
}

export function removeDomainTerm(model: UntieModel, payload: { id: string }): CommandResult {
  if (!model.domain.terms.some((t) => t.id === payload.id)) return fail(`用語が存在しません: ${payload.id}`);
  const next = produce(model, (draft) => {
    draft.domain.terms = draft.domain.terms.filter((t) => t.id !== payload.id);
  });
  return { ok: true, model: next };
}

// ---------------------------------------------------------------- 候補を外す・まとめて置き換える

/** 分析から導いた候補を、あるべき姿から外す (excluded: true) か、戻す (false)。key は候補の出どころのキー */
export function setCandidateExcluded(model: UntieModel, payload: { key: string; excluded: boolean }): CommandResult {
  const key = payload.key.trim();
  const parsed = key === "" || key.length > EXCLUDED_KEY_MAX_LENGTH ? null : parseExcludedKey(key);
  if (!parsed) return fail("候補のキーが正しくありません");
  const has = model.domain.excluded.includes(key);
  if (has === payload.excluded) return { ok: true, model };
  if (payload.excluded) {
    // もとの操作・作業・イベント・関係が無いキーは外せない (検証に通らないモデルを作らない)
    const kindOf = (id: string) => elementOf(model, id)?.kind;
    const alive =
      parsed.kind === "command"
        ? kindOf(parsed.usecaseId) === "usecase" && (parsed.activityId === undefined || kindOf(parsed.activityId) === "activity")
        : parsed.kind === "event"
          ? kindOf(parsed.eventId) === "event"
          : model.relations.some((r) => r.id === parsed.relationId);
    if (!alive) return fail(`外す候補のもとの要素がありません: ${key}`);
  }
  const next = produce(model, (draft) => {
    if (payload.excluded) draft.domain.excluded.push(key);
    else draft.domain.excluded = draft.domain.excluded.filter((k) => k !== key);
  });
  return { ok: true, model: next };
}

const DOMAIN_PARTS: readonly [keyof Omit<DomainModel, "excluded">, DomainPartKind, string][] = [
  ["contexts", "boundedContext", "コンテキスト"],
  ["aggregates", "aggregate", "集約"],
  ["commands", "domainCommand", "コマンド"],
  ["events", "domainEvent", "イベント"],
  ["policies", "domainPolicy", "ポリシー"],
  ["relations", "contextRelation", "関係"],
  ["terms", "domainTerm", "用語"],
];

/** ドメインモデルの形 (スキーマ) の最初の問題。無ければ null。参照は見ない */
export function domainShapeProblem(domain: DomainModel): string | null {
  for (const [key, kind, label] of DOMAIN_PARTS) {
    const list: unknown = domain[key];
    if (!Array.isArray(list)) return `${label}の一覧がありません`;
    for (const part of list as { id?: unknown }[]) {
      if (!isValidDesignShape(kind, part)) return `${label} ${typeof part?.id === "string" ? part.id : "(id なし)"} の形が正しくありません (名前が空・英語名に使えない文字・種類の誤りなど)`;
    }
  }
  if (!Array.isArray(domain.excluded) || domain.excluded.some((k) => typeof k !== "string" || k.length > EXCLUDED_KEY_MAX_LENGTH || !parseExcludedKey(k))) return "外した候補のキーが正しくありません";
  return null;
}

/**
 * ドメインモデルをまるごと置き換える (AI の下書き・候補からの作成)。形 (スキーマ) が正しくないか、壊れた参照があれば失敗する (理由に最初の問題を出す)。
 * 一部だけを置き換えたいときは、呼ぶ側が残す分と合わせたドメインモデルを渡す
 */
export function setDomainModel(model: UntieModel, payload: { domain: DomainModel }): CommandResult {
  const shape = domainShapeProblem(payload.domain);
  if (shape) return fail(`ドメインモデルの形が正しくありません: ${shape}`);
  const result = inspectDomain(payload.domain, model.elements);
  if (result.problems.length > 0) return fail(`ドメインモデルの参照が正しくありません: ${result.problems[0]!.what}`);
  const next = produce(model, (draft) => {
    draft.domain = payload.domain;
  });
  return { ok: true, model: next };
}

// ---------------------------------------------------------------- 情報を集約へ入れる・外す

/**
 * 情報を集約の中の情報にする。同じコンテキストのほかの集約のルートなら、その集約を畳んでから入れる
 * (畳む集約のコマンドとイベントはこの集約へ移り、中の情報と不変条件もこの集約へ移る)。ほかの集約の中の情報なら、そちらから外して入れる
 */
export function includeInformation(model: UntieModel, payload: { aggregateId: string; informationId: string }): CommandResult {
  const target = model.domain.aggregates.find((a) => a.id === payload.aggregateId);
  if (!target) return fail(`集約が存在しません: ${payload.aggregateId}`);
  if (elementOf(model, payload.informationId)?.kind !== "information") return fail(`情報が存在しません: ${payload.informationId}`);
  if (aggregateInformationIds(target).includes(payload.informationId)) return { ok: true, model };
  const next = produce(model, (draft) => {
    const d = draft.domain;
    const into = d.aggregates.find((a) => a.id === target.id)!;
    for (const other of d.aggregates) {
      if (other.id === target.id || other.boundedContextId !== target.boundedContextId) continue;
      if (other.rootInformationId === payload.informationId) {
        // ルートにしている集約は畳む: 中の情報・不変条件・コマンド・イベントをこの集約へ移す
        for (const id of other.memberInformationIds) if (!aggregateInformationIds(into).includes(id)) into.memberInformationIds.push(id);
        into.invariants.push(...other.invariants);
        for (const c of d.commands) if (c.aggregateId === other.id) c.aggregateId = into.id;
        for (const e of d.events) if (e.aggregateId === other.id) e.aggregateId = into.id;
        d.aggregates = d.aggregates.filter((a) => a.id !== other.id);
        break;
      }
      other.memberInformationIds = other.memberInformationIds.filter((id) => id !== payload.informationId);
    }
    into.memberInformationIds.push(payload.informationId);
  });
  return { ok: true, model: next };
}

/** 集約の中の情報から外す (ルートは外せない) */
export function excludeInformation(model: UntieModel, payload: { aggregateId: string; informationId: string }): CommandResult {
  const index = model.domain.aggregates.findIndex((a) => a.id === payload.aggregateId);
  if (index < 0) return fail(`集約が存在しません: ${payload.aggregateId}`);
  if (model.domain.aggregates[index]!.rootInformationId === payload.informationId) return fail("ルートの情報は外せません (ルートを変えるか、集約を消してください)");
  const next = produce(model, (draft) => {
    const a = draft.domain.aggregates[index]!;
    a.memberInformationIds = a.memberInformationIds.filter((id) => id !== payload.informationId);
  });
  return { ok: true, model: next };
}
