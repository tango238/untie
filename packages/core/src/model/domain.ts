// ドメインモデル (domain。0.6.0) の定数と、参照の検査・掃除。純粋関数だけを置く。
// 保存するのは人の判断 (境界づけられたコンテキスト・集約・不変条件・コンテキスト間の関係・用語) と、分析に無いあるべき姿の振る舞い
// (コマンド・イベント・ポリシー) だけで、分析から導ける候補は保存しない (domainModel.ts が毎回導く)。
// 参照の規則は 1 か所 (inspectDomain) に書き、検証 (validateModel)・修復 (repairModel)・要素を消したときの掃除 (removeElement) が同じ規則を使う。
import type { Aggregate, BoundedContext, ContextRelation, DomainCommand, DomainEvent, DomainModel, DomainPolicy, DomainTerm, Element, UntieModel } from "./types";

export type Subdomain = NonNullable<BoundedContext["subdomain"]>;
export const SUBDOMAINS: readonly Subdomain[] = ["core", "supporting", "generic"];
export const SUBDOMAIN_LABELS: Record<Subdomain, string> = { core: "コア (Core)", supporting: "支援 (Supporting)", generic: "汎用 (Generic)" };
/** distill-ddd の書き出しで使う英語の表記 */
export const SUBDOMAIN_ENGLISH: Record<Subdomain, string> = { core: "Core", supporting: "Supporting", generic: "Generic" };

export type ContextRelationKind = ContextRelation["kind"];
export const CONTEXT_RELATION_KINDS: readonly ContextRelationKind[] = [
  "partnership",
  "sharedKernel",
  "customerSupplier",
  "conformist",
  "acl",
  "ohs",
  "publishedLanguage",
  "separateWays",
  "bigBallOfMud",
];
export const CONTEXT_RELATION_LABELS: Record<ContextRelationKind, string> = {
  partnership: "パートナーシップ (Partnership)",
  sharedKernel: "共有カーネル (Shared Kernel)",
  customerSupplier: "顧客 / 供給者 (Customer-Supplier)",
  conformist: "順応者 (Conformist)",
  acl: "腐敗防止層 (Anticorruption Layer)",
  ohs: "公開ホストサービス (Open Host Service)",
  publishedLanguage: "公表された言語 (Published Language)",
  separateWays: "別々の道 (Separate Ways)",
  bigBallOfMud: "巨大な泥団子 (Big Ball of Mud)",
};
/** 図の線に出す略号 (distill-ddd のコンテキストマップと同じ) */
export const CONTEXT_RELATION_SHORT: Record<ContextRelationKind, string> = {
  partnership: "P",
  sharedKernel: "SK",
  customerSupplier: "C-S",
  conformist: "CF",
  acl: "ACL",
  ohs: "OHS",
  publishedLanguage: "PL",
  separateWays: "SW",
  bigBallOfMud: "BBoM",
};
/** distill-ddd の書き出しで使う英語の表記 */
export const CONTEXT_RELATION_ENGLISH: Record<ContextRelationKind, string> = {
  partnership: "Partnership",
  sharedKernel: "Shared Kernel",
  customerSupplier: "Customer-Supplier",
  conformist: "Conformist",
  acl: "Anticorruption Layer",
  ohs: "Open Host Service",
  publishedLanguage: "Published Language",
  separateWays: "Separate Ways",
  bigBallOfMud: "Big Ball of Mud",
};
/** 上流・下流の向きを持たない (対等な) 関係 */
export const SYMMETRIC_RELATION_KINDS: ReadonlySet<ContextRelationKind> = new Set(["partnership", "sharedKernel", "separateWays"]);

export type Integration = NonNullable<ContextRelation["integration"]>;
export const INTEGRATIONS: readonly Integration[] = ["messaging", "rest", "rpc", "file", "manual"];
export const INTEGRATION_LABELS: Record<Integration, string> = {
  messaging: "メッセージ (イベント)",
  rest: "REST",
  rpc: "RPC",
  file: "ファイルの受け渡し",
  manual: "手作業 (転記)",
};
export const INTEGRATION_ENGLISH: Record<Integration, string> = { messaging: "Messaging", rest: "REST", rpc: "RPC", file: "File", manual: "Manual" };

const ENGLISH = /^[A-Za-z][A-Za-z0-9_]*$/;
/** 英語名 (識別子) として使えるか */
export function isEnglishName(text: string): boolean {
  return ENGLISH.test(text) && text.length <= 100;
}

