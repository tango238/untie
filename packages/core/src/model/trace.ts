// 担い手 (アクター / 外部アクター / システム) まで辿れるかの検証。純粋関数だけを置く。
// つながりは必須にしない (上から順に書き出していく途中の状態を許す) ので、
// 辿り着けない要素と、どこで途切れているかを一覧にして知らせる。
// 作業は担当 (担い手) を必ず持つ。業務を通って辿れても、担当が無ければ途切れとする。
// 辿れるかのエラーとは別に、警告 (traceWarnings) を知らせる: 1 つの業務に複数のアクター。
import { ELEMENT_KIND_LABELS, isContextMemberKind, type Element, type ElementKind, type UntieModel } from "./types";

/** 検証の対象にしない要素 (課題は対象要素に付くもの、既定 BUC は業務と一体) */
function isTraceTarget(e: Element): boolean {
  return e.kind !== "issue" && !(e.kind === "buc" && e.isDefault);
}

/** 上位がまったく無いときの理由 (ここで途切れている) */
const NO_PARENT_REASONS: Partial<Record<ElementKind, string>> = {
  business: "主担当のアクターがいません",
  buc: "業務に属していません",
  activity: "担当 (アクター・外部アクター) がいません",
  usecase: "どの作業にも使われておらず、きっかけのイベントもありません",
  event: "どの操作・システムからも発生していません",
  screen: "属するシステムがありません",
  nfr: "属するシステムがありません",
  context: "情報・状態・条件・バリエーションが入っていません",
  information: "どの操作にも扱われておらず、扱われている情報とも関連していません",
  system: "どの操作の対象にもなっておらず、画面もイベントもありません",
  ledger: "どの操作の対象にもなっていません",
  condition: "どの操作の判断にも使われていません",
  variation: "どの情報・条件の種別にもなっていません",
  state: "どの操作・条件ともつながっていません",
};

/** 途切れ箇所の直し方 (その要素自身を編集して直せること) */
export const FIX_HINTS: Partial<Record<ElementKind, string>> = {
  business: "業務のボードでアクターの枠の「既存から足す」で入れるか、プロパティ欄の「関係を追加」で主担当のアクターを結んでください。",
  buc: "プロパティ欄で業務を選んでください。",
  activity: "プロパティ欄の「関係を追加」で、担当のアクター・外部アクターを結んでください。人が担当しない処理なら、作業をやめて、イベントをきっかけにした操作 (対象: システム) にしてください。",
  usecase: "操作のボードで作業の枠の「既存から足す」で入れるか、プロパティ欄の「関係を追加」で使う作業か、きっかけのイベントを結んでください。",
  event: "プロパティ欄の「関係を追加」で、発生させる操作かシステムを結んでください。",
  screen: "プロパティ欄で、属するシステムを選んでください。",
  nfr: "プロパティ欄で、属するシステムを選んでください。",
  context: "情報・状態・条件・バリエーションのプロパティ欄で、このコンテキストを選んでください。",
  information: "情報のボードのプロパティ欄の「関係を追加」で、扱う操作を結んでください。",
  system: "プロパティ欄の「関係を追加」で対象にする操作を結ぶか、操作のプロパティ欄の「対象」でこのシステム (か、その画面) を選んでください。",
  ledger: "プロパティ欄の「関係を追加」で対象にする操作を結ぶか、操作のプロパティ欄の「対象」でこの帳票を選んでください。",
  condition: "プロパティ欄の「関係を追加」で、判断に使う操作を結んでください。",
  variation: "プロパティ欄の「関係を追加」で、種別にする情報か条件を結んでください。",
  state: "プロパティ欄の「関係を追加」で、操作か条件を結んでください。",
};

/**
 * 要素ごとの「担い手に近い側」の要素。これを辿ってアクター / 外部アクター / システムに着けばよい。
 * - 業務 ← 主担当のアクター
 * - 活動 (BUC) ← 業務
 * - 作業 ← 担当のアクター・外部アクター (所属の活動・業務からは辿らない)
 * - 操作 ← 使う作業、きっかけのイベント
 * - イベント ← 発生させる操作・システム
 * - 画面・非機能要件 ← 属するシステム
 * - 情報 ← 扱う操作、関連する情報 (置き場所からは辿らない。置き場所は扱う操作から導くので)
 * - コンテキスト ← 入っている情報・状態・条件・バリエーション
 * - 帳票 ← 対象にする操作
 * システムは担い手なので辿り着く先になる。何とも結ばれていないシステムは別に知らせる。
 * - 条件 ← 判断に使う操作
 * - バリエーション ← 種別にしている情報・条件
 * - 状態 ← 実行可・次の状態で結んだ操作、状態を参照する条件
 */
