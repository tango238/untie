// 分析（簡易）のボード「システム操作」。作業 → 操作 → 画面・情報 を 1 枚で見る。作業は、1 つ上の概念 (活動、無ければ業務) の枠で囲む。
// モデルには保存せず (配置も持たない)、毎回モデルから組み立てる。純粋関数だけを置く。
import { addElement, addRelation, USECASE_TARGET_LIMIT_REASON, isUsecaseTargetKind, type CommandResult } from "./commands";
import { addToGroup, type FixedGroup } from "./fixedBoards";
import { defaultBucOf } from "./selectors";
import type { Activity, Buc, Business, Condition, Element, EventElement, InformationAccess, Information, Ledger, RelationAlternate, Screen, State, System, UntieModel, Usecase, Variation } from "./types";

/** 操作が扱う情報 1 つ (usecaseInformation)。access は取得 (read)・保存 (write)。省略は両方 */
export interface OperationInformation {
  information: Information;
  access?: InformationAccess;
}

/** 操作が判断する条件 1 つ (usecaseCondition)。alternate は、その判断の結果ふだんと違う流れになるときの代替パターン */
export interface OperationCondition {
  condition: Condition;
  /** 条件が参照する区分のバリエーション (conditionVariation) */
  variations: Variation[];
  /** 条件が参照する状態 (conditionState) */
  states: State[];
  alternate?: RelationAlternate;
}

/** 操作の枠: 前提・次の状態・使う画面・対象 (システム・帳票)・扱う情報・判断する条件・きっかけと発生のイベント */
export interface OperationBox {
  usecase: Usecase;
  screens: Screen[];
  /** 操作の対象のシステム・帳票 (対象は 1 つだけなので、画面があれば空) */
  targets: (System | Ledger)[];
  /** 前提の状態 (stateUsecase: 状態 → 操作。「実行可」。その状態のときにこの操作ができる) */
  premiseStates: State[];
  /** 次の状態 (usecaseState: 操作 → 状態。この操作をするとその状態になる) */
  nextStates: State[];
  /** 操作が扱う情報 (情報の入れ物のコンテキストは出さない) */
  informations: OperationInformation[];
  /** 操作が判断する条件 */
  conditions: OperationCondition[];
  /** きっかけのイベント (イベント → 操作) */
  triggers: EventElement[];
  /** 発生するイベント (操作 → イベント) */
  emits: EventElement[];
}

/** 作業 1 つの行: 作業のカードと、その作業が使う操作 */
export interface OperationRow {
  activity: Activity;
  operations: OperationBox[];
}

/** いちばん外側の枠: 作業の 1 つ上の概念 */
export interface OperationFrame {
  /** 重ならない key */
  key: string;
  /** buc: 活動の枠、business: 業務の枠 (業務に直接属する作業)、none: 業務に属さない作業 */
  kind: "buc" | "business" | "none";
  /** 枠の元になった活動または業務 (none は null)。見出しの選択と「＋作業」の足し先 */
  element: Buc | Business | null;
  /** 活動の枠のとき、その業務 (見出しに添える) */
  business: Business | null;
  rows: OperationRow[];
}

export interface OperationBoardData {
  frames: OperationFrame[];
  /** どの作業にも結ばれていない操作 */
  unlinkedOperations: OperationBox[];
  /** どの操作にも結ばれていない画面 */
  unlinkedScreens: Screen[];
  /** どの操作にも扱われていない情報 */
  unlinkedInformations: Information[];
  /** どの操作にも判断されていない条件 */
  unlinkedConditions: OperationCondition[];
}

/**
 * システム操作ボードを組み立てる。枠は業務の順 → (業務に直接の作業の枠 → 活動の枠) の順。
 * 活動の枠は作業が無くても出す (そこに作業を足せる)。業務の枠は、活動の無い業務か、直下に作業が残っている業務だけ (混在させない決まり)。
 * 検証に通らないモデル (存在しない活動を指す作業など) でも要素が消えないよう、どの枠にも出ない作業は「業務に属さない作業」に入れる
 */