/** 候補の出どころのキー (domain.excluded と、保存したものとの突き合わせに使う) */
export const eventCandidateKey = (eventId: string) => `event:${eventId}`;
export const policyCandidateKey = (relationId: string) => `policy:${relationId}`;
/** コマンドの出どころのキー (domainModel.ts の commandKey と同じ形) */
export const commandSourceKey = (source: { usecaseId: string; activityId?: string }) => (source.activityId ? `usecase:${source.usecaseId}/activity:${source.activityId}` : `usecase:${source.usecaseId}`);

/** ドメインモデルが空か (保存した判断が 1 つも無い) */
export function isEmptyDomain(domain: DomainModel): boolean {
  return (
    domain.contexts.length === 0 &&
    domain.aggregates.length === 0 &&
    domain.commands.length === 0 &&
    domain.events.length === 0 &&
    domain.policies.length === 0 &&
    domain.excluded.length === 0 &&
    domain.relations.length === 0 &&
    domain.terms.length === 0
  );
}

/** ドメインモデルで使われている id (不変条件の id も含む)。新しい id を作るときに避ける */
export function usedDomainIds(domain: DomainModel): Set<string> {
  const used = new Set<string>();
  for (const list of [domain.contexts, domain.aggregates, domain.commands, domain.events, domain.policies, domain.relations, domain.terms]) for (const x of list) used.add(x.id);
  for (const a of domain.aggregates) for (const inv of a.invariants) used.add(inv.id);
  return used;
}

/** 集約に入っている情報 (ルートと中の情報) */
export const aggregateInformationIds = (a: Pick<Aggregate, "rootInformationId" | "memberInformationIds">): string[] => [a.rootInformationId, ...a.memberInformationIds];

export interface DomainProblem {
  /** 何が壊れているか (id だけを含む。名前などの中身は入れない) */
  what: string;
  /** どう直したか */
  fix: string;
}

export interface DomainInspection {
  /** 壊れた参照を直したドメインモデル。壊れていなければ同じ参照 */
  domain: DomainModel;
  problems: DomainProblem[];
}

/**
 * ドメインモデルの参照の検査と修復。壊れた箇所の一覧と、直したドメインモデルを返す (壊れていなければ同じ参照)。
 * 規則:
 * - id は domain の中で一意 (種類をまたいでも。同時編集で 1 つの Y.Map に置くため)。重なったら後のものを消す
 * - コンテキスト: 分析のコンテキスト・システムでないものを指す contextIds・systemIds は外す
 * - 集約: コンテキストが無い・ルートの情報が無いものは消す。情報でない中の情報・ルートと同じ中の情報は外す。
 *   どの状態にも無い状態グループは外す。不変条件のもとの条件が無ければ、その参照だけ外す
 * - イベント: コンテキストが無いものは消す。集約が無い・別のコンテキストの集約なら集約の参照を外す。分析のイベントが無ければその参照を外す。
 *   同じ分析のイベントを指すものが複数あれば後のものを消す。属性のもとの情報が無ければその参照を外す
 * - コマンド: 集約が無いものは消す。出どころの操作が無ければ出どころを外し (あるべき姿のコマンドとして残す)、作業が無ければ作業だけ外す。
 *   同じ出どころのものが複数あれば後のものを消す。無いイベントは emits から外す
 * - ポリシー: イベントかコマンドが無いもの、同じ組のものは消す
 * - 関係: どちらかのコンテキストが無いもの、両端が同じもの、同じ向きの同じ組のものは消す
 * - 用語: コンテキストが無ければ全体で共通 (null) にする。分析の要素が無ければその参照を外す。同じ要素の用語が複数あれば後のものを消す
 * - excluded: 重複を除く
 * 同じコンテキストの 2 つの集約に同じ情報が入っている、などの設計上の問題は、ここでは見ない (domainCheck.ts)。
 */