export function traceParents(model: UntieModel): Map<string, string[]> {
  const parents = new Map<string, string[]>();
  const add = (child: string, parent: string) => {
    const list = parents.get(child) ?? [];
    if (!list.includes(parent)) list.push(parent);
    parents.set(child, list);
  };
  for (const e of model.elements) {
    if (e.kind === "buc") add(e.id, e.businessId);
    if ((e.kind === "screen" || e.kind === "nfr") && "systemId" in e) add(e.id, e.systemId);
    if (isContextMemberKind(e.kind) && "contextId" in e && e.contextId) add(e.contextId, e.id);
  }
  for (const r of model.relations) {
    switch (r.kind) {
      case "actorBusiness":
      case "actorActivity":
      case "activityUsecase":
      case "usecaseInformation":
      case "usecaseCondition":
      case "informationVariation":
      case "conditionVariation":
      case "conditionState":
      case "usecaseState":
      case "usecaseEvent":
      case "systemEvent":
      case "eventUsecase":
        add(r.targetId, r.sourceId);
        break;
      case "usecaseSystem":
        // 帳票は対象にする操作から辿る (システムは担い手なので辿り着く先)
        add(r.targetId, r.sourceId);
        break;
      case "stateUsecase":
        // 始点が下位 (状態 → 操作) なので向きを逆にする
        add(r.sourceId, r.targetId);
        break;
      case "informationRelated":
        add(r.sourceId, r.targetId);
        add(r.targetId, r.sourceId);
        break;
    }
  }
  return parents;
}

export interface TraceProblem {
  elementId: string;
  /** ここで途切れている (上位が無い) か */
  isBreak: boolean;
  reason: string;
  /** 途切れ箇所の直し方 (途切れ箇所だけ) */
  fix?: string;
  /** 途切れている箇所の要素 id (自分が途切れ箇所なら自分) */
  breakIds: string[];
}

export interface TraceResult {
  /** 検証した要素の数 (課題と既定 BUC を除く) */
  total: number;
  /** 担い手 (アクター / 外部アクター / システム) に辿り着ける要素 id */
  reached: Set<string>;
  /** 辿り着けない要素。途切れ箇所 → それ以外の順、同じなら要素の並び順 */
  problems: TraceProblem[];
}

const label = (e: Element | undefined) => (e ? `${ELEMENT_KIND_LABELS[e.kind]}「${e.name || "(名前なし)"}」` : "");

/** 担い手 (アクター / 外部アクター / システム) */
const PERFORMER_KINDS: readonly ElementKind[] = ["actor", "externalActor", "system"];

