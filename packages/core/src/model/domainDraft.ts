// ドメインモデルの下書き (AI が出す。5.7・6.2) を、保存の形 (domain。4.6) へ当てる。純粋関数だけを置く。
// 下書きは、対象のシステムが実装する境界づけられたコンテキストを、入れ子 (コンテキスト → 集約 → コマンド・イベント) で書いたもの。
// 当てるときは、そのシステムだけが実装するコンテキスト (と、その集約・コマンド・イベント・ポリシー・関係) を置き換え、
// ほかのシステムのコンテキストと、複数のシステムが実装するコンテキストは残す。分析の要素には触れない。
// 1 つでも当てられないものがあれば、何も変えずに、直すところの一覧を返す (AI に出し直させる)。
import type { CommandResult, Fail } from "./commands";
import { CONTEXT_RELATION_KINDS, INTEGRATIONS, isEnglishName, parseExcludedKey, SUBDOMAINS, type ContextRelationKind, type Integration, type Subdomain } from "./domain";
import {
  addAggregate,
  addBoundedContext,
  addContextRelation,
  addDomainCommand,
  addDomainEvent,
  addDomainPolicy,
  removeBoundedContext,
  setCandidateExcluded,
  setDomainTerm,
  updateDomainCommand,
} from "./domainCommands";
import type { UntieModel } from "./types";

export interface DraftInvariant {
  text: string;
  /** もとにした分析の条件の id */
  conditionId?: string;
}

export interface DraftCommand {
  /** 分析の操作から採用するなら、その操作の id (と、作業ごとに分けるなら作業の id)。無ければ、分析に無いあるべき姿のコマンド */
  usecaseId?: string;
  activityId?: string;
  /** 省くと、操作の名前 */
  name?: string;
  english: string;
  /** 発生させるイベントの英語名 */
  emits?: string[];
}

export interface DraftEvent {
  /** 分析のイベントを指すなら、その id。無ければ、あるべき姿のイベント */
  eventId?: string;
  /** 省くと、分析のイベントの名前 */
  name?: string;
  english: string;
  /** 属性の名前 */
  properties?: string[];
}

export interface DraftAggregate {
  /** 省くと、ルートの情報の名前 */
  name?: string;
  english: string;
  rootInformationId: string;
  memberInformationIds?: string[];
  stateGroup?: string;
  invariants?: DraftInvariant[];
  commands?: DraftCommand[];
  events?: DraftEvent[];
}

export interface DraftContext {
  name: string;
  english: string;
  description?: string;
  subdomain?: Subdomain;
  team?: string;
  /** 言語の範囲にする分析のコンテキストの id */
  contextIds?: string[];
  aggregates?: DraftAggregate[];
  /** 集約に属さない、このコンテキストのイベント */
  events?: DraftEvent[];
}

export interface DraftPolicy {
  /** イベントの英語名 (下書きのものか、残すコンテキストのもの) */
  event: string;
  /** コマンドの英語名 */
  command: string;
  auto?: boolean;
}

export interface DraftRelation {
  /** 上流・下流のコンテキストの英語名 (下書きのものか、残すコンテキストのもの) */
  upstream: string;
  downstream: string;
  kind: ContextRelationKind;
  integration?: Integration;
  note?: string;
}

export interface DraftTerm {
  /** 分析の要素の用語なら、その id */
  elementId?: string;
  /** 要素の用語でなければ、語 */
  term?: string;
  english?: string;
  definition?: string;
}

export interface DomainDraft {
  contexts: DraftContext[];
  policies?: DraftPolicy[];
  relations?: DraftRelation[];
  terms?: DraftTerm[];
  /** あるべき姿から外す候補のキー (usecase:<id>、usecase:<id>/activity:<id>、event:<id>) */
  excluded?: string[];
}

export interface DomainDraftSummary {
  /** 置き換えで消した、もとのコンテキストの数 */
  replaced: number;
  contexts: number;
  aggregates: number;
  commands: number;
  events: number;
  policies: number;
  relations: number;
  terms: number;
  excluded: number;
}

/** 一度に返す、直すところの数の上限 */
const MAX_PROBLEMS = 20;

