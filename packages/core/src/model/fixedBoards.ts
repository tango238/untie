// 固定ボード: レイヤーごとに、上位の要素を枠にして下位の要素を自動で並べるビュー。
// モデルには保存せず、毎回モデルから組み立てる。純粋関数だけを置く。
import { addElement, addRelation, moveActivity, moveToContext, removeRelation, type CommandResult } from "./commands";
import { relationKindFor } from "./relations";
import { defaultBucOf } from "./selectors";
import {
  ELEMENT_KIND_LABELS,
  type Activity,
  type Element,
  type ElementKind,
  type State,
  type UntieModel,
} from "./types";

/** 固定ボードのレイヤー (上位から順) */
export const FIXED_LAYERS = [
  "actor",
  "business",
  "buc",
  "activity",
  "usecase",
  "screen",
  "context",
  "information",
  "condition",
  "state",
  "variation",
  "nfr",
] as const;
export type FixedLayer = (typeof FIXED_LAYERS)[number];

/**
 * ボードの選択肢に並べる順。コンテキストは情報・条件・状態・バリエーションをまとめて見る場所なので、それらの後に置く。非機能要件は最後。
 * レイヤーの上下 (トレース・グローバルフィルター) は FIXED_LAYERS の順のまま
 */
export const FIXED_BOARD_MENU_ORDER: readonly FixedLayer[] = [
  ...FIXED_LAYERS.filter((l) => l !== "context" && l !== "nfr"),
  "context",
  // 非機能要件は業務の流れの外 (システムに求める品質) なので最後に置く
  "nfr",
];

export const FIXED_LAYER_LABELS: Record<FixedLayer, string> = {
  actor: "登場人物",
  business: "業務",
  buc: "活動",
  activity: "作業",
  usecase: "操作",
  screen: "画面",
  context: "コンテキスト",
  information: "情報",
  condition: "条件",
  state: "状態",
  variation: "バリエーション",
  nfr: "非機能要件",
};

/** 要素の種類を作成・編集する固定ボード (課題は固定ボードに出ない) */
export function fixedLayerOf(kind: ElementKind): FixedLayer | null {
  switch (kind) {
    case "externalActor":
    case "system":
    case "ledger":
      return "actor";
    case "issue":
      return null;
    // イベントは操作のボードで、操作と並べて扱う
    case "event":
      return "usecase";
    default:
      return kind;
  }
}

const PREFIX = "fixed:";

export function fixedBoardId(layer: FixedLayer): string {
  return `${PREFIX}${layer}`;
}

/** 固定ボードの id ならレイヤーを返す。自由ボード (モデルのボード) なら null */
export function parseFixedBoardId(boardId: string): FixedLayer | null {
  if (!boardId.startsWith(PREFIX)) return null;
  const layer = boardId.slice(PREFIX.length);
  return (FIXED_LAYERS as readonly string[]).includes(layer) ? (layer as FixedLayer) : null;
}

/** 枠に新しく足した要素を、上位とどう結びつけるか */
export type GroupLink =
  | { type: "none" }
  /** 上位 → 下位の関係 (枠から外す・既存の要素を足すことができる) */
  | { type: "relation"; parentId: string }
  /** BUC の所属業務 */
  | { type: "business"; businessId: string }
  /** アクティビティの所属 BUC (null は未所属) */
  | { type: "buc"; bucId: string | null }
  /** 情報の所属コンテキスト (null は未分類) */
  | { type: "context"; contextId: string | null }
  /** 状態の状態グループ (undefined はグループなし) */
  | { type: "stateGroup"; group: string | undefined }
  /** コンテキストに属する情報・条件・状態・バリエーション (null は未分類)。既存の要素を移したり、未分類へ外したりできる */
  | { type: "contextMembers"; contextId: string | null }
  /** 画面・非機能要件の属するシステム */
  | { type: "system"; systemId: string };

/** コンテキストのボードで、コンテキストの枠に並べる種類 (この順に並べる) */
export const CONTEXT_MEMBER_KINDS = ["information", "condition", "state", "variation", "event"] as const satisfies readonly ElementKind[];

