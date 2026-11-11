// ドメインモデル (domain。4.6) の設計上の検証 (5.7)。参照の整合 (inspectDomain) とは別に、保存した判断の抜けを知らせる。純粋関数だけを置く。
// 保存した判断が 1 つも無ければ何も出さない (まだ始めていないだけ)。
import { aggregateInformationIds, isEmptyDomain } from "./domain";
import { deriveContextMap } from "./domainMap";
import { deriveDomainModel, type DomainDerivation } from "./domainModel";
import type { DesignDomainSelection } from "./domainScope";
import type { UntieModel } from "./types";

export type DomainCheckType =
  | "aggregateOverlap"
  | "informationWithoutAggregate"
  | "flowWithoutRelation"
  | "contextUnassigned"
  | "contextWithoutSubdomain"
  | "aggregateWithoutInvariant"
  | "missingEnglish";

export interface DomainCheckProblem {
  type: DomainCheckType;
  level: "error" | "warning";
  message: string;
  /** 行を押したときに選ぶもの。map はコンテキストマップへ移る */
  target?: { board: "domain"; selection: DesignDomainSelection; systemId?: string } | { board: "contextmap" };
}

export const DOMAIN_CHECK_TITLES: Record<DomainCheckType, string> = {
  aggregateOverlap: "同じコンテキストの 2 つの集約に、同じ情報が入っている",
  informationWithoutAggregate: "集約に入っていない情報",
  flowWithoutRelation: "つながりがあるのに、関係を決めていないコンテキストの組",
  contextUnassigned: "実装するシステムが決まっていないコンテキスト",
  contextWithoutSubdomain: "サブドメインの分類が決まっていないコンテキスト",
  aggregateWithoutInvariant: "不変条件の無い集約",
  missingEnglish: "英語名が無い (distill-ddd の形式で書き出すときに要る)",
};

export const DOMAIN_CHECK_ORDER: readonly DomainCheckType[] = [
  "aggregateOverlap",
  "informationWithoutAggregate",
  "flowWithoutRelation",
  "contextUnassigned",
  "contextWithoutSubdomain",
  "aggregateWithoutInvariant",
  "missingEnglish",
];

const nameOf = (x: { name: string } | undefined) => x?.name || "(名前なし)";

