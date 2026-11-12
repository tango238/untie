// 分析（簡易）のワークフローボード。登場人物 → 業務 → 活動 → 作業 を 1 枚で見る。
// モデルには保存せず (配置も持たない)、毎回モデルから組み立てる。純粋関数だけを置く。
import { addElement, type CommandResult } from "./commands";
import { addToGroup, type FixedGroup } from "./fixedBoards";
import { defaultBucOf } from "./selectors";
import { ELEMENT_KIND_LABELS, type Activity, type Actor, type Buc, type Business, type Element, type ElementKind, type ExternalActor, type UntieModel } from "./types";

// ---------------------------------------------------------------- ボードの id

/** 簡易モードのボードの種類 (いまはワークフローだけ) */
export const SIMPLE_BOARD_KINDS = ["workflow"] as const;
export type SimpleBoardKind = (typeof SIMPLE_BOARD_KINDS)[number];

export const SIMPLE_BOARD_LABELS: Record<SimpleBoardKind, string> = {
  workflow: "ワークフロー",
};

const PREFIX = "simple:";

export function simpleBoardId(kind: SimpleBoardKind): string {
  return `${PREFIX}${kind}`;
}

/** 簡易モードのボードの id なら種類を返す */
export function parseSimpleBoardId(boardId: string): SimpleBoardKind | null {
  if (!boardId.startsWith(PREFIX)) return null;
  const kind = boardId.slice(PREFIX.length);
  return (SIMPLE_BOARD_KINDS as readonly string[]).includes(kind) ? (kind as SimpleBoardKind) : null;
}

/** ワークフローボードで構造 (関係・所属・削除) を直せる要素か。ほかの種類 (システム・操作・コンテキストなど) は、子の確認の対象外なので詳細で直す */
export function isWorkflowElement(el: Pick<Element, "kind"> & { isDefault?: boolean }): boolean {
  if (el.kind === "buc") return el.isDefault !== true;
  return el.kind === "actor" || el.kind === "externalActor" || el.kind === "business" || el.kind === "activity";
}

/** 簡易モードでの種別の呼び名 (アクター → 登場人物。ボードと同じ言い方) */
export function workflowKindLabel(kind: ElementKind): string {
  if (kind === "actor") return "登場人物";
  if (kind === "externalActor") return "外部の登場人物";
  return ELEMENT_KIND_LABELS[kind];
}

// ---------------------------------------------------------------- 組み立て

/** 活動 (既定でない BUC) の枠と、その作業 */
export interface WorkflowBuc {
  buc: Buc;
  activities: Activity[];
}

/** 業務の枠。直接属する作業 (既定の活動の作業) と、活動の枠 */
export interface WorkflowBusiness {
  business: Business;
  /** 業務に直接属する作業 (既定 BUC の作業) */
  direct: Activity[];
  bucs: WorkflowBuc[];
  /** 業務の主担当の登場人物 (複数いるときはすべて。検証が警告を出す) */
  ownerIds: string[];
}

/** 登場人物 1 人の行 */
export interface WorkflowLane {
  actor: Actor | ExternalActor;
  businesses: WorkflowBusiness[];
}

export interface Workflow {
  lanes: WorkflowLane[];
  /** 主担当の登場人物がいない業務 */
  unassigned: WorkflowBusiness[];
  /** どの業務にも属さない作業 (bucId が無い・指す先が無い) */
  orphanActivities: Activity[];
}

/** 作業 → 担当の登場人物 (actorActivity)。作業の行に添えて見せる */
export function activityAssigneeIds(model: UntieModel, activityId: string): string[] {
  return model.relations.filter((r) => r.kind === "actorActivity" && r.targetId === activityId).map((r) => r.sourceId);
}

/**
 * ワークフローを組み立てる。並びはモデルの順 (固定ボードと同じ)。
 * 業務が複数の登場人物に結ばれているときは、それぞれの行に出す (どの行でも同じ業務なので、選択は共通)
 */