/** 枠をまとめる段落 (ユースケースのボードの BUC など)。見出しと区切りで分けて出す */
export interface FixedSection {
  key: string;
  title: string;
  subtitle?: string;
  /** 見出しの元になった要素。クリックで選べる */
  parentId: string | null;
  /** 直すべき状態の知らせ (活動のある業務に、業務直下の作業が残っているなど) */
  warning?: string;
  /** この枠には新しく作れない */
  noAdd?: boolean;
}

export interface FixedGroup {
  key: string;
  title: string;
  /** 見出しの補足 (上位の種類や、さらに上の所属) */
  subtitle?: string;
  /** 見出しの元になった上位の要素。クリックで選べる */
  parentId: string | null;
  /** 新しく作る要素の種類 */
  childKind: ElementKind;
  /** 枠で作れる種類が複数あるとき (コンテキストの枠)。無ければ childKind だけ */
  addKinds?: readonly ElementKind[];
  link: GroupLink;
  items: Element[];
  /**
   * 並びに出すだけで、この枠から外せない要素 (操作のボードの作業の枠に並べるイベント)。
   * 枠の上位と直接の関係が無いので、外すときは要素のプロパティ欄で関係を消す
   */
  fixedItemIds?: string[];
  /**
   * 1 つ前の要素とつながっている (前の操作の「次に」・発生・きっかけ) 要素。画面ではこの要素の前にだけ矢印を出す。
   * 無ければ (操作だけを並べる枠など) 矢印は出さない
   */
  chainedIds?: string[];
  /** 属する段落。無ければ段落に分けない */
  section?: FixedSection;
  /** 直すべき状態の知らせ */
  warning?: string;
  /** この枠には新しく作れない (既存の要素を見せるだけ) */
  noAdd?: boolean;
}

const byKind = <K extends ElementKind>(model: UntieModel, kind: K) =>
  model.elements.filter((e): e is Extract<Element, { kind: K }> => e.kind === kind);

/** 上位の各要素 → 関係でつながる下位の要素、という枠。どこにもつながらない下位は orphanTitle の枠に入れる */
function relationGroups(
  model: UntieModel,
  parentKind: ElementKind,
  childKind: ElementKind,
  orphanTitle: string,
  subtitleOf: (parent: Element) => string | undefined = () => ELEMENT_KIND_LABELS[parentKind],
): FixedGroup[] {
  const children = byKind(model, childKind);
  const linked = new Set<string>();
  const groups: FixedGroup[] = byKind(model, parentKind).map((parent) => {
    const ids = new Set(model.relations.filter((r) => r.sourceId === parent.id).map((r) => r.targetId));
    const items = children.filter((c) => ids.has(c.id));
    for (const c of items) linked.add(c.id);
    const subtitle = subtitleOf(parent);
    return {
      key: parent.id,
      title: parent.name || "(名前なし)",
      ...(subtitle ? { subtitle } : {}),
      parentId: parent.id,
      childKind,
      link: { type: "relation", parentId: parent.id },
      items,
    };
  });
  const orphans = children.filter((c) => !linked.has(c.id));
  if (orphans.length > 0 || groups.length === 0) {
    groups.push({ key: "__none", title: orphanTitle, parentId: null, childKind, link: { type: "none" }, items: orphans });
  }
  return groups;
}

/**
 * アクティビティの所属先 (BUC) を、業務ごとに「業務に直接 (既定 BUC) → その業務の BUC」の順に並べる。
 * 既定 BUC は業務の名前で出す。
 */
/**
 * 業務の作業は「業務に直接」か「活動に入れる」のどちらかだけにする。
 * 活動の無い業務は業務の枠 (活動なし) を出し、活動のある業務は活動の枠だけを出す。
 * 活動のある業務に業務直下の作業が残っているとき (古いファイルや AI の作成) は、業務の枠を知らせ付きで残し、新しくは作らせない
 */