export function inspectDomain(domain: DomainModel, elements: readonly Element[]): DomainInspection {
  const problems: DomainProblem[] = [];
  const kindOf = new Map<string, Element["kind"]>(elements.map((e) => [e.id, e.kind]));
  const groups = new Set<string>();
  for (const e of elements) if (e.kind === "state" && e.group) groups.add(e.group);
  const is = (id: string, kind: Element["kind"]) => kindOf.get(id) === kind;
  const seen = new Set<string>();
  /** id の重複を除く (種類をまたいで一意) */
  const unique = <T extends { id: string }>(items: readonly T[], label: string): T[] =>
    items.filter((x) => {
      if (seen.has(x.id)) {
        problems.push({ what: `${label} ${x.id} の id が重なっている`, fix: "後のものを消した" });
        return false;
      }
      seen.add(x.id);
      return true;
    });
  const same = <T>(a: readonly T[], b: readonly T[]) => a.length === b.length && a.every((x, i) => x === b[i]);

  // コンテキスト
  const contexts: BoundedContext[] = unique(domain.contexts, "コンテキスト").map((c) => {
    const contextIds = [...new Set(c.contextIds)].filter((id) => is(id, "context"));
    const systemIds = [...new Set(c.systemIds)].filter((id) => is(id, "system"));
    if (same(contextIds, c.contextIds) && same(systemIds, c.systemIds)) return c;
    if (!same(contextIds, c.contextIds)) problems.push({ what: `コンテキスト ${c.id} の分析のコンテキストが無い (か重なっている)`, fix: "外した" });
    if (!same(systemIds, c.systemIds)) problems.push({ what: `コンテキスト ${c.id} のシステムが無い (か重なっている)`, fix: "外した" });
    return { ...c, contextIds, systemIds };
  });
  const contextIds = new Set(contexts.map((c) => c.id));

  // 集約
  const aggregates: Aggregate[] = [];
  for (const a of unique(domain.aggregates, "集約")) {
    if (!contextIds.has(a.boundedContextId)) {
      problems.push({ what: `集約 ${a.id} のコンテキスト ${a.boundedContextId} が無い`, fix: "集約を消した" });
      continue;
    }
    if (!is(a.rootInformationId, "information")) {
      problems.push({ what: `集約 ${a.id} のルートの情報 ${a.rootInformationId} が無い`, fix: "集約を消した" });
      continue;
    }
    let next = a;
    const members = [...new Set(a.memberInformationIds)].filter((id) => id !== a.rootInformationId && is(id, "information"));
    if (!same(members, a.memberInformationIds)) {
      problems.push({ what: `集約 ${a.id} の中の情報が無い (かルートと重なっている)`, fix: "外した" });
      next = { ...next, memberInformationIds: members };
    }
    if (a.stateGroup !== undefined && !groups.has(a.stateGroup)) {
      problems.push({ what: `集約 ${a.id} の状態グループが、どの状態にも無い`, fix: "外した" });
      const { stateGroup: _drop, ...rest } = next;
      next = rest;
    }
    const invSeen = new Set<string>();
    const invariants = a.invariants
      .filter((inv) => {
        if (seen.has(inv.id) || invSeen.has(inv.id)) {
          problems.push({ what: `集約 ${a.id} の不変条件 ${inv.id} の id が重なっている`, fix: "後のものを消した" });
          return false;
        }
        invSeen.add(inv.id);
        return true;
      })
      .map((inv) => {
        if (inv.conditionId === undefined || is(inv.conditionId, "condition")) return inv;
        problems.push({ what: `集約 ${a.id} の不変条件 ${inv.id} のもとの条件 ${inv.conditionId} が無い`, fix: "条件の参照を外した" });
        const { conditionId: _drop, ...rest } = inv;
        return rest;
      });
    for (const id of invSeen) seen.add(id);
    if (!same(invariants, a.invariants)) next = { ...next, invariants };
    aggregates.push(next);
  }
  const aggregateById = new Map(aggregates.map((a) => [a.id, a]));

  // イベント
  const events: DomainEvent[] = [];
  const eventSources = new Set<string>();
  for (const e of unique(domain.events, "イベント")) {
    if (!contextIds.has(e.boundedContextId)) {
      problems.push({ what: `イベント ${e.id} のコンテキスト ${e.boundedContextId} が無い`, fix: "イベントを消した" });
      continue;
    }
    let next = e;
    if (e.eventId !== undefined) {
      if (!is(e.eventId, "event")) {
        problems.push({ what: `イベント ${e.id} の分析のイベント ${e.eventId} が無い`, fix: "分析のイベントの参照を外した" });
        const { eventId: _drop, ...rest } = next;
        next = rest;
      } else if (eventSources.has(e.eventId)) {
        problems.push({ what: `イベント ${e.id} と同じ分析のイベント ${e.eventId} を指すものが、ほかにある`, fix: "後のものを消した" });
        seen.delete(e.id);
        continue;
      } else eventSources.add(e.eventId);
    }
    if (e.aggregateId !== undefined && aggregateById.get(e.aggregateId)?.boundedContextId !== e.boundedContextId) {
      problems.push({ what: `イベント ${e.id} の集約 ${e.aggregateId} が、同じコンテキストに無い`, fix: "集約の参照を外した" });
      const { aggregateId: _drop, ...rest } = next;
      next = rest;
    }
    if (e.properties?.some((p) => p.informationId !== undefined && !is(p.informationId, "information"))) {
      problems.push({ what: `イベント ${e.id} の属性のもとの情報が無い`, fix: "情報の参照を外した" });
      next = {
        ...next,
        properties: e.properties.map((p) => {
          if (p.informationId === undefined || is(p.informationId, "information")) return p;
          const { informationId: _drop, ...rest } = p;
          return rest;
        }),
      };
    }
    events.push(next);
  }
  const eventIds = new Set(events.map((e) => e.id));

  // コマンド
  const commands: DomainCommand[] = [];
  const commandSources = new Set<string>();
  for (const c of unique(domain.commands, "コマンド")) {
    if (!aggregateById.has(c.aggregateId)) {
      problems.push({ what: `コマンド ${c.id} の集約 ${c.aggregateId} が無い`, fix: "コマンドを消した" });
      continue;
    }
    let next = c;
    if (c.source) {
      if (!is(c.source.usecaseId, "usecase")) {
        problems.push({ what: `コマンド ${c.id} の出どころの操作 ${c.source.usecaseId} が無い`, fix: "出どころを外した" });
        const { source: _drop, ...rest } = next;
        next = rest;
      } else {
        if (c.source.activityId !== undefined && !is(c.source.activityId, "activity")) {
          problems.push({ what: `コマンド ${c.id} の出どころの作業 ${c.source.activityId} が無い`, fix: "作業の参照を外した" });
          next = { ...next, source: { usecaseId: c.source.usecaseId } };
        }
        const key = commandSourceKey(next.source!);
        if (commandSources.has(key)) {
          problems.push({ what: `コマンド ${c.id} と同じ出どころのものが、ほかにある`, fix: "後のものを消した" });
          seen.delete(c.id);
          continue;
        }
        commandSources.add(key);
      }
    }
    const emits = [...new Set(c.emits)].filter((id) => eventIds.has(id));
    if (!same(emits, c.emits)) {
      problems.push({ what: `コマンド ${c.id} が発生させるイベントが無い (か重なっている)`, fix: "外した" });
      next = { ...next, emits };
    }
    commands.push(next);
  }
  const commandIds = new Set(commands.map((c) => c.id));

  // ポリシー
  const policyPairs = new Set<string>();
  const policies: DomainPolicy[] = unique(domain.policies, "ポリシー").filter((p) => {
    if (!eventIds.has(p.eventId) || !commandIds.has(p.commandId)) {
      problems.push({ what: `ポリシー ${p.id} のイベントかコマンドが無い`, fix: "ポリシーを消した" });
      return false;
    }
    const key = `${p.eventId}\n${p.commandId}`;
    if (policyPairs.has(key)) {
      problems.push({ what: `ポリシー ${p.id} と同じイベントとコマンドの組のものが、ほかにある`, fix: "後のものを消した" });
      return false;
    }
    policyPairs.add(key);
    return true;
  });

  // 関係
  const relationPairs = new Set<string>();
  const relations: ContextRelation[] = unique(domain.relations, "関係").filter((r) => {
    if (!contextIds.has(r.upstreamId) || !contextIds.has(r.downstreamId) || r.upstreamId === r.downstreamId) {
      problems.push({ what: `関係 ${r.id} のコンテキストが無い (か両端が同じ)`, fix: "関係を消した" });
      return false;
    }
    const key = `${r.upstreamId}\n${r.downstreamId}`;
    if (relationPairs.has(key)) {
      problems.push({ what: `関係 ${r.id} と同じ向きの同じ組のものが、ほかにある`, fix: "後のものを消した" });
      return false;
    }
    relationPairs.add(key);
    return true;
  });

  // 用語
  const termElements = new Set<string>();
  const terms: DomainTerm[] = unique(domain.terms, "用語")
    .filter((t) => {
      if (t.elementId === undefined || !kindOf.has(t.elementId)) return true;
      if (termElements.has(t.elementId)) {
        problems.push({ what: `用語 ${t.id} と同じ分析の要素 ${t.elementId} の用語が、ほかにある`, fix: "後のものを消した" });
        return false;
      }
      termElements.add(t.elementId);
      return true;
    })
    .map((t) => {
    let next = t;
    if (t.boundedContextId !== null && !contextIds.has(t.boundedContextId)) {
      problems.push({ what: `用語 ${t.id} のコンテキスト ${t.boundedContextId} が無い`, fix: "全体で共通の用語にした" });
      next = { ...next, boundedContextId: null };
    }
    if (t.elementId !== undefined && !kindOf.has(t.elementId)) {
      problems.push({ what: `用語 ${t.id} の分析の要素 ${t.elementId} が無い`, fix: "要素の参照を外した" });
      const { elementId: _drop, ...rest } = next;
      next = rest;
    }
    return next;
  });

  const excluded = [...new Set(domain.excluded)];
  if (excluded.length !== domain.excluded.length) problems.push({ what: "外した候補のキーが重なっている", fix: "重複を除いた" });

  if (problems.length === 0) return { domain, problems };
  return { domain: { contexts, aggregates, commands, events, policies, excluded, relations, terms }, problems };
}