/** ドメインモデルを検証する。derivation を渡せば使い回す */
export function checkDomain(model: UntieModel, derivation: DomainDerivation = deriveDomainModel(model)): DomainCheckProblem[] {
  const d = model.domain;
  if (isEmptyDomain(d)) return [];
  const out: DomainCheckProblem[] = [];
  const byId = new Map(model.elements.map((e) => [e.id, e]));
  const contextById = new Map(d.contexts.map((c) => [c.id, c]));
  const systemOf = (bcId: string) => contextById.get(bcId)?.systemIds[0];
  const withAggregates = new Set(d.aggregates.map((a) => a.boundedContextId));

  // エラー: 同じコンテキストの 2 つの集約に同じ情報
  const owner = new Map<string, string>();
  for (const a of d.aggregates) {
    for (const infoId of aggregateInformationIds(a)) {
      const key = `${a.boundedContextId}\n${infoId}`;
      const first = owner.get(key);
      if (first !== undefined && first !== a.id) {
        out.push({
          type: "aggregateOverlap",
          level: "error",
          message: `コンテキスト「${nameOf(contextById.get(a.boundedContextId))}」の集約「${nameOf(d.aggregates.find((x) => x.id === first))}」と「${nameOf(a)}」に、情報「${nameOf(byId.get(infoId))}」が入っています`,
          target: { board: "domain", selection: { kind: "aggregate", id: a.id }, ...(systemOf(a.boundedContextId) ? { systemId: systemOf(a.boundedContextId)! } : {}) },
        });
      } else owner.set(key, a.id);
    }
  }

  // 警告: 言語の範囲にした分析のコンテキストの情報で、どの操作かが書くのに、どの集約にも入っていないもの
  const inAggregate = new Set(d.aggregates.flatMap(aggregateInformationIds));
  const covered = new Map<string, string>();
  for (const c of d.contexts) for (const id of c.contextIds) if (!covered.has(id)) covered.set(id, c.id);
  for (const a of derivation.aggregates) {
    const info = a.information;
    if (a.role === "reference" || inAggregate.has(info.id) || !info.contextId) continue;
    const bcId = covered.get(info.contextId);
    if (!bcId) continue;
    out.push({
      type: "informationWithoutAggregate",
      level: "warning",
      message: `情報「${nameOf(info)}」(コンテキスト「${nameOf(contextById.get(bcId))}」) は、どの集約にも入っていません`,
      target: { board: "domain", selection: { kind: "aggregate", id: info.id }, ...(systemOf(bcId) ? { systemId: systemOf(bcId)! } : {}) },
    });
  }

  // 警告: 導いたつながりがあるのに、関係を決めていない組
  for (const f of deriveContextMap(model, derivation).flows) {
    // どちらかの向きに関係を決めてあれば、決めた組とみなす
    if (f.relation || f.reverseRelation) continue;
    const via = [...f.events.map((e) => `イベント「${e}」`), ...f.reads.map((r) => `情報「${r}」の取得`)].slice(0, 3).join("、");
    out.push({
      type: "flowWithoutRelation",
      level: "warning",
      message: `「${nameOf(contextById.get(f.upstreamId))}」→「${nameOf(contextById.get(f.downstreamId))}」(${via}${f.events.length + f.reads.length > 3 ? " ほか" : ""}) の関係を決めていません`,
      target: { board: "contextmap" },
    });
  }

  for (const c of d.contexts) {
    const target = { board: "domain" as const, selection: { kind: "context" as const, id: c.id }, ...(c.systemIds[0] ? { systemId: c.systemIds[0] } : {}) };
    if (c.systemIds.length === 0) out.push({ type: "contextUnassigned", level: "warning", message: `コンテキスト「${nameOf(c)}」の実装するシステムが決まっていません`, target });
    // 集約を持たないコンテキスト (外部) は、分類を決めなくてよい
    if (c.subdomain === undefined && withAggregates.has(c.id)) out.push({ type: "contextWithoutSubdomain", level: "warning", message: `コンテキスト「${nameOf(c)}」のサブドメインの分類 (コア / 支援 / 汎用) が決まっていません`, target });
    if (c.english === undefined) out.push({ type: "missingEnglish", level: "warning", message: `コンテキスト「${nameOf(c)}」`, target });
  }
  for (const a of d.aggregates) {
    const target = { board: "domain" as const, selection: { kind: "aggregate" as const, id: a.id }, ...(systemOf(a.boundedContextId) ? { systemId: systemOf(a.boundedContextId)! } : {}) };
    if (a.invariants.length === 0) out.push({ type: "aggregateWithoutInvariant", level: "warning", message: `集約「${nameOf(a)}」に不変条件がありません`, target });
    if (a.english === undefined) out.push({ type: "missingEnglish", level: "warning", message: `集約「${nameOf(a)}」`, target });
  }
  const contextOfAggregate = new Map(d.aggregates.map((a) => [a.id, a.boundedContextId]));
  for (const c of d.commands) {
    if (c.english !== undefined) continue;
    const bcId = contextOfAggregate.get(c.aggregateId);
    out.push({ type: "missingEnglish", level: "warning", message: `コマンド「${nameOf(c)}」`, target: { board: "domain", selection: { kind: "command", id: c.id }, ...(bcId && systemOf(bcId) ? { systemId: systemOf(bcId)! } : {}) } });
  }
  for (const e of d.events) {
    if (e.english !== undefined) continue;
    out.push({ type: "missingEnglish", level: "warning", message: `イベント「${nameOf(e)}」`, target: { board: "domain", selection: { kind: "event", id: e.id }, ...(systemOf(e.boundedContextId) ? { systemId: systemOf(e.boundedContextId)! } : {}) } });
  }
  return out;
}