function bucSections(model: UntieModel): FixedSection[] {
  const sections: FixedSection[] = [];
  const activities = byKind(model, "activity");
  for (const biz of byKind(model, "business")) {
    const def = defaultBucOf(model, biz.id);
    const bucs = byKind(model, "buc").filter((b) => b.businessId === biz.id && !b.isDefault);
    const direct = def ? activities.filter((a) => a.bucId === def.id) : [];
    if (def && bucs.length === 0) sections.push({ key: def.id, title: biz.name || "(名前なし)", subtitle: "業務 (活動なし)", parentId: biz.id });
    else if (def && direct.length > 0) {
      sections.push({
        key: def.id,
        title: biz.name || "(名前なし)",
        subtitle: "業務 (活動に属さない作業)",
        parentId: biz.id,
        warning: "この業務には活動があります。作業をどれかの活動に移してください (プロパティ欄の「活動」)。",
        noAdd: true,
      });
    }
    for (const buc of bucs) {
      sections.push({ key: buc.id, title: buc.name || "(名前なし)", subtitle: `活動 (業務: ${biz.name})`, parentId: buc.id });
    }
  }
  return sections;
}

/** 登場人物のボードで、役割がわかりにくい枠に添える補足 */
const LEDGER_SUBTITLES: Partial<Record<ElementKind, string>> = {
  system: "社外のものも含む",
  ledger: "紙の台帳・伝票",
};

/** 固定ボードの枠を組み立てる */
export function fixedGroups(model: UntieModel, layer: FixedLayer): FixedGroup[] {
  switch (layer) {
    case "actor":
      return (["actor", "externalActor", "system", "ledger"] as const).map((kind) => ({
        key: kind,
        title: ELEMENT_KIND_LABELS[kind],
        ...(LEDGER_SUBTITLES[kind] ? { subtitle: LEDGER_SUBTITLES[kind] } : {}),
        parentId: null,
        childKind: kind,
        link: { type: "none" },
        items: byKind(model, kind),
      }));

    case "business":
      // 外部アクターは業務の主担当になれないので、アクターだけを枠にする
      return relationGroups(model, "actor", "business", "主担当なし");

    case "buc": {
      const bucs = byKind(model, "buc").filter((b) => !b.isDefault);
      return byKind(model, "business").map((biz) => ({
        key: biz.id,
        title: biz.name || "(名前なし)",
        subtitle: "業務",
        parentId: biz.id,
        childKind: "buc" as const,
        link: { type: "business", businessId: biz.id },
        items: bucs.filter((b) => b.businessId === biz.id),
      }));
    }

    case "activity": {
      const activities = byKind(model, "activity");
      const groups: FixedGroup[] = bucSections(model).map((sec) => ({
        key: sec.key,
        title: sec.title,
        ...(sec.subtitle ? { subtitle: sec.subtitle } : {}),
        ...(sec.warning ? { warning: sec.warning } : {}),
        ...(sec.noAdd ? { noAdd: true } : {}),
        parentId: sec.parentId,
        childKind: "activity" as const,
        link: { type: "buc", bucId: sec.key },
        items: activities.filter((a) => a.bucId === sec.key),
      }));
      const orphans = activities.filter((a: Activity) => !a.bucId);
      if (orphans.length > 0 || groups.length === 0) {
        groups.push({ key: "__none", title: "未所属", parentId: null, childKind: "activity", link: { type: "buc", bucId: null }, items: orphans });
      }
      return groups;
    }

    case "usecase":
      return usecaseGroups(model);

    case "screen":
      return systemMemberGroups(model, "screen");

    case "nfr":
      return systemMemberGroups(model, "nfr");

    case "context": {
      // コンテキストごとに、属する情報・条件・状態・バリエーションを種類の順に並べる
      const order = (e: Element) => (CONTEXT_MEMBER_KINDS as readonly string[]).indexOf(e.kind);
      const members = model.elements
        .filter((e) => order(e) >= 0)
        .map((e, i) => ({ e, i }))
        .sort((a, b) => order(a.e) - order(b.e) || a.i - b.i)
        .map((x) => x.e);
      const contextOf = (e: Element) => ("contextId" in e ? e.contextId : null);
      const group = (key: string, title: string, parentId: string | null, contextId: string | null): FixedGroup => ({
        key,
        title,
        ...(parentId ? { subtitle: "コンテキスト" } : {}),
        parentId,
        childKind: "information",
        addKinds: CONTEXT_MEMBER_KINDS,
        link: { type: "contextMembers", contextId },
        items: members.filter((e) => contextOf(e) === contextId),
      });
      const groups = byKind(model, "context").map((ctx) => group(ctx.id, ctx.name || "(名前なし)", ctx.id, ctx.id));
      const orphans = group("__none", "未分類", null, null);
      if (orphans.items.length > 0) groups.push(orphans);
      return groups;
    }

    case "information": {
      const infos = byKind(model, "information");
      const groups: FixedGroup[] = byKind(model, "context").map((ctx) => ({
        key: ctx.id,
        title: ctx.name || "(名前なし)",
        subtitle: "コンテキスト",
        parentId: ctx.id,
        childKind: "information" as const,
        link: { type: "context", contextId: ctx.id },
        items: infos.filter((i) => i.contextId === ctx.id),
      }));
      const orphans = infos.filter((i) => i.contextId === null);
      if (orphans.length > 0 || groups.length === 0) {
        groups.push({ key: "__none", title: "未分類", parentId: null, childKind: "information", link: { type: "context", contextId: null }, items: orphans });
      }
      return groups;
    }

    case "condition":
      return relationGroups(model, "usecase", "condition", "操作なし");

    case "state": {
      const states = byKind(model, "state");
      const names = [...new Set(states.map((s: State) => s.group).filter((g): g is string => !!g))];
      const groups: FixedGroup[] = names.map((g) => ({
        key: `group:${g}`,
        title: g,
        subtitle: "状態グループ",
        parentId: null,
        childKind: "state",
        link: { type: "stateGroup", group: g },
        items: states.filter((s) => s.group === g),
      }));
      // グループなしの枠は、新しいグループを始める場所として常に出す
      groups.push({
        key: "__none",
        title: "グループなし",
        parentId: null,
        childKind: "state",
        link: { type: "stateGroup", group: undefined },
        items: states.filter((s) => !s.group),
      });
      return groups;
    }

    case "variation":
      return relationGroups(model, "information", "variation", "情報なし");
  }
}

