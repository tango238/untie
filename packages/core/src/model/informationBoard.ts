// 分析（簡易）のボード「情報と状態」。コンテキスト → 情報 (・バリエーション)・状態 を 1 枚で見る。
// モデルには保存せず (配置も持たない)、毎回モデルから組み立てる。純粋関数だけを置く。
//
// モデルの形 (relations.ts・types.ts):
// - 情報・状態・バリエーション (・条件・イベント) は contextId でコンテキストに属す (null は未分類)。状態は状態グループごとに同じコンテキストに属す
// - 情報 → バリエーションは informationVariation (種別)、情報どうしは informationRelated (関連。向きなし)
// - 状態と情報を直接結ぶ関係は無い。状態は、状態グループ (State.group) と所属のコンテキストで束ねる
// - 条件はこのボードには出さない (操作が判断するので、システム操作ボードで見る)
import { produce } from "immer";
import { addElement, addRelation, type CommandResult } from "./commands";
import { stateGroupKey, type Context, type Information, type State, type UntieModel, type Variation } from "./types";

/** 状態グループ名の正規化 (前後の空白を除き、空はグループなし) */
const groupOf = (state: { group?: string }): string | undefined => state.group?.trim() || undefined;

/** 情報 1 行: 情報のカードと、その情報の種別のバリエーション・関連する情報 */
export interface InformationRow {
  information: Information;
  /** 種別のバリエーション (informationVariation) */
  variations: Variation[];
  /** 関連する情報 (informationRelated。向きなし) */
  related: Information[];
}

/** 同じ状態グループの状態 (group が undefined のものは「グループなし」) */
export interface StateGroupBox {
  key: string;
  group: string | undefined;
  states: State[];
}

/** いちばん外側の枠: コンテキスト (context が null は「コンテキストが決まっていない」) */
export interface ContextFrame {
  key: string;
  context: Context | null;
  rows: InformationRow[];
  stateGroups: StateGroupBox[];
  /** どの情報にも結ばれていないバリエーション */
  unlinkedVariations: Variation[];
}

export interface InformationBoardData {
  frames: ContextFrame[];
}

/**
 * 情報と状態のボードを組み立てる。枠はコンテキストの順。コンテキストが無い・存在しないコンテキストを指す要素は、
 * 「コンテキストが決まっていない」枠に入れる (検証に通らないモデルでも要素が消えない)。決まっていない枠は、入るものがあるときだけ出す。
 * 並びはモデルの順 (固定ボードと同じ)。バリエーションは、結ばれた情報の行に出す (複数の情報に結ばれていれば、それぞれに出す)
 */
export function buildInformationBoard(model: UntieModel): InformationBoardData {
  const contexts = model.elements.filter((e): e is Context => e.kind === "context");
  const contextIds = new Set(contexts.map((c) => c.id));
  const infos = model.elements.filter((e): e is Information => e.kind === "information");
  const states = model.elements.filter((e): e is State => e.kind === "state");
  const variations = model.elements.filter((e): e is Variation => e.kind === "variation");
  const infoById = new Map(infos.map((i) => [i.id, i]));
  const variationById = new Map(variations.map((v) => [v.id, v]));

  const variationsOf = new Map<string, Variation[]>();
  const relatedOf = new Map<string, Information[]>();
  const linkedVariations = new Set<string>();
  const add = <V>(map: Map<string, V[]>, key: string, value: V | undefined) => {
    if (value === undefined) return;
    const list = map.get(key) ?? [];
    if (!list.includes(value)) list.push(value);
    map.set(key, list);
  };
  for (const r of model.relations) {
    if (r.kind === "informationVariation" && infoById.has(r.sourceId) && variationById.has(r.targetId)) {
      add(variationsOf, r.sourceId, variationById.get(r.targetId));
      linkedVariations.add(r.targetId);
    } else if (r.kind === "informationRelated" && infoById.has(r.sourceId) && infoById.has(r.targetId)) {
      add(relatedOf, r.sourceId, infoById.get(r.targetId));
      add(relatedOf, r.targetId, infoById.get(r.sourceId));
    }
  }
  // 並びはモデルの順
  const inModelOrder = <T extends { id: string }>(items: T[], source: readonly T[]) => source.filter((x) => items.includes(x));

  const frameKeyOf = (contextId: string | null) => (contextId !== null && contextIds.has(contextId) ? contextId : "__none");
  const build = (key: string, context: Context | null): ContextFrame => {
    const here = <T extends { contextId: string | null }>(xs: T[]) => xs.filter((x) => frameKeyOf(x.contextId) === key);
    const groups: StateGroupBox[] = [];
    for (const st of here(states)) {
      // 前後の空白だけが違うグループ名・空のグループ名は、同じグループ・グループなしとして扱う (グループなしの箱と key が衝突しない)
      const group = groupOf(st);
      let box = groups.find((g) => g.group === group);
      if (!box) {
        box = { key: `${key}:${group ? stateGroupKey(st) : "none"}`, group, states: [] };
        groups.push(box);
      }
      box.states.push(st);
    }
    return {
      key,
      context,
      rows: here(infos).map((information) => ({
        information,
        variations: inModelOrder(variationsOf.get(information.id) ?? [], variations),
        related: inModelOrder(relatedOf.get(information.id) ?? [], infos),
      })),
      stateGroups: groups,
      unlinkedVariations: here(variations).filter((v) => !linkedVariations.has(v.id)),
    };
  };
  const frames = contexts.map((c) => build(c.id, c));
  const none = build("__none", null);
  if (none.rows.length > 0 || none.stateGroups.length > 0 || none.unlinkedVariations.length > 0) frames.push(none);
  return { frames };
}

