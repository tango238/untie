// モデルから表示用の値を引く純粋関数。
import type { Element, Issue, UntieModel } from "./types";

export interface IssueSummary {
  count: number;
  /** 対象にしている課題のうち最高の重要度 (件数 0 なら 0) */
  maxSeverity: number;
}

const NONE: IssueSummary = { count: 0, maxSeverity: 0 };

/** 要素ごとの課題バッジ用の集計。課題の対象になっている要素だけ入る */
export function issueSummaries(model: UntieModel): Map<string, IssueSummary> {
  const map = new Map<string, IssueSummary>();
  for (const e of model.elements) {
    if (e.kind !== "issue") continue;
    for (const id of e.targetIds) {
      const cur = map.get(id) ?? { count: 0, maxSeverity: 0 };
      map.set(id, { count: cur.count + 1, maxSeverity: Math.max(cur.maxSeverity, e.severity) });
    }
  }
  return map;
}

export function issueSummaryOf(model: UntieModel, elementId: string): IssueSummary {
  return issueSummaries(model).get(elementId) ?? NONE;
}

/** 全課題を重要度の高い順 (同じなら名前順) に並べる */
export function sortedIssues(model: UntieModel): Issue[] {
  const issues = model.elements.filter((e): e is Issue => e.kind === "issue");
  return [...issues].sort((a, b) => b.severity - a.severity || a.name.localeCompare(b.name, "ja"));
}

/** この要素を対象にしている課題 */
export function issuesTargeting(model: UntieModel, elementId: string): Issue[] {
  return sortedIssues(model).filter((i) => i.targetIds.includes(elementId));
}

export function findElementById(model: UntieModel, id: string): Element | undefined {
  return model.elements.find((e) => e.id === id);
}

/** 一覧に出す要素 (既定 BUC を除く) */
export function listableElements(model: UntieModel): Element[] {
  return model.elements.filter((e) => !(e.kind === "buc" && e.isDefault));
}

/** 業務の既定 BUC */
export function defaultBucOf(model: UntieModel, businessId: string): Element | undefined {
  return model.elements.find((e) => e.kind === "buc" && e.isDefault && e.businessId === businessId);
}