/**
 * 操作のボード: 活動の段落に分けて作業ごとの枠に、操作とイベントを連鎖の順 (きっかけのイベント → 操作 (「次に」の順) → 発生するイベント) に並べる。
 * 作業に属さない自動の処理は「作業なし (イベントから)」の枠に、どの作業にも使われずきっかけも無い操作は「作業なし」の枠に入れる。
 * 最後に、すべてのイベントを並べる「イベント」の枠を置く (イベントを作る・見つける場所)
 */
function usecaseGroups(model: UntieModel): FixedGroup[] {
  const usecases = byKind(model, "usecase");
  const events = byKind(model, "event");
  const byId = new Map(model.elements.map((e) => [e.id, e]));
  const order = new Map(model.elements.map((e, i) => [e.id, i]));
  const nextOf = new Map<string, string[]>();
  const triggersOf = new Map<string, string[]>();
  const emitsOf = new Map<string, string[]>();
  const usecasesOf = new Map<string, Set<string>>();
  for (const r of model.relations) {
    if (r.kind === "usecaseNext") nextOf.set(r.sourceId, [...(nextOf.get(r.sourceId) ?? []), r.targetId]);
    if (r.kind === "eventUsecase") triggersOf.set(r.targetId, [...(triggersOf.get(r.targetId) ?? []), r.sourceId]);
    if (r.kind === "usecaseEvent") emitsOf.set(r.sourceId, [...(emitsOf.get(r.sourceId) ?? []), r.targetId]);
    if (r.kind === "activityUsecase") usecasesOf.set(r.sourceId, (usecasesOf.get(r.sourceId) ?? new Set()).add(r.targetId));
  }

  /** 操作を「次に」の順に並べ、それぞれの前にきっかけのイベント、後ろに発生するイベントを挟む */
  const linked = (from: Element, to: Element): boolean => {
    if (from.kind === "usecase" && to.kind === "usecase") return (nextOf.get(from.id) ?? []).includes(to.id);
    if (from.kind === "usecase" && to.kind === "event") return (emitsOf.get(from.id) ?? []).includes(to.id);
    if (from.kind === "event" && to.kind === "usecase") return (triggersOf.get(to.id) ?? []).includes(from.id);
    return false;
  };
  const sequence = (ids: Set<string>): { items: Element[]; fixedItemIds: string[]; chainedIds: string[] } => {
    const members = usecases.filter((u) => ids.has(u.id)).map((u) => u.id);
    const internalNext = (id: string) => (nextOf.get(id) ?? []).filter((n) => ids.has(n) && n !== id).sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
    const hasPrev = new Set(members.flatMap(internalNext));
    const ordered: string[] = [];
    const visit = (id: string) => {
      if (ordered.includes(id)) return;
      ordered.push(id);
      for (const n of internalNext(id)) visit(n);
    };
    for (const id of members) if (!hasPrev.has(id)) visit(id);
    for (const id of members) visit(id); // 輪だけの並び
    const items: Element[] = [];
    const fixed: string[] = [];
    const push = (id: string, isFixed: boolean) => {
      const e = byId.get(id);
      if (!e || items.includes(e)) return;
      items.push(e);
      if (isFixed) fixed.push(id);
    };
    for (const id of ordered) {
      for (const ev of triggersOf.get(id) ?? []) push(ev, true);
      push(id, false);
      for (const ev of emitsOf.get(id) ?? []) push(ev, true);
    }
    // 1 つ前の要素とつながっているものだけに矢印を出す (枝分かれ・つながっていない操作の間には出さない)
    const chainedIds = items.filter((e, i) => i > 0 && linked(items[i - 1]!, e)).map((e) => e.id);
    return { items, fixedItemIds: fixed, chainedIds };
  };

  const inActivity = new Set([...usecasesOf.values()].flatMap((s) => [...s]));
  const groups: FixedGroup[] = byKind(model, "activity").map((act) => {
    const { items, fixedItemIds, chainedIds } = sequence(usecasesOf.get(act.id) ?? new Set());
    return {
      key: act.id,
      title: act.name || "(名前なし)",
      subtitle: "作業",
      parentId: act.id,
      childKind: "usecase" as const,
      link: { type: "relation" as const, parentId: act.id },
      items,
      ...(fixedItemIds.length > 0 ? { fixedItemIds } : {}),
      ...(chainedIds.length > 0 ? { chainedIds } : {}),
    };
  });

  // 作業に属さない自動の処理: きっかけのある操作から、作業に属さない操作を「次に」でたどる
  const auto = new Set<string>();
  const queue = usecases.filter((u) => !inActivity.has(u.id) && (triggersOf.get(u.id) ?? []).length > 0).map((u) => u.id);
  for (const id of queue) auto.add(id);
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const n of nextOf.get(id) ?? []) {
      if (auto.has(n) || inActivity.has(n) || byId.get(n)?.kind !== "usecase") continue;
      auto.add(n);
      queue.push(n);
    }
  }
  const noneSection: FixedSection = { key: "__none", title: "作業なし", subtitle: "どの作業にも使われていない操作", parentId: null };
  if (auto.size > 0) {
    const { items, fixedItemIds, chainedIds } = sequence(auto);
    groups.push({
      key: "__auto",
      title: "作業なし (イベントから)",
      subtitle: "イベントをきっかけに動く処理",
      parentId: null,
      childKind: "usecase",
      link: { type: "none" },
      items,
      ...(fixedItemIds.length > 0 ? { fixedItemIds } : {}),
      ...(chainedIds.length > 0 ? { chainedIds } : {}),
      section: noneSection,
    });
  }
  const orphans = usecases.filter((u) => !inActivity.has(u.id) && !auto.has(u.id));
  if (orphans.length > 0 || groups.length === 0) {
    groups.push({ key: "__none", title: "作業なし", parentId: null, childKind: "usecase", link: { type: "none" }, items: orphans });
  }

  // 作業の枠を、所属する BUC の段落に分けて BUC の順に並べる。中身の無い BUC は出さない
  const bucOf = new Map(byKind(model, "activity").map((a) => [a.id, a.bucId]));
  const sections: FixedSection[] = [
    ...bucSections(model),
    { key: "__unassigned", title: "未所属", subtitle: "活動に属さない作業", parentId: null },
    noneSection,
  ];
  const sectionKeyOf = (g: FixedGroup) => {
    if (g.parentId === null) return "__none";
    const bucId = bucOf.get(g.parentId);
    return bucId && sections.some((x) => x.key === bucId) ? bucId : "__unassigned";
  };
  const sectioned = sections.flatMap((section) => groups.filter((g) => sectionKeyOf(g) === section.key).map((g) => ({ ...g, section })));
  const eventSection: FixedSection = { key: "__events", title: "イベント", subtitle: "操作やシステムが発生させる出来事 (人の動きは含めない)", parentId: null };
  sectioned.push({
    key: "__events",
    title: "すべてのイベント",
    subtitle: "イベント",
    parentId: null,
    childKind: "event",
    link: { type: "none" },
    items: events,
    section: eventSection,
  });
  return sectioned;
}