/**
 * 削除した要素への参照を、ドメインモデルから掃除する (immer の draft に使う)。規則は inspectDomain と同じ:
 * 情報を消すと、それをルートにする集約 (と、そのコマンド・ポリシー) も消え、中の情報・属性からは外れる。
 * コンテキスト・システムは境界づけられたコンテキストから外れ、操作・作業はコマンドの出どころから外れる (コマンドはあるべき姿のものとして残る)。
 * 状態を消して状態グループが無くなれば、集約の状態グループも外れる
 */
export function sweepDomain(draft: UntieModel): void {
  const result = inspectDomain(draft.domain, draft.elements);
  if (result.problems.length > 0) draft.domain = result.domain;
}

/** 状態グループの名前が変わったとき、集約の状態グループを付け替える (もとの名前の状態が 1 つも残っていないときだけ呼ぶ) */
export function renameDomainStateGroup(draft: UntieModel, from: string, to: string): void {
  for (const a of draft.domain.aggregates) if (a.stateGroup === from) a.stateGroup = to;
}

/**
 * その要素を消したときに、一緒に消える・外れるドメインモデルの要約 (確認ダイアログに出す)。空なら参照されていない。
 * 「集約 2 (ドメインモデル)」「境界づけられたコンテキストの範囲 1」のような文字列
 */