/** そのシステムだけが実装するコンテキスト (下書きで置き換える範囲) */
export function draftScopeContextIds(model: UntieModel, systemId: string): string[] {
  return model.domain.contexts.filter((c) => c.systemIds.length === 1 && c.systemIds[0] === systemId).map((c) => c.id);
}

/**
 * 下書きを当てる。成功したら、置き換えたあとのモデルと数を返す。当てられないものがあれば、何も変えずに理由 (直すところを改行で並べたもの) を返す。
 * 英語名は必須 (コンテキスト・集約・コマンド・イベント)。下書きの中と、残すコンテキスト・コマンド・イベントとで重ならないこと
 */
export function applyDomainDraft(model: UntieModel, payload: { systemId: string; draft: DomainDraft }): CommandResult<{ summary: DomainDraftSummary }> {
  const { systemId, draft } = payload;
  const system = model.elements.find((e) => e.id === systemId);
  if (!system || system.kind !== "system") return { ok: false, reason: `システムが存在しません: ${systemId}` };
  const problems: string[] = [];
  const note = (text: string) => {
    if (problems.length < MAX_PROBLEMS) problems.push(text);
  };
  if (!draft || !Array.isArray(draft.contexts) || draft.contexts.length === 0) return { ok: false, reason: "境界づけられたコンテキストが 1 つもありません (contexts)" };

  // 置き換える範囲を消す
  let next = model;
  const scope = draftScopeContextIds(model, systemId);
  for (const id of scope) {
    const r = removeBoundedContext(next, { id });
    if (r.ok) next = r.model;
  }

  /** 結果を受けて進める。失敗したら理由を控えて、もとのまま続ける (ほかの直すところも一緒に返すため) */
  const step = <T>(where: string, r: CommandResult<T>): (CommandResult<T> & { ok: true }) | null => {
    if (!r.ok) {
      note(`${where}: ${(r as Fail).reason}`);
      return null;
    }
    next = r.model;
    return r;
  };
  const english = (where: string, value: unknown): string | null => {
    if (typeof value !== "string" || value.trim() === "") {
      note(`${where}: 英語名 (english) が必要です`);
      return null;
    }
    if (!isEnglishName(value.trim())) {
      note(`${where}: 英語名は、英字で始まる英数字とアンダースコアで書いてください (${value})`);
      return null;
    }
    return value.trim();
  };

  // 英語名 → id (残すものを先に入れる。下書きと重なったら知らせる)
  const contextByEnglish = new Map<string, string>();
  const eventByEnglish = new Map<string, string>();
  const commandByEnglish = new Map<string, string>();
  for (const c of next.domain.contexts) if (c.english) contextByEnglish.set(c.english, c.id);
  for (const e of next.domain.events) if (e.english) eventByEnglish.set(e.english, e.id);
  for (const c of next.domain.commands) if (c.english) commandByEnglish.set(c.english, c.id);
  const claim = (map: Map<string, string>, where: string, name: string, id: string) => {
    if (map.has(name)) note(`${where}: 英語名 ${name} が重なっています (ほかのものと別の名前にしてください)`);
    else map.set(name, id);
  };

  const summary: DomainDraftSummary = { replaced: scope.length, contexts: 0, aggregates: 0, commands: 0, events: 0, policies: 0, relations: 0, terms: 0, excluded: 0 };
  /** 発生させるイベントは、すべてのイベントを足したあとでつなぐ */
  const pendingEmits: { where: string; commandId: string; emits: string[] }[] = [];

  const addEvent = (where: string, e: DraftEvent, target: { boundedContextId: string } | { aggregateId: string }) => {
    const en = english(where, e?.english);
    if (en === null) return;
    const added = step(
      where,
      addDomainEvent(next, {
        ...target,
        english: en,
        ...(e.name?.trim() ? { name: e.name } : {}),
        ...(e.eventId ? { eventId: e.eventId } : {}),
        ...(Array.isArray(e.properties) && e.properties.length > 0 ? { properties: e.properties.filter((p) => typeof p === "string" && p.trim() !== "").map((name) => ({ name })) } : {}),
      }),
    );
    if (!added) return;
    claim(eventByEnglish, where, en, added.id);
    summary.events++;
  };

  draft.contexts.forEach((c, ci) => {
    const cWhere = `コンテキスト ${c?.english || c?.name || ci + 1}`;
    const en = english(cWhere, c?.english);
    if (c?.subdomain !== undefined && !SUBDOMAINS.includes(c.subdomain)) note(`${cWhere}: サブドメインの分類は core / supporting / generic のどれかにしてください (${String(c.subdomain)})`);
    if (en === null) return;
    const context = step(
      cWhere,
      addBoundedContext(next, {
        name: c.name ?? "",
        english: en,
        ...(c.description ? { description: c.description } : {}),
        ...(c.subdomain && SUBDOMAINS.includes(c.subdomain) ? { subdomain: c.subdomain } : {}),
        ...(c.team ? { team: c.team } : {}),
        contextIds: c.contextIds ?? [],
        systemIds: [systemId],
      }),
    );
    if (!context) return;
    claim(contextByEnglish, cWhere, en, context.id);
    summary.contexts++;
    (c.aggregates ?? []).forEach((a, ai) => {
      const aWhere = `${cWhere} の集約 ${a?.english || a?.name || ai + 1}`;
      const aEn = english(aWhere, a?.english);
      if (aEn === null) return;
      const aggregate = step(
        aWhere,
        addAggregate(next, {
          boundedContextId: context.id,
          rootInformationId: a.rootInformationId,
          english: aEn,
          ...(a.name?.trim() ? { name: a.name } : {}),
          ...(a.memberInformationIds ? { memberInformationIds: a.memberInformationIds } : {}),
          ...(a.stateGroup ? { stateGroup: a.stateGroup } : {}),
          ...(a.invariants ? { invariants: a.invariants.filter((i) => i && typeof i.text === "string" && i.text.trim() !== "").map((i) => ({ text: i.text, ...(i.conditionId ? { conditionId: i.conditionId } : {}) })) } : {}),
        }),
      );
      if (!aggregate) return;
      summary.aggregates++;
      (a.events ?? []).forEach((e, ei) => addEvent(`${aWhere} のイベント ${e?.english || e?.name || ei + 1}`, e, { aggregateId: aggregate.id }));
      (a.commands ?? []).forEach((cmd, mi) => {
        const mWhere = `${aWhere} のコマンド ${cmd?.english || cmd?.name || mi + 1}`;
        const mEn = english(mWhere, cmd?.english);
        if (mEn === null) return;
        if (!cmd.usecaseId && !cmd.name?.trim()) {
          note(`${mWhere}: 分析の操作 (usecaseId) を指さないコマンドには、名前 (name) が必要です`);
          return;
        }
        const added = step(
          mWhere,
          addDomainCommand(next, {
            aggregateId: aggregate.id,
            english: mEn,
            ...(cmd.name?.trim() ? { name: cmd.name } : {}),
            ...(cmd.usecaseId ? { source: { usecaseId: cmd.usecaseId, ...(cmd.activityId ? { activityId: cmd.activityId } : {}) } } : {}),
          }),
        );
        if (!added) return;
        claim(commandByEnglish, mWhere, mEn, added.id);
        summary.commands++;
        if (Array.isArray(cmd.emits) && cmd.emits.length > 0) pendingEmits.push({ where: mWhere, commandId: added.id, emits: cmd.emits });
      });
    });
    (c.events ?? []).forEach((e, ei) => addEvent(`${cWhere} のイベント ${e?.english || e?.name || ei + 1}`, e, { boundedContextId: context.id }));
  });

  for (const p of pendingEmits) {
    const ids: string[] = [];
    for (const name of p.emits) {
      const id = eventByEnglish.get(name);
      if (id === undefined) note(`${p.where}: 発生させるイベント ${name} がありません (events に書いた英語名を指してください)`);
      else if (!ids.includes(id)) ids.push(id);
    }
    if (ids.length > 0) step(p.where, updateDomainCommand(next, { id: p.commandId, patch: { emits: ids } }));
  }

  (draft.policies ?? []).forEach((p, i) => {
    const where = `ポリシー ${p?.event ?? "?"} → ${p?.command ?? "?"} (${i + 1})`;
    const eventId = eventByEnglish.get(p?.event);
    const commandId = commandByEnglish.get(p?.command);
    if (eventId === undefined) note(`${where}: イベント ${String(p?.event)} がありません (英語名で指してください)`);
    if (commandId === undefined) note(`${where}: コマンド ${String(p?.command)} がありません (英語名で指してください)`);
    if (eventId === undefined || commandId === undefined) return;
    if (step(where, addDomainPolicy(next, { eventId, commandId, auto: p.auto !== false }))) summary.policies++;
  });

  (draft.relations ?? []).forEach((r, i) => {
    const where = `関係 ${r?.upstream ?? "?"} → ${r?.downstream ?? "?"} (${i + 1})`;
    const upstreamId = contextByEnglish.get(r?.upstream);
    const downstreamId = contextByEnglish.get(r?.downstream);
    if (upstreamId === undefined) note(`${where}: コンテキスト ${String(r?.upstream)} がありません (英語名で指してください)`);
    if (downstreamId === undefined) note(`${where}: コンテキスト ${String(r?.downstream)} がありません (英語名で指してください)`);
    if (!CONTEXT_RELATION_KINDS.includes(r?.kind)) note(`${where}: 関係の種類 (kind) は ${CONTEXT_RELATION_KINDS.join(" / ")} のどれかにしてください`);
    if (r?.integration !== undefined && !INTEGRATIONS.includes(r.integration)) note(`${where}: 統合の方式 (integration) は ${INTEGRATIONS.join(" / ")} のどれかにしてください`);
    if (upstreamId === undefined || downstreamId === undefined || !CONTEXT_RELATION_KINDS.includes(r.kind) || (r.integration !== undefined && !INTEGRATIONS.includes(r.integration))) return;
    if (step(where, addContextRelation(next, { upstreamId, downstreamId, kind: r.kind, ...(r.integration ? { integration: r.integration } : {}), ...(r.note ? { note: r.note } : {}) }))) summary.relations++;
  });

  (draft.terms ?? []).forEach((t, i) => {
    const where = `用語 ${t?.term || t?.elementId || i + 1}`;
    if (!t?.elementId && !t?.term?.trim()) {
      note(`${where}: 分析の要素 (elementId) か語 (term) が必要です`);
      return;
    }
    // 要素の用語でない語は、同じ語があれば、それを変える
    const existing = t.elementId ? undefined : next.domain.terms.find((x) => x.elementId === undefined && x.term === t.term!.trim());
    const added = step(
      where,
      setDomainTerm(next, {
        ...(existing ? { id: existing.id } : t.elementId ? { elementId: t.elementId } : { term: t.term! }),
        ...(t.english !== undefined ? { english: t.english } : {}),
        ...(t.definition !== undefined ? { definition: t.definition } : {}),
      }),
    );
    if (added) summary.terms++;
  });

  (draft.excluded ?? []).forEach((key) => {
    const where = `外す候補 ${String(key)}`;
    const parsed = typeof key === "string" ? parseExcludedKey(key) : null;
    if (!parsed || parsed.kind === "policy") {
      note(`${where}: キーは usecase:<操作の id>、usecase:<操作の id>/activity:<作業の id>、event:<イベントの id> のどれかにしてください`);
      return;
    }
    const kindOf = (id: string) => next.elements.find((e) => e.id === id)?.kind;
    const alive = parsed.kind === "command" ? kindOf(parsed.usecaseId) === "usecase" && (parsed.activityId === undefined || kindOf(parsed.activityId) === "activity") : kindOf(parsed.eventId) === "event";
    if (!alive) {
      note(`${where}: もとの操作・作業・イベントがありません`);
      return;
    }
    if (step(where, setCandidateExcluded(next, { key, excluded: true }))) summary.excluded++;
  });

  if (problems.length > 0) return { ok: false, reason: problems.join("\n") };
  return { ok: true, model: next, summary };
}