/** 画面・非機能要件のボード: システムごとの枠に並べる (帳票は持たない) */
function systemMemberGroups(model: UntieModel, kind: "screen" | "nfr"): FixedGroup[] {
  const members = byKind(model, kind);
  return byKind(model, "system").map((sys) => ({
    key: sys.id,
    title: sys.name || "(名前なし)",
    subtitle: "システム",
    parentId: sys.id,
    childKind: kind,
    link: { type: "system" as const, systemId: sys.id },
    items: members.filter((m) => m.systemId === sys.id),
  }));
}

/** 上位が無くて枠を作れないときの案内 (業務が無い BUC のボードなど) */
export function emptyLayerHint(layer: FixedLayer): string | null {
  if (layer === "buc") return "業務がありません。先に「業務」の固定ボードで業務を作ってください。";
  if (layer === "screen" || layer === "nfr") return "システムがありません。先に「登場人物」の固定ボードでシステムを作ってください。";
  if (layer === "context") return "コンテキストがありません。「＋コンテキスト」で作ってください。";
  return null;
}

/**
 * 名前で絞り込む。見出し (または段落の見出し) が一致した枠は中身をすべて出し、それ以外は一致した要素だけを出す。
 * 何も一致しない枠は出さない。
 */
export function filterGroups(groups: FixedGroup[], query: string): FixedGroup[] {
  const q = query.trim().toLowerCase();
  if (!q) return groups;
  const hit = (s: string | undefined) => !!s && s.toLowerCase().includes(q);
  const result: FixedGroup[] = [];
  for (const g of groups) {
    if (hit(g.title) || hit(g.section?.title)) {
      result.push(g);
      continue;
    }
    const items = g.items.filter((e) => hit(e.name));
    if (items.length > 0) result.push({ ...g, items });
  }
  return result;
}