/** すべての要素が担い手まで辿れるかを調べる */
export function traceToActors(model: UntieModel): TraceResult {
  const byId = new Map(model.elements.map((e) => [e.id, e]));
  const parents = traceParents(model);
  const children = new Map<string, string[]>();
  for (const [child, ps] of parents) {
    for (const p of ps) children.set(p, [...(children.get(p) ?? []), child]);
  }

  // アクター / 外部アクターから下位へ広げる
  const reached = new Set<string>();
  const queue = model.elements.filter((e) => PERFORMER_KINDS.includes(e.kind)).map((e) => e.id);
  for (const id of queue) reached.add(id);
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const c of children.get(id) ?? []) {
      if (reached.has(c) || !byId.has(c)) continue;
      reached.add(c);
      queue.push(c);
    }
  }

  const targets = model.elements.filter(isTraceTarget);
  // システムは辿り着く先だが、操作の対象・イベントの発生元のどちらでもなく、画面も無ければ途切れとする (情報の置き場所は対象から導くので、別には数えない)
  const linkedSystems = new Set<string>();
  for (const r of model.relations) {
    if (r.kind === "systemEvent") linkedSystems.add(r.sourceId);
    if (r.kind === "usecaseSystem") linkedSystems.add(r.targetId);
  }
  for (const e of model.elements) if (e.kind === "screen") linkedSystems.add(e.systemId);
  const unreached = targets.filter((e) => !reached.has(e.id) || (e.kind === "system" && !linkedSystems.has(e.id)));
  const parentsOf = (id: string) => (parents.get(id) ?? []).filter((p) => byId.has(p));

  // 上位をさかのぼって、上位の無い要素 (途切れ箇所) を集める
  const breaksOf = (id: string): string[] => {
    const seen = new Set<string>([id]);
    const stack = [id];
    const found: string[] = [];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      const ps = parentsOf(cur);
      if (ps.length === 0) {
        found.push(cur);
        continue;
      }
      for (const p of ps) {
        if (seen.has(p)) continue;
        seen.add(p);
        stack.push(p);
      }
    }
    return found;
  };

  const problems: TraceProblem[] = unreached.map((e) => {
    const ps = parentsOf(e.id);
    const breakIds = breaksOf(e.id);
    if (ps.length === 0) {
      return {
        elementId: e.id,
        isBreak: true,
        reason: NO_PARENT_REASONS[e.kind] ?? "上位とつながっていません",
        ...(FIX_HINTS[e.kind] ? { fix: FIX_HINTS[e.kind] } : {}),
        breakIds: [e.id],
      };
    }
    if (breakIds.length === 0) {
      // 上位はあるが、互いにつながっているだけで外へ出られない (関連する情報どうしなど)
      return {
        elementId: e.id,
        isBreak: true,
        reason: `${NO_PARENT_REASONS[e.kind] ?? "上位とつながっていません"} (つながっている${ps.map((p) => label(byId.get(p))).join("、")}も辿り着けません)`,
        ...(FIX_HINTS[e.kind] ? { fix: FIX_HINTS[e.kind] } : {}),
        breakIds: [e.id],
      };
    }
    return {
      elementId: e.id,
      isBreak: false,
      reason: `上位の${ps.map((p) => label(byId.get(p))).join("、")}から先が途切れています`,
      breakIds: [...new Set(breakIds)],
    };
  });
  problems.sort((a, b) => Number(b.isBreak) - Number(a.isBreak));

  return { total: targets.length, reached, problems };
}

/** 警告の種類 */
export type TraceWarningType = "businessActors";

/** 警告 (エラーではない)。辿れるかには数えず、直さなくても保存や編集はできる */
export interface TraceWarning {
  type: TraceWarningType;
  /** 警告の対象の要素 (業務) */
  elementId: string;
  /**
   * 関わる要素の id。
   * businessActors: その業務に付いているアクター (関係を結んだ順)
   */
  relatedIds: string[];
  reason: string;
  fix: string;
}

export const TRACE_WARNING_TITLES: Record<TraceWarningType, string> = {
  businessActors: "1 つの業務に複数のアクターが付いています",
};

/** 警告の種類ごとの、見出しの下に出す案内 */
export const TRACE_WARNING_HINTS: Record<TraceWarningType, string> = {
  businessActors: "業務をアクターごとに分解できるか検討してください。",
};

const nameOf = (byId: Map<string, Element>, id: string) => `「${byId.get(id)?.name || "(名前なし)"}」`;

/**
 * 警告を、種類ごとに、要素の並び順で返す。
 * 辿り着けない (エラー) ではないので、traceToActors の結果には入れない
 */
export function traceWarnings(model: UntieModel): TraceWarning[] {
  return [...businessActorWarnings(model)];
}

/** 1 つの業務に複数のアクターが付いている (主担当が 1 人に決まっていない) */
function businessActorWarnings(model: UntieModel): TraceWarning[] {
  const byId = new Map(model.elements.map((e) => [e.id, e]));
  const actorsOf = new Map<string, string[]>();
  for (const r of model.relations) {
    if (r.kind !== "actorBusiness") continue;
    const actor = byId.get(r.sourceId);
    const business = byId.get(r.targetId);
    if (actor?.kind !== "actor" || business?.kind !== "business") continue;
    const list = actorsOf.get(business.id) ?? [];
    if (!list.includes(actor.id)) list.push(actor.id);
    actorsOf.set(business.id, list);
  }
  const warnings: TraceWarning[] = [];
  for (const e of model.elements) {
    const actorIds = actorsOf.get(e.id);
    if (e.kind !== "business" || !actorIds || actorIds.length < 2) continue;
    warnings.push({
      type: "businessActors",
      elementId: e.id,
      relatedIds: actorIds,
      reason: `主担当のアクターが ${actorIds.length} 人います: ${actorIds.map((id) => nameOf(byId, id)).join("、")}`,
      fix: "業務に結ぶ主担当は 1 人にしてください。ほかの人は、作業の担当として作業に結びます。",
    });
  }
  return warnings;
}
