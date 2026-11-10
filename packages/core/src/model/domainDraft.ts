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
  /** 置き換えたコンテキストに結ばれていた関係・ポリシー・発生させるイベントのうち、英語名が同じものへ付け直した数 */
  reattached: number;
  /** 付け直せずに消えたもの (下書きに、同じ英語名のコンテキスト・コマンド・イベントが無かった)。画面で知らせる */
  lost: string[];
}

/** 一度に返す、直すところの数の上限 */
const MAX_PROBLEMS = 20;

/**
 * AI が出した下書きの型をそろえる (配列でないもの・文字列でないものは、直すところとして知らせて捨てる)。
 * あとの処理が、型の違う値で例外を出さないようにする
 */
function sanitizeDraft(raw: unknown, note: (text: string) => void): DomainDraft {
  const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
  const list = (v: unknown, where: string): unknown[] => {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) {
      note(`${where}: 配列で書いてください`);
      return [];
    }
    return v;
  };
  const text = (v: unknown, where: string): string | undefined => {
    if (v === undefined || v === null) return undefined;
    if (typeof v !== "string") {
      note(`${where}: 文字列で書いてください`);
      return undefined;
    }
    return v;
  };
  const texts = (v: unknown, where: string): string[] => list(v, where).flatMap((x) => (typeof x === "string" ? [x] : (note(`${where}: 文字列の配列で書いてください`), [])));
  const fields = <K extends string>(source: Record<string, unknown>, where: string, keys: readonly K[]): Partial<Record<K, string>> => {
    const out: Partial<Record<K, string>> = {};
    for (const k of keys) {
      const v = text(source[k], `${where} の ${k}`);
      if (v !== undefined) out[k] = v;
    }
    return out;
  };
  const event = (v: unknown, where: string): DraftEvent => {
    const e = obj(v);
    return { ...fields(e, where, ["eventId", "name"] as const), english: text(e.english, `${where} の english`) ?? "", properties: texts(e.properties, `${where} の properties`) };
  };
  const root = obj(raw);
  const contexts = list(root.contexts, "contexts").map((cv, ci): DraftContext => {
    const c = obj(cv);
    const cWhere = `コンテキスト ${typeof c.english === "string" && c.english ? c.english : ci + 1}`;
    return {
      ...fields(c, cWhere, ["description", "team"] as const),
      name: text(c.name, `${cWhere} の name`) ?? "",
      english: text(c.english, `${cWhere} の english`) ?? "",
      ...(c.subdomain !== undefined && c.subdomain !== null ? { subdomain: c.subdomain as Subdomain } : {}),
      contextIds: texts(c.contextIds, `${cWhere} の contextIds`),
      aggregates: list(c.aggregates, `${cWhere} の aggregates`).map((av, ai): DraftAggregate => {
        const a = obj(av);
        const aWhere = `${cWhere} の集約 ${typeof a.english === "string" && a.english ? a.english : ai + 1}`;
        return {
          ...fields(a, aWhere, ["name", "stateGroup"] as const),
          english: text(a.english, `${aWhere} の english`) ?? "",
          rootInformationId: text(a.rootInformationId, `${aWhere} の rootInformationId`) ?? "",
          memberInformationIds: texts(a.memberInformationIds, `${aWhere} の memberInformationIds`),
          invariants: list(a.invariants, `${aWhere} の invariants`).flatMap((iv) => {
            // 文だけを書いたものも受ける
            if (typeof iv === "string") return [{ text: iv }];
            const i = obj(iv);
            const t = text(i.text, `${aWhere} の不変条件の text`);
            return t === undefined ? [] : [{ text: t, ...fields(i, `${aWhere} の不変条件`, ["conditionId"] as const) }];
          }),
          commands: list(a.commands, `${aWhere} の commands`).map((mv, mi): DraftCommand => {
            const m = obj(mv);
            const mWhere = `${aWhere} のコマンド ${typeof m.english === "string" && m.english ? m.english : mi + 1}`;
            return { ...fields(m, mWhere, ["usecaseId", "activityId", "name"] as const), english: text(m.english, `${mWhere} の english`) ?? "", emits: texts(m.emits, `${mWhere} の emits`) };
          }),
          events: list(a.events, `${aWhere} の events`).map((ev, ei) => event(ev, `${aWhere} のイベント ${ei + 1}`)),
        };
      }),
      events: list(c.events, `${cWhere} の events`).map((ev, ei) => event(ev, `${cWhere} のイベント ${ei + 1}`)),
    };
  });
  return {
    contexts,
    policies: list(root.policies, "policies").map((pv, i): DraftPolicy => {
      const p = obj(pv);
      return { event: text(p.event, `ポリシー ${i + 1} の event`) ?? "", command: text(p.command, `ポリシー ${i + 1} の command`) ?? "", ...(typeof p.auto === "boolean" ? { auto: p.auto } : {}) };
    }),
    relations: list(root.relations, "relations").map((rv, i): DraftRelation => {
      const r = obj(rv);
      return {
        upstream: text(r.upstream, `関係 ${i + 1} の upstream`) ?? "",
        downstream: text(r.downstream, `関係 ${i + 1} の downstream`) ?? "",
        kind: r.kind as ContextRelationKind,
        ...(r.integration !== undefined && r.integration !== null ? { integration: r.integration as Integration } : {}),
        ...fields(r, `関係 ${i + 1}`, ["note"] as const),
      };
    }),
    terms: list(root.terms, "terms").map((tv, i): DraftTerm => fields(obj(tv), `用語 ${i + 1}`, ["elementId", "term", "english", "definition"] as const)),
    excluded: texts(root.excluded, "excluded"),
  };
}