/**
 * グローバルフィルターに合う要素だけを残す (scope が null なら何もしない)。
 * 見出しの要素が合う枠は、中身が無くても残す (そこへ足せるように)。それ以外の枠は中身が無ければ出さない
 */
export function scopeGroups(groups: FixedGroup[], scope: Set<string> | null): FixedGroup[] {
  if (!scope) return groups;
  const result: FixedGroup[] = [];
  for (const g of groups) {
    const items = g.items.filter((e) => scope.has(e.id));
    if (items.length > 0 || (g.parentId !== null && scope.has(g.parentId))) result.push({ ...g, items });
  }
  return result;
}

/** 枠に新しい要素を作って結びつける (作成と結びつけで 1 件の履歴) */
export function addToGroup(model: UntieModel, group: FixedGroup, name?: string, kind: ElementKind = group.childKind): CommandResult<{ id: string }> {
  if (group.noAdd) return { ok: false, reason: group.warning ?? "この枠には作れません" };
  if (kind !== group.childKind && !group.addKinds?.includes(kind)) return { ok: false, reason: `この枠には${ELEMENT_KIND_LABELS[kind]}を作れません` };
  const label = name ?? `新しい${ELEMENT_KIND_LABELS[kind]}`;
  const link = group.link;
  const init =
    link.type === "business"
      ? { businessId: link.businessId }
      : link.type === "buc"
        ? { bucId: link.bucId }
        : link.type === "context" || link.type === "contextMembers"
          ? { contextId: link.contextId }
          : link.type === "stateGroup" && link.group
            ? { group: link.group }
            : link.type === "system"
              ? { systemId: link.systemId }
              : undefined;
  const created = addElement(model, { kind, name: label, ...(init ? { init } : {}) });
  if (created.ok && link.type === "business") return moveDirectActivitiesIntoFirstBuc(model, created, link.businessId);
  if (!created.ok || link.type !== "relation") return created;
  const linked = addRelation(created.model, { sourceId: link.parentId, targetId: created.id });
  return linked.ok ? { ok: true, model: linked.model, id: created.id } : linked;
}