export function buildOperationBoard(model: UntieModel): OperationBoardData {
  const byId = new Map(model.elements.map((e) => [e.id, e]));
  const activities = model.elements.filter((e): e is Activity => e.kind === "activity");
  const usecases = model.elements.filter((e): e is Usecase => e.kind === "usecase");
  const kindOf = <T extends Element>(id: string, kind: T["kind"]) => {
    const e = byId.get(id);
    return e && e.kind === kind ? (e as T) : undefined;
  };

  // 操作ごとの関連 (関係を 1 回走査して表を作る)
  const activitiesOf = new Map<string, string[]>();
  const usecasesOfActivity = new Map<string, string[]>();
  const screensOf = new Map<string, Screen[]>();
  const informationsOf = new Map<string, OperationInformation[]>();
  const conditionsOf = new Map<string, { condition: Condition; alternate?: RelationAlternate }[]>();
  const variationsOfCondition = new Map<string, Variation[]>();
  const statesOfCondition = new Map<string, State[]>();
  const premiseOf = new Map<string, State[]>();
  const nextOf = new Map<string, State[]>();
  const targetsOf = new Map<string, (System | Ledger)[]>();
  const triggersOf = new Map<string, EventElement[]>();
  const emitsOf = new Map<string, EventElement[]>();
  const push = <V>(map: Map<string, V[]>, key: string, value: V | undefined) => {
    if (value === undefined) return;
    const list = map.get(key) ?? [];
    if (!list.includes(value)) list.push(value);
    map.set(key, list);
  };
  for (const r of model.relations) {
    if (r.kind === "activityUsecase" && kindOf<Activity>(r.sourceId, "activity") && kindOf<Usecase>(r.targetId, "usecase")) {
      push(usecasesOfActivity, r.sourceId, r.targetId);
      push(activitiesOf, r.targetId, r.sourceId);
    } else if (r.kind === "usecaseScreen") push(screensOf, r.sourceId, kindOf<Screen>(r.targetId, "screen"));
    else if (r.kind === "usecaseInformation") {
      const information = kindOf<Information>(r.targetId, "information");
      const list = informationsOf.get(r.sourceId) ?? [];
      if (information && !list.some((x) => x.information.id === information.id)) list.push({ information, ...(r.access !== undefined ? { access: r.access } : {}) });
      informationsOf.set(r.sourceId, list);
    } else if (r.kind === "conditionVariation") push(variationsOfCondition, r.sourceId, kindOf<Variation>(r.targetId, "variation"));
    else if (r.kind === "conditionState") push(statesOfCondition, r.sourceId, kindOf<State>(r.targetId, "state"));
    else if (r.kind === "stateUsecase") push(premiseOf, r.targetId, kindOf<State>(r.sourceId, "state"));
    else if (r.kind === "usecaseState") push(nextOf, r.sourceId, kindOf<State>(r.targetId, "state"));
    else if (r.kind === "usecaseCondition") {
      const condition = kindOf<Condition>(r.targetId, "condition");
      const list = conditionsOf.get(r.sourceId) ?? [];
      if (condition && !list.some((x) => x.condition.id === condition.id)) list.push({ condition, ...(r.alternate !== undefined ? { alternate: r.alternate } : {}) });
      conditionsOf.set(r.sourceId, list);
    } else if (r.kind === "usecaseSystem") push(targetsOf, r.sourceId, kindOf<System>(r.targetId, "system") ?? kindOf<Ledger>(r.targetId, "ledger"));
    else if (r.kind === "eventUsecase") push(triggersOf, r.targetId, kindOf<EventElement>(r.sourceId, "event"));
    else if (r.kind === "usecaseEvent") push(emitsOf, r.sourceId, kindOf<EventElement>(r.targetId, "event"));
  }
  /** 区分・状態・前提の状態・次の状態は、相手が実在するものだけ (存在しない相手を指す関係は無視する)。並びはモデルの順 */
  const position = new Map(model.elements.map((e, i) => [e.id, i]));
  const inModelOrder = <T extends Element>(items: T[] | undefined): T[] => [...(items ?? [])].sort((a, b) => position.get(a.id)! - position.get(b.id)!);
  const conditionEntry = (condition: Condition): OperationCondition => ({
    condition,
    variations: inModelOrder(variationsOfCondition.get(condition.id)),
    states: inModelOrder(statesOfCondition.get(condition.id)),
  });
  const boxOf = (u: Usecase): OperationBox => ({
    usecase: u,
    premiseStates: inModelOrder(premiseOf.get(u.id)),
    nextStates: inModelOrder(nextOf.get(u.id)),
    screens: screensOf.get(u.id) ?? [],
    targets: targetsOf.get(u.id) ?? [],
    informations: informationsOf.get(u.id) ?? [],
    conditions: (conditionsOf.get(u.id) ?? []).map((x) => ({ ...conditionEntry(x.condition), ...(x.alternate !== undefined ? { alternate: x.alternate } : {}) })),
    triggers: triggersOf.get(u.id) ?? [],
    emits: emitsOf.get(u.id) ?? [],
  });
  const boxes = new Map(usecases.map((u) => [u.id, boxOf(u)]));
  const rowOf = (a: Activity): OperationRow => ({
    activity: a,
    // 操作の並びはモデルの順
    operations: usecases.filter((u) => (usecasesOfActivity.get(a.id) ?? []).includes(u.id)).map((u) => boxes.get(u.id)!),
  });

  const frames: OperationFrame[] = [];
  const shown = new Set<string>();
  const addFrame = (frame: Omit<OperationFrame, "rows">, members: Activity[]) => {
    for (const a of members) shown.add(a.id);
    frames.push({ ...frame, rows: members.map(rowOf) });
  };
  for (const biz of model.elements.filter((e): e is Business => e.kind === "business")) {
    const def = defaultBucOf(model, biz.id);
    const bucs = model.elements.filter((e): e is Buc => e.kind === "buc" && e.businessId === biz.id && !e.isDefault);
    const direct = def ? activities.filter((a) => a.bucId === def.id) : [];
    if (direct.length > 0 || bucs.length === 0) addFrame({ key: biz.id, kind: "business", element: biz, business: null }, direct);
    for (const buc of bucs) addFrame({ key: buc.id, kind: "buc", element: buc, business: biz }, activities.filter((a) => a.bucId === buc.id));
  }
  // 重複して数えない (既定の活動が 2 つある業務など、枠に出なかった作業だけが残る)
  const orphans = activities.filter((a) => !shown.has(a.id));
  if (orphans.length > 0) addFrame({ key: "__none", kind: "none", element: null, business: null }, orphans);

  const usedScreens = new Set([...boxes.values()].flatMap((b) => b.screens.map((s) => s.id)));
  const usedConditions = new Set([...boxes.values()].flatMap((b) => b.conditions.map((x) => x.condition.id)));
  const usedInformations = new Set([...boxes.values()].flatMap((b) => b.informations.map((x) => x.information.id)));
  return {
    frames,
    unlinkedOperations: usecases.filter((u) => (activitiesOf.get(u.id) ?? []).length === 0).map((u) => boxes.get(u.id)!),
    unlinkedScreens: model.elements.filter((e): e is Screen => e.kind === "screen" && !usedScreens.has(e.id)),
    unlinkedConditions: model.elements.filter((e): e is Condition => e.kind === "condition" && !usedConditions.has(e.id)).map(conditionEntry),
    unlinkedInformations: model.elements.filter((e): e is Information => e.kind === "information" && !usedInformations.has(e.id)),
  };
}