/** そのシステムだけが実装するコンテキスト (下書きで置き換える範囲) */
export function draftScopeContextIds(model: UntieModel, systemId: string): string[] {
  return model.domain.contexts.filter((c) => c.systemIds.length === 1 && c.systemIds[0] === systemId).map((c) => c.id);
}

/**
 * 下書きを当てる。成功したら、置き換えたあとのモデルと数を返す。当てられないものがあれば、何も変えずに理由 (直すところを改行で並べたもの) を返す。
 * 英語名は必須 (コンテキスト・集約・コマンド・イベント)。下書きの中と、残すコンテキスト・コマンド・イベントとで重ならないこと
 */
export function applyDomainDraft(model: UntieModel, payload: { systemId: string; draft: DomainDraft }): CommandResult<{ summary: DomainDraftSummary }> {
  try {
    return applyDraft(model, payload);
  } catch (e) {
    // 型をそろえてから当てるので起きないはずだが、AI の出力は何でもありうるので、例外にせず出し直させる
    return { ok: false, reason: `下書きの形が正しくありません (${e instanceof Error ? e.message : String(e)})` };
  }
}

function applyDraft(model: UntieModel, payload: { systemId: string; draft: DomainDraft }): CommandResult<{ summary: DomainDraftSummary }> {
  const { systemId } = payload;
  const system = model.elements.find((e) => e.id === systemId);
  if (!system || system.kind !== "system") return { ok: false, reason: `システムが存在しません: ${systemId}` };
  const problems: string[] = [];
  const note = (text: string) => {
    if (problems.length < MAX_PROBLEMS) problems.push(text);
  };
  const draft = sanitizeDraft(payload.draft, note);
  if (draft.contexts.length === 0) return { ok: false, reason: ["境界づけられたコンテキストが 1 つもありません (contexts)", ...problems].join("\n") };

  // 置き換える範囲を消す。その前に、範囲の外と結ばれているもの (ほかのコンテキストとの関係、ポリシー、ほかのコマンドが発生させるイベント) を
  // 英語名で控えておき、当てたあとで同じ英語名のものへ付け直す (コンテキストを消すと、関係やポリシーも一緒に消えるため)
  let next = model;
  const scope = draftScopeContextIds(model, systemId);
  const before = model.domain;
  const inScope = new Set(scope);
  const goneAggregates = new Set(before.aggregates.filter((a) => inScope.has(a.boundedContextId)).map((a) => a.id));
  const goneEvents = new Map(before.events.filter((e) => inScope.has(e.boundedContextId)).map((e) => [e.id, e]));
  const goneCommands = new Map(before.commands.filter((c) => goneAggregates.has(c.aggregateId)).map((c) => [c.id, c]));
  const contextById = new Map(before.contexts.map((c) => [c.id, c]));
  const keptRelations = before.relations.filter((r) => inScope.has(r.upstreamId) || inScope.has(r.downstreamId));
  const keptPolicies = before.policies.filter((p) => goneEvents.has(p.eventId) || goneCommands.has(p.commandId));
  const keptEmits = before.commands.filter((c) => !goneCommands.has(c.id)).flatMap((c) => c.emits.filter((id) => goneEvents.has(id)).map((eventId) => ({ command: c, event: goneEvents.get(eventId)! })));
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
  /** 種類ごとに、使った英語名 (大文字・小文字の違いだけのものも重なりとする) */
  const taken = new Map<Map<string, string>, Set<string>>();
  const claim = (map: Map<string, string>, where: string, name: string, id: string) => {
    let lower = taken.get(map);
    if (!lower) {
      lower = new Set([...map.keys()].map((k) => k.toLowerCase()));
      taken.set(map, lower);
    }
    if (lower.has(name.toLowerCase())) note(`${where}: 英語名 ${name} が重なっています (ほかのものと別の名前にしてください)`);
    else {
      map.set(name, id);
      lower.add(name.toLowerCase());
    }
  };
  const aggregateByEnglish = new Map<string, string>();
  for (const a of next.domain.aggregates) if (a.english) aggregateByEnglish.set(a.english, a.id);

  const summary: DomainDraftSummary = { replaced: scope.length, contexts: 0, aggregates: 0, commands: 0, events: 0, policies: 0, relations: 0, terms: 0, excluded: 0, reattached: 0, lost: [] };
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
      claim(aggregateByEnglish, aWhere, aEn, aggregate.id);
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

  // 控えておいたものを、同じ英語名のものへ付け直す。下書きが同じ組を書いていれば、そちらを使う
  const newContext = (id: string): string | undefined => (inScope.has(id) ? (contextById.get(id)?.english ? contextByEnglish.get(contextById.get(id)!.english!) : undefined) : next.domain.contexts.some((c) => c.id === id) ? id : undefined);
  const newEvent = (id: string): string | undefined => (goneEvents.has(id) ? (goneEvents.get(id)!.english ? eventByEnglish.get(goneEvents.get(id)!.english!) : undefined) : next.domain.events.some((e) => e.id === id) ? id : undefined);
  const newCommand = (id: string): string | undefined => (goneCommands.has(id) ? (goneCommands.get(id)!.english ? commandByEnglish.get(goneCommands.get(id)!.english!) : undefined) : next.domain.commands.some((c) => c.id === id) ? id : undefined);
  const nameOf = (x: { name: string } | undefined) => x?.name || "(名前なし)";
  const reattach = <T>(label: string, r: CommandResult<T> | null) => {
    if (r?.ok) {
      next = r.model;
      summary.reattached++;
    } else summary.lost.push(label);
  };
  for (const r of keptRelations) {
    const upstreamId = newContext(r.upstreamId);
    const downstreamId = newContext(r.downstreamId);
    const label = `関係「${nameOf(contextById.get(r.upstreamId))} → ${nameOf(contextById.get(r.downstreamId))}」`;
    // 置き換えたコンテキストどうしの関係は、下書きが決める (書いていなければ消える)
    if (inScope.has(r.upstreamId) && inScope.has(r.downstreamId) && (!upstreamId || !downstreamId)) {
      summary.lost.push(label);
      continue;
    }
    if (upstreamId && downstreamId && next.domain.relations.some((x) => (x.upstreamId === upstreamId && x.downstreamId === downstreamId) || (x.upstreamId === downstreamId && x.downstreamId === upstreamId))) continue;
    reattach(label, upstreamId && downstreamId ? addContextRelation(next, { upstreamId, downstreamId, kind: r.kind, ...(r.integration ? { integration: r.integration } : {}), ...(r.note ? { note: r.note } : {}) }) : null);
  }
  for (const p of keptPolicies) {
    const eventId = newEvent(p.eventId);
    const commandId = newCommand(p.commandId);
    if (eventId && commandId && next.domain.policies.some((x) => x.eventId === eventId && x.commandId === commandId)) continue;
    const label = `ポリシー「${nameOf(before.events.find((e) => e.id === p.eventId))} → ${nameOf(before.commands.find((c) => c.id === p.commandId))}」`;
    reattach(label, eventId && commandId ? addDomainPolicy(next, { eventId, commandId, auto: p.auto }) : null);
  }
  for (const { command, event } of keptEmits) {
    const eventId = newEvent(event.id);
    const current = next.domain.commands.find((c) => c.id === command.id);
    if (!current || (eventId && current.emits.includes(eventId))) continue;
    reattach(`コマンド「${nameOf(command)}」が発生させるイベント「${nameOf(event)}」`, eventId ? updateDomainCommand(next, { id: command.id, patch: { emits: [...current.emits, eventId] } }) : null);
  }
  return { ok: true, model: next, summary };
}