/**
 * 業務に初めて活動を作ったら、業務に直接あった作業をその活動へ移す (業務直下と活動を混ぜないため)。
 * 作成と移動で 1 件の履歴
 */
function moveDirectActivitiesIntoFirstBuc(before: UntieModel, created: CommandResult<{ id: string }> & { ok: true }, businessId: string): CommandResult<{ id: string }> {
  const hadBuc = byKind(before, "buc").some((b) => b.businessId === businessId && !b.isDefault);
  const def = defaultBucOf(before, businessId);
  if (hadBuc || !def) return created;
  let model = created.model;
  for (const a of byKind(model, "activity").filter((x) => x.bucId === def.id)) {
    const r = moveActivity(model, { activityId: a.id, bucId: created.id });
    if (!r.ok) return r;
    model = r.model;
  }
  return { ok: true, model, id: created.id };
}

/** 枠に既存の要素を足せるときの候補 (関係で結ぶ枠と、コンテキストの枠)。すでに入っているものは除く */
export function linkCandidates(model: UntieModel, group: FixedGroup): Element[] {
  if (group.link.type === "contextMembers") {
    // 別のコンテキスト (または未分類) にある要素を、このコンテキストへ移せる
    const contextId = group.link.contextId;
    if (contextId === null) return [];
    return CONTEXT_MEMBER_KINDS.flatMap((k) => byKind(model, k).filter((e) => e.contextId !== contextId));
  }
  if (group.link.type !== "relation") return [];
  const inGroup = new Set(group.items.map((e) => e.id));
  const parent = model.elements.find((e) => e.id === (group.link as { parentId: string }).parentId);
  if (!parent) return [];
  return model.elements.filter((e) => e.kind === group.childKind && !inGroup.has(e.id) && relationKindFor(parent.kind, e.kind));
}

/** 既存の要素を枠に足す (上位 → 要素の関係を作る) */
export function linkToGroup(model: UntieModel, group: FixedGroup, elementId: string): CommandResult {
  if (group.link.type === "contextMembers") {
    if (group.link.contextId === null) return { ok: false, reason: "未分類へは「×」で外してください" };
    return moveToContext(model, { elementId, contextId: group.link.contextId });
  }
  if (group.link.type !== "relation") return { ok: false, reason: "この枠には既存の要素を足せません" };
  return addRelation(model, { sourceId: group.link.parentId, targetId: elementId });
}

/** 要素を枠から外す (上位 → 要素の関係を消す。要素は残る) */
export function unlinkFromGroup(model: UntieModel, group: FixedGroup, elementId: string): CommandResult {
  // コンテキストの枠から外すと未分類になる (状態は状態グループごと)
  if (group.link.type === "contextMembers") {
    if (group.link.contextId === null) return { ok: false, reason: "未分類からは外せません" };
    return moveToContext(model, { elementId, contextId: null });
  }
  if (group.link.type !== "relation") return { ok: false, reason: "この枠からは外せません" };
  if (group.fixedItemIds?.includes(elementId)) return { ok: false, reason: "イベントは作業の並びに出しているだけです。外すときは操作との関係を消してください" };
  const parentId = group.link.parentId;
  const rel = model.relations.find((r) => r.sourceId === parentId && r.targetId === elementId);
  if (!rel) return { ok: false, reason: "関係が見つかりません" };
  return removeRelation(model, { id: rel.id });
}
