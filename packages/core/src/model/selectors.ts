// モデルから表示用の値を引く純粋関数。
import {
  ISSUE_SCOPES,
  ISSUE_TARGET_KINDS,
  isIssueTargetKind,
  issueScopeOfKind,
  type Element,
  type Issue,
  type IssueScope,
  type UntieModel,
} from "./types";

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

/**
 * 課題の区分。対象が無ければ未整理、あれば対象の種類で全体的 / 具体的に分かれる。
 * 種類の混ざった課題はコマンドで作れないが、手で書いたファイルなら最初の対象で決める (検証でエラーにする)
 */
export function issueScope(model: UntieModel, issue: Issue): IssueScope {
  for (const id of issue.targetIds) {
    const t = model.elements.find((e) => e.id === id);
    if (t && isIssueTargetKind(t.kind)) return issueScopeOfKind(t.kind);
  }
  return "unsorted";
}

/** 区分ごとの課題 (それぞれ重要度の高い順) */
export function issuesByScope(model: UntieModel): Record<IssueScope, Issue[]> {
  const out = Object.fromEntries(ISSUE_SCOPES.map((s) => [s, [] as Issue[]])) as Record<IssueScope, Issue[]>;
  for (const i of sortedIssues(model)) out[issueScope(model, i)].push(i);
  return out;
}

export interface IssueTargetGroup {
  /** 対象の要素 (未整理は null) */
  target: Element | null;
  /** 重要度の高い順 */
  issues: Issue[];
}

export interface IssueScopeSection {
  scope: IssueScope;
  groups: IssueTargetGroup[];
  /** 区分に入る課題の数 (重複なし) */
  count: number;
}

/**
 * 課題一覧の「対象ごと」の並び: 未整理 → 全体的 → 具体的。全体的・具体的は対象ごとにまとめる
 * (対象が複数ある課題は、それぞれの対象の下に出る)。対象は 登場人物 → 業務 → 作業 → 操作、同じ種類は名前順
 */
export function issueBoardSections(model: UntieModel): IssueScopeSection[] {
  const byScope = issuesByScope(model);
  const byId = new Map(model.elements.map((e) => [e.id, e]));
  const kindOrder = (e: Element) => (ISSUE_TARGET_KINDS as readonly string[]).indexOf(e.kind);
  return ISSUE_SCOPES.map((scope) => {
    const issues = byScope[scope];
    if (scope === "unsorted") return { scope, groups: issues.length > 0 ? [{ target: null, issues }] : [], count: issues.length };
    const groups = new Map<string, IssueTargetGroup>();
    for (const i of issues) {
      for (const id of i.targetIds) {
        const t = byId.get(id);
        if (!t) continue;
        const g = groups.get(id) ?? { target: t, issues: [] };
        g.issues.push(i);
        groups.set(id, g);
      }
    }
    const sorted = [...groups.values()].sort(
      (a, b) => kindOrder(a.target!) - kindOrder(b.target!) || a.target!.name.localeCompare(b.target!.name, "ja"),
    );
    return { scope, groups: sorted, count: issues.length };
  });
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

export interface ActivityHours {
  /** 作業自身に入れた時間 */
  own?: number;
  /** 使う操作に入れた時間の合計 (時間の入った操作が 1 つも無ければ undefined) */
  usecases?: number;
}

/** 作業の時間。作業自身の時間と、使う操作の時間の合計を分けて返す */
export function activityHours(model: UntieModel, activityId: string): ActivityHours {
  const act = model.elements.find((e) => e.id === activityId);
  if (!act || act.kind !== "activity") return {};
  const ucIds = new Set(model.relations.filter((r) => r.kind === "activityUsecase" && r.sourceId === activityId).map((r) => r.targetId));
  let sum: number | undefined;
  for (const e of model.elements) {
    if (e.kind === "usecase" && ucIds.has(e.id) && e.hours !== undefined) sum = (sum ?? 0) + e.hours;
  }
  return {
    ...(act.hours !== undefined ? { own: act.hours } : {}),
    // 小数の足し算の誤差を丸める
    ...(sum !== undefined ? { usecases: Math.round(sum * 10) / 10 } : {}),
  };
}

/** 時間の表示 (小数点第一位まで) */
export function formatHours(hours: number): string {
  return `${hours.toFixed(1)} 時間`;
}

export interface ActivityTriggers {
  /** 起点となる作業 (activityTrigger。関係の並び順) */
  activities: Element[];
  /** 起点となるイベント (eventActivity。関係の並び順) */
  events: Element[];
  /** その他 (triggerNote) */
  note?: string;
}

const isTriggerRelation = (kind: string) => kind === "activityTrigger" || kind === "eventActivity";

/** 作業ごとの起点 (作業・イベント・その他)。起点のある作業だけが入る。モデルを 1 度だけ走査する */
export function activityTriggerIndex(model: UntieModel): Map<string, ActivityTriggers> {
  const byId = new Map(model.elements.map((e) => [e.id, e]));
  const map = new Map<string, ActivityTriggers>();
  const entry = (id: string): ActivityTriggers => {
    let t = map.get(id);
    if (!t) map.set(id, (t = { activities: [], events: [] }));
    return t;
  };
  for (const r of model.relations) {
    if (!isTriggerRelation(r.kind)) continue;
    const from = byId.get(r.sourceId);
    if (!from || byId.get(r.targetId)?.kind !== "activity") continue;
    (r.kind === "activityTrigger" ? entry(r.targetId).activities : entry(r.targetId).events).push(from);
  }
  for (const e of model.elements) if (e.kind === "activity" && e.triggerNote) entry(e.id).note = e.triggerNote;
  return map;
}

/** 作業の起点 (作業・イベント・その他) */
export function activityTriggers(model: UntieModel, activityId: string): ActivityTriggers {
  return activityTriggerIndex(model).get(activityId) ?? { activities: [], events: [] };
}

/** この作業を起点にしている作業 (後続の作業。関係の並び順) */
export function activitiesTriggeredBy(model: UntieModel, activityId: string): Element[] {
  const byId = new Map(model.elements.map((e) => [e.id, e]));
  const out: Element[] = [];
  for (const r of model.relations) {
    if (r.kind !== "activityTrigger" || r.sourceId !== activityId) continue;
    const to = byId.get(r.targetId);
    if (to) out.push(to);
  }
  return out;
}

function summaryOf(t: ActivityTriggers): string | undefined {
  const parts = [
    ...t.activities.map((a) => a.name || "(名前なし)"),
    ...t.events.map((e) => `${e.name || "(名前なし)"} (イベント)`),
    ...(t.note ? [t.note] : []),
  ];
  return parts.length > 0 ? `起点: ${parts.join(" / ")}` : undefined;
}

/** 作業ごとの起点の要約 (「起点: 受注の確認 / 入荷が登録された (イベント) / 電話」)。起点のある作業だけが入る */
export function triggerSummaries(model: UntieModel): Map<string, string> {
  const map = new Map<string, string>();
  for (const [id, t] of activityTriggerIndex(model)) {
    const text = summaryOf(t);
    if (text) map.set(id, text);
  }
  return map;
}

/** 1 つの作業の起点の要約。起点が無ければ undefined */
export function triggerSummary(model: UntieModel, activityId: string): string | undefined {
  return triggerSummaries(model).get(activityId);
}