export function buildWorkflow(model: UntieModel): Workflow {
  const businesses = model.elements.filter((e): e is Business => e.kind === "business");
  const bucs = model.elements.filter((e): e is Buc => e.kind === "buc");
  const activities = model.elements.filter((e): e is Activity => e.kind === "activity");

  const boxOf = (biz: Business): WorkflowBusiness => {
    const def = defaultBucOf(model, biz.id);
    return {
      business: biz,
      direct: def ? activities.filter((a) => a.bucId === def.id) : [],
      bucs: bucs.filter((b) => b.businessId === biz.id && !b.isDefault).map((buc) => ({ buc, activities: activities.filter((a) => a.bucId === buc.id) })),
      ownerIds: model.relations.filter((r) => r.kind === "actorBusiness" && r.targetId === biz.id).map((r) => r.sourceId),
    };
  };
  const boxes = businesses.map(boxOf);

  const lanes: WorkflowLane[] = model.elements
    .filter((e): e is Actor | ExternalActor => e.kind === "actor" || e.kind === "externalActor")
    .map((actor) => ({ actor, businesses: boxes.filter((b) => b.ownerIds.includes(actor.id)) }));
  const actorIds = new Set(lanes.map((l) => l.actor.id));
  const unassigned = boxes.filter((b) => !b.ownerIds.some((id) => actorIds.has(id)));
  // 業務の枠に出した作業。検証に通らないモデル (存在しない活動を指す作業・既定の活動が 2 つある業務など) でも
  // 作業が消えないよう、どの枠にも出ない作業はすべて「業務に属さない作業」に入れる
  const shown = new Set(boxes.flatMap((b) => [...b.direct, ...b.bucs.flatMap((x) => x.activities)]).map((a) => a.id));
  return { lanes, unassigned, orphanActivities: activities.filter((a) => !shown.has(a.id)) };
}

// ---------------------------------------------------------------- 子の数え上げと削除の影響

/** 消す・外すことで巻き込まれるものの 1 種類分 */
export interface ImpactItem {
  /** 何が巻き込まれるか (利用者向けの言葉) */
  label: "業務" | "活動" | "作業" | "操作";
  count: number;
  /**
   * removed: 一緒に消える
   * kept: 消えずに残り、結び付きだけが外れる (note に行き先を書く)
   */
  effect: "removed" | "kept";
  note?: string;
}

const find = (model: UntieModel, id: string): Element | undefined => model.elements.find((e) => e.id === id);

/** 業務に属する作業 (業務に直接のものと、活動の作業) */
function activitiesOfBusiness(model: UntieModel, businessId: string): Activity[] {
  const owned = new Set(model.elements.filter((e): e is Buc => e.kind === "buc" && e.businessId === businessId).map((b) => b.id));
  return model.elements.filter((e): e is Activity => e.kind === "activity" && e.bucId !== null && owned.has(e.bucId));
}

/**
 * 要素を消したとき、巻き込まれる子 (removeElement の実際の振る舞いのとおり)。
 * - 登場人物: 主担当の業務と担当の作業は消えず、結び付きが外れる (主担当が他にいない業務は「担当が決まっていない業務」へ移る)
 * - 業務: 活動は一緒に消える。属していた作業は消えず、どの業務にも属さない作業になる
 * - 活動: 作業は消えず、業務に直接属する作業に戻る
 * - 作業: 結んだ操作は消えず、結び付きが外れる
 * 子が無ければ空
 */
export function removalImpact(model: UntieModel, elementId: string): ImpactItem[] {
  const el = find(model, elementId);
  if (!el) return [];
  const items: ImpactItem[] = [];
  const push = (item: ImpactItem) => {
    if (item.count > 0) items.push(item);
  };
  switch (el.kind) {
    case "actor":
    case "externalActor": {
      const owned = model.relations.filter((r) => r.kind === "actorBusiness" && r.sourceId === el.id).map((r) => r.targetId);
      const alone = owned.filter((bid) => model.relations.every((r) => r.kind !== "actorBusiness" || r.targetId !== bid || r.sourceId === el.id)).length;
      push({
        label: "業務",
        count: owned.length,
        effect: "kept",
        note: alone > 0 ? `主担当が外れます (ほかに主担当がいない ${alone} 件は「担当が決まっていない業務」に移ります)` : "主担当が外れます",
      });
      push({ label: "作業", count: model.relations.filter((r) => r.kind === "actorActivity" && r.sourceId === el.id).length, effect: "kept", note: "担当が外れます" });
      break;
    }
    case "business": {
      push({ label: "活動", count: model.elements.filter((e) => e.kind === "buc" && e.businessId === el.id && !e.isDefault).length, effect: "removed" });
      push({ label: "作業", count: activitiesOfBusiness(model, el.id).length, effect: "kept", note: "業務に属さない作業になります" });
      break;
    }
    case "buc": {
      if (el.isDefault) break;
      // ほかの活動が残る業務では、戻った作業が業務直下と活動の混在になり、ボードが警告を出す
      const otherBucs = model.elements.some((e) => e.kind === "buc" && e.businessId === el.businessId && !e.isDefault && e.id !== el.id);
      push({
        label: "作業",
        count: model.elements.filter((e) => e.kind === "activity" && e.bucId === el.id).length,
        effect: "kept",
        note: otherBucs ? "業務に直接属する作業に戻ります (この業務にはほかの活動があるので、どれかの活動へ移してください)" : "業務に直接属する作業に戻ります",
      });
      break;
    }
    case "activity": {
      push({ label: "操作", count: model.relations.filter((r) => r.kind === "activityUsecase" && r.sourceId === el.id).length, effect: "kept", note: "作業との結び付きが外れます" });
      break;
    }
    default:
      break;
  }
  return items;
}

