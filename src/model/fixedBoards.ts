// 固定ボード: レイヤーごとに、上位の要素を枠にして下位の要素を自動で並べるビュー。
// モデルには保存せず、毎回モデルから組み立てる。純粋関数だけを置く。
import { addElement, addRelation, removeRelation, type CommandResult } from "./commands";
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
  "context",
  "information",
  "condition",
  "state",
  "variation",
] as const;
export type FixedLayer = (typeof FIXED_LAYERS)[number];

export const FIXED_LAYER_LABELS: Record<FixedLayer, string> = {
  actor: "登場人物",
  business: "業務",
  buc: "活動",
  activity: "作業",
  usecase: "操作",
  context: "コンテキスト",
  information: "情報",
  condition: "条件",
  state: "状態",
  variation: "バリエーション",
};

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
  | { type: "stateGroup"; group: string | undefined };

/** 枠をまとめる段落 (ユースケースのボードの BUC など)。見出しと区切りで分けて出す */
export interface FixedSection {
  key: string;
  title: string;
  subtitle?: string;
  /** 見出しの元になった要素。クリックで選べる */
  parentId: string | null;
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
  link: GroupLink;
  items: Element[];
  /** 属する段落。無ければ段落に分けない */
  section?: FixedSection;
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
function bucSections(model: UntieModel): FixedSection[] {
  const sections: FixedSection[] = [];
  for (const biz of byKind(model, "business")) {
    const def = defaultBucOf(model, biz.id);
    if (def) sections.push({ key: def.id, title: biz.name || "(名前なし)", subtitle: "業務 (活動なし)", parentId: biz.id });
    for (const buc of byKind(model, "buc").filter((b) => b.businessId === biz.id && !b.isDefault)) {
      sections.push({ key: buc.id, title: buc.name || "(名前なし)", subtitle: `活動 (業務: ${biz.name})`, parentId: buc.id });
    }
  }
  return sections;
}

/** 固定ボードの枠を組み立てる */
export function fixedGroups(model: UntieModel, layer: FixedLayer): FixedGroup[] {
  switch (layer) {
    case "actor":
      return (["actor", "externalActor", "system"] as const).map((kind) => ({
        key: kind,
        title: ELEMENT_KIND_LABELS[kind],
        ...(kind === "system" ? { subtitle: "帳簿・伝票などの紙媒体も含む" } : {}),
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

    case "usecase": {
      // アクティビティの枠を、所属する BUC の段落に分けて BUC の順に並べる。中身の無い BUC は出さない
      const groups = relationGroups(model, "activity", "usecase", "作業なし", () => "作業");
      const bucOf = new Map(byKind(model, "activity").map((a) => [a.id, a.bucId]));
      const sections: FixedSection[] = [
        ...bucSections(model),
        { key: "__unassigned", title: "未所属", subtitle: "活動に属さない作業", parentId: null },
        { key: "__none", title: "作業なし", subtitle: "どの作業にも使われていない操作", parentId: null },
      ];
      const sectionKeyOf = (g: FixedGroup) => {
        if (g.parentId === null) return "__none";
        const bucId = bucOf.get(g.parentId);
        return bucId && sections.some((x) => x.key === bucId) ? bucId : "__unassigned";
      };
      return sections.flatMap((section) =>
        groups.filter((g) => sectionKeyOf(g) === section.key).map((g) => ({ ...g, section })),
      );
    }

    case "context":
      return [
        {
          key: "context",
          title: ELEMENT_KIND_LABELS.context,
          subtitle: "情報をまとめる親カテゴリ",
          parentId: null,
          childKind: "context",
          link: { type: "none" },
          items: byKind(model, "context"),
        },
      ];

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

/** 上位が無くて枠を作れないときの案内 (業務が無い BUC のボードなど) */
export function emptyLayerHint(layer: FixedLayer): string | null {
  return layer === "buc" ? "業務がありません。先に「業務」の固定ボードで業務を作ってください。" : null;
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

/** 枠に新しい要素を作って結びつける (作成と結びつけで 1 件の履歴) */
export function addToGroup(model: UntieModel, group: FixedGroup, name?: string): CommandResult<{ id: string }> {
  const kind = group.childKind;
  const label = name ?? `新しい${ELEMENT_KIND_LABELS[kind]}`;
  const link = group.link;
  const init =
    link.type === "business"
      ? { businessId: link.businessId }
      : link.type === "buc"
        ? { bucId: link.bucId }
        : link.type === "context"
          ? { contextId: link.contextId }
          : link.type === "stateGroup" && link.group
            ? { group: link.group }
            : undefined;
  const created = addElement(model, { kind, name: label, ...(init ? { init } : {}) });
  if (!created.ok || link.type !== "relation") return created;
  const linked = addRelation(created.model, { sourceId: link.parentId, targetId: created.id });
  return linked.ok ? { ok: true, model: linked.model, id: created.id } : linked;
}

/** 枠に既存の要素を足せるときの候補 (関係で結ぶ枠だけ)。すでに入っているものは除く */
export function linkCandidates(model: UntieModel, group: FixedGroup): Element[] {
  if (group.link.type !== "relation") return [];
  const inGroup = new Set(group.items.map((e) => e.id));
  const parent = model.elements.find((e) => e.id === (group.link as { parentId: string }).parentId);
  if (!parent) return [];
  return model.elements.filter((e) => e.kind === group.childKind && !inGroup.has(e.id) && relationKindFor(parent.kind, e.kind));
}

/** 既存の要素を枠に足す (上位 → 要素の関係を作る) */
export function linkToGroup(model: UntieModel, group: FixedGroup, elementId: string): CommandResult {
  if (group.link.type !== "relation") return { ok: false, reason: "この枠には既存の要素を足せません" };
  return addRelation(model, { sourceId: group.link.parentId, targetId: elementId });
}

/** 要素を枠から外す (上位 → 要素の関係を消す。要素は残る) */
export function unlinkFromGroup(model: UntieModel, group: FixedGroup, elementId: string): CommandResult {
  if (group.link.type !== "relation") return { ok: false, reason: "この枠からは外せません" };
  const parentId = group.link.parentId;
  const rel = model.relations.find((r) => r.sourceId === parentId && r.targetId === elementId);
  if (!rel) return { ok: false, reason: "関係が見つかりません" };
  return removeRelation(model, { id: rel.id });
}