export function domainReferences(model: UntieModel, elementId: string): string[] {
  const target = model.elements.find((e) => e.id === elementId);
  if (!target) return [];
  const d = model.domain;
  const out: string[] = [];
  const push = (label: string, n: number) => {
    if (n > 0) out.push(`${label} ${n}`);
  };
  if (target.kind === "information") {
    const roots = d.aggregates.filter((a) => a.rootInformationId === target.id);
    const rootIds = new Set(roots.map((a) => a.id));
    push("集約 (ドメインモデル。コマンドも一緒に消えます)", roots.length);
    push("集約の中の情報", d.aggregates.filter((a) => !rootIds.has(a.id) && a.memberInformationIds.includes(target.id)).length);
  } else if (target.kind === "context") {
    push("境界づけられたコンテキストの言語の範囲", d.contexts.filter((c) => c.contextIds.includes(target.id)).length);
  } else if (target.kind === "system") {
    push("境界づけられたコンテキストの実装先", d.contexts.filter((c) => c.systemIds.includes(target.id)).length);
  } else if (target.kind === "usecase" || target.kind === "activity") {
    push("コマンドの出どころ (ドメインモデル。コマンドは残ります)", d.commands.filter((c) => c.source && (c.source.usecaseId === target.id || c.source.activityId === target.id)).length);
  } else if (target.kind === "event") {
    push("ドメインイベントのもとのイベント (ドメインモデル。イベントは残ります)", d.events.filter((e) => e.eventId === target.id).length);
  } else if (target.kind === "condition") {
    push("不変条件のもとの条件", d.aggregates.reduce((n, a) => n + a.invariants.filter((i) => i.conditionId === target.id).length, 0));
  }
  push("用語の定義 (ドメインモデル。用語は残ります)", d.terms.filter((t) => t.elementId === target.id).length);
  return out;
}