/** 関係を外したとき、巻き込まれる子。業務の主担当を外すときだけ (その業務の活動と作業はそのまま業務に残る) */
export function relationRemovalImpact(model: UntieModel, relationId: string): ImpactItem[] {
  const rel = model.relations.find((r) => r.id === relationId);
  if (!rel || rel.kind !== "actorBusiness") return [];
  const others = model.relations.some((r) => r.kind === "actorBusiness" && r.targetId === rel.targetId && r.id !== rel.id);
  const note = others ? "業務ごと残ります (ほかの主担当の行には、これまでどおり出ます)" : "業務ごと残り、「担当が決まっていない業務」に移ります";
  const items: ImpactItem[] = [];
  const bucs = model.elements.filter((e) => e.kind === "buc" && e.businessId === rel.targetId && !e.isDefault).length;
  const acts = activitiesOfBusiness(model, rel.targetId).length;
  if (bucs > 0) items.push({ label: "活動", count: bucs, effect: "kept", note });
  if (acts > 0) items.push({ label: "作業", count: acts, effect: "kept", note });
  return items;
}

/** 子の数え上げを、確認ダイアログに出す 1 行ずつの文にする */
export function impactLines(items: readonly ImpactItem[]): string[] {
  return items.map((i) => {
    const head = `${i.label} ${i.count} 件`;
    if (i.effect === "removed") return `${head}: 一緒に削除されます`;
    return `${head}: 削除されず残ります${i.note ? ` (${i.note})` : ""}`;
  });
}

// ---------------------------------------------------------------- 足す

/** ワークフローボードで足せるもの */
export type WorkflowAddKind = "actor" | "business" | "buc" | "activity";

/** 業務の枠に作業を直接足せるか。活動のある業務は、作業を活動の枠に入れる (固定ボードと同じ決まり) */
export function canAddActivityToBusiness(model: UntieModel, businessId: string): boolean {
  return !model.elements.some((e) => e.kind === "buc" && e.businessId === businessId && !e.isDefault);
}

/**
 * ワークフローボードで足す。足したものは、枠の持ち主に結ぶ (固定ボードの「枠に足す」と同じ。作成と結び付けで 1 件の履歴)。
 * - actor: 親なし
 * - business: 親は登場人物 (主担当として結ぶ)
 * - buc (活動): 親は業務。業務に初めて活動を足すと、業務に直接あった作業はその活動へ移る
 * - activity (作業): 親は業務 (活動の無い業務だけ) か活動
 */
export function addWorkflowElement(model: UntieModel, kind: WorkflowAddKind, parentId?: string): CommandResult<{ id: string }> {
  if (kind === "actor") return addElement(model, { kind: "actor", name: "新しい登場人物" });
  const parent = parentId === undefined ? undefined : find(model, parentId);
  if (!parent) return { ok: false, reason: "足し先が見つかりません" };
  const group = (link: FixedGroup["link"], childKind: FixedGroup["childKind"]): FixedGroup => ({ key: parent.id, title: parent.name, parentId: parent.id, childKind, link, items: [] });
  if (kind === "business") {
    if (parent.kind !== "actor") return { ok: false, reason: "業務の主担当にできるのは登場人物 (外部の登場人物は不可) だけです" };
    return addToGroup(model, group({ type: "relation", parentId: parent.id }, "business"), "新しい業務");
  }
  if (kind === "buc") {
    if (parent.kind !== "business") return { ok: false, reason: "活動は業務の中に足します" };
    return addToGroup(model, group({ type: "business", businessId: parent.id }, "buc"), "新しい活動");
  }
  if (parent.kind === "buc") return addToGroup(model, group({ type: "buc", bucId: parent.id }, "activity"), "新しい作業");
  if (parent.kind !== "business") return { ok: false, reason: "作業は業務か活動の中に足します" };
  if (!canAddActivityToBusiness(model, parent.id)) return { ok: false, reason: "この業務には活動があります。作業は活動の中に足してください" };
  const def = defaultBucOf(model, parent.id);
  if (!def) return { ok: false, reason: "業務の既定の活動が見つかりません" };
  return addToGroup(model, group({ type: "buc", bucId: def.id }, "activity"), "新しい作業");
}