// ---------------------------------------------------------------- 足す

/** システム操作ボードで足せるもの */
export type OperationAddKind = "usecase" | "screen" | "information" | "condition";

/** 画面を足せるシステム (画面はシステムに属すので、システムが要る) */
export function systemsForScreens(model: UntieModel): System[] {
  return model.elements.filter((e): e is System => e.kind === "system");
}

/** 操作に画面を足せるか。足せないときは理由を返す (対象は 1 つだけ。画面が要るシステムが無いときも足せない) */
export function whyCannotAddScreen(model: UntieModel, usecaseId: string, hasSystems: boolean = systemsForScreens(model).length > 0): string | null {
  if (model.relations.some((r) => isUsecaseTargetKind(r.kind) && r.sourceId === usecaseId)) return USECASE_TARGET_LIMIT_REASON;
  if (!hasSystems) return "画面は、画面の持ち主になるシステム (例: 宿泊管理システム) に属します。先に分析（詳細）の「登場人物」でシステムを作ってください";
  return null;
}

/**
 * システム操作ボードで足す。足したものは、持ち主に結ぶ (作成と結び付けで 1 件の履歴)。
 * - usecase: 親は作業 (その作業が使う操作として結ぶ。固定ボード「操作」の「枠に足す」と同じ)
 * - condition: 親は操作 (その操作が判断する条件として結ぶ。入れ物のコンテキストは付けない。代替パターンは付けない)
 * - information: 親は操作 (その操作が扱う情報として結ぶ。取得・保存の区別は省略 = 両方。入れ物のコンテキストは付けない)
 * - screen: 親は操作 (操作の対象の画面として結ぶ。画面はシステムに属すので systemId を渡す。システムが 1 つだけなら省略できる)。
 *   対象は 1 つだけ (システム・帳票・画面のどれか) なので、すでに対象のある操作には足せない
 */