// ---------------------------------------------------------------- 足す

/** 実在するコンテキストの id か null (存在しないコンテキストを指す要素は、未分類として扱う) */
function existingContextId(model: UntieModel, contextId: string | null): string | null {
  return contextId !== null && model.elements.some((e) => e.id === contextId && e.kind === "context") ? contextId : null;
}

/** 情報と状態のボードで足せるもの */
export type InformationAddKind = "context" | "information" | "state" | "variation";

/**
 * 情報と状態のボードで足す。
 * - context: 親なし
 * - information: 親はコンテキストの id (null は「コンテキストが決まっていない」)。そのコンテキストに属す情報にする
 * - state: 親はコンテキストの id (null は未分類)。options.group があれば、その状態グループの状態にする
 *   (状態グループは同じコンテキストに属す決まりなので、グループがあれば、そのグループの状態のコンテキストに合わせる)
 * - variation: 親は情報 (その情報の種別として結ぶ。情報と同じコンテキストに属す)
 */
export function addInformationBoardElement(model: UntieModel, kind: InformationAddKind, parentId: string | null, options: { group?: string } = {}): CommandResult<{ id: string }> {
  if (kind === "context") return addElement(model, { kind: "context", name: "新しいコンテキスト" });
  if (kind === "variation") {
    const info = model.elements.find((e) => e.id === parentId);
    if (!info || info.kind !== "information") return { ok: false, reason: "バリエーションは情報の中に足します" };
    // 実在するコンテキストのときだけ引き継ぐ (存在しないコンテキストを指す情報は、「決まっていない」枠に出ているので未分類にする)
    const created = addElement(model, { kind: "variation", name: "新しいバリエーション", init: { contextId: existingContextId(model, info.contextId) } });
    if (!created.ok) return created;
    const linked = addRelation(created.model, { sourceId: info.id, targetId: created.id });
    return linked.ok ? { ok: true, model: linked.model, id: created.id } : linked;
  }
  if (parentId !== null) {
    const ctx = model.elements.find((e) => e.id === parentId);
    if (!ctx || ctx.kind !== "context") return { ok: false, reason: "足し先のコンテキストが見つかりません" };
  }
  if (kind === "information") return addElement(model, { kind: "information", name: "新しい情報", init: { contextId: parentId } });
  const group = options.group?.trim() || undefined;
  const created = addElement(model, { kind: "state", name: "新しい状態", init: { contextId: parentId, ...(group ? { group } : {}) } });
  if (!created.ok) return created;
  // addElement は、状態グループがあるとき、そのグループの最初の状態のコンテキストに合わせる。
  // 押した枠 (= グループの箱があるコンテキスト) に出るよう、違っていれば枠のコンテキストに直す (箱は同じ枠の状態だけでできているので、グループの決まりは崩れない)
  const added = created.model.elements.find((e) => e.id === created.id);
  if (added && added.kind === "state" && added.contextId !== parentId) {
    return { ...created, model: produce(created.model, (draft) => { const el = draft.elements.find((e) => e.id === created.id); if (el && el.kind === "state") el.contextId = parentId; }) };
  }
  return created;
}