export function addOperationElement(model: UntieModel, kind: OperationAddKind, parentId: string, options: { systemId?: string } = {}): CommandResult<{ id: string }> {
  const parent = model.elements.find((e) => e.id === parentId);
  if (kind === "usecase") {
    if (!parent || parent.kind !== "activity") return { ok: false, reason: "操作は作業の中に足します" };
    const group: FixedGroup = { key: parent.id, title: parent.name, parentId: parent.id, childKind: "usecase", link: { type: "relation", parentId: parent.id }, items: [] };
    return addToGroup(model, group, "新しい操作");
  }
  if (kind === "condition") {
    if (!parent || parent.kind !== "usecase") return { ok: false, reason: "条件は操作の中に足します" };
    const created = addElement(model, { kind: "condition", name: "新しい条件" });
    if (!created.ok) return created;
    const linked = addRelation(created.model, { sourceId: parent.id, targetId: created.id });
    return linked.ok ? { ok: true, model: linked.model, id: created.id } : linked;
  }
  if (kind === "information") {
    if (!parent || parent.kind !== "usecase") return { ok: false, reason: "情報は操作の中に足します" };
    const created = addElement(model, { kind: "information", name: "新しい情報" });
    if (!created.ok) return created;
    const linked = addRelation(created.model, { sourceId: parent.id, targetId: created.id });
    return linked.ok ? { ok: true, model: linked.model, id: created.id } : linked;
  }
  if (!parent || parent.kind !== "usecase") return { ok: false, reason: "画面は操作の中に足します" };
  const reason = whyCannotAddScreen(model, parent.id);
  if (reason) return { ok: false, reason };
  const systems = systemsForScreens(model);
  const system = options.systemId !== undefined ? systems.find((s) => s.id === options.systemId) : systems.length === 1 ? systems[0] : undefined;
  if (!system) return { ok: false, reason: "画面を足すシステムを選んでください" };
  const created = addElement(model, { kind: "screen", name: "新しい画面", init: { systemId: system.id } });
  if (!created.ok) return created;
  const linked = addRelation(created.model, { sourceId: parent.id, targetId: created.id });
  return linked.ok ? { ok: true, model: linked.model, id: created.id } : linked;
}
