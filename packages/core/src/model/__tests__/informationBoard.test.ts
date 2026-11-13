import { describe, expect, it } from "vitest";
import { addElement, addRelation, removeElement, removeRelation } from "../commands";
import { addInformationBoardElement, buildInformationBoard } from "../informationBoard";
import { addOperationElement, alternateText, buildOperationBoard, stateLabel } from "../operationBoard";
import { relationRemovalImpact, removalImpact } from "../workflow";
import { validateModel } from "../validate";
import type { UntieModel } from "../types";
import { okModel, expectFail, sample } from "./helpers";

const ids = (xs: { id: string }[]) => xs.map((x) => x.id);
const count = (items: ReturnType<typeof removalImpact>, label: string) => items.find((i) => i.label === label)?.count ?? 0;

describe("buildInformationBoard", () => {
  it("枠はコンテキストの順。枠の中に情報の行 (種別のバリエーション・関連する情報つき) と、状態グループごとの状態が入る", () => {
    const m = sample();
    const b = buildInformationBoard(m);
    const contexts = m.elements.filter((e) => e.kind === "context").map((e) => e.id);
    expect(b.frames.map((f) => f.key).slice(0, contexts.length)).toEqual(contexts);
    // 情報はすべて、いずれかの枠の行に出る (情報の入れ物は contextId)
    const infos = m.elements.filter((e) => e.kind === "information");
    expect(ids(b.frames.flatMap((f) => f.rows.map((r) => r.information))).sort()).toEqual(ids(infos).sort());
    // 種別のバリエーション (informationVariation) が情報の行に出る
    const rel = m.relations.find((r) => r.kind === "informationVariation")!;
    const row = b.frames.flatMap((f) => f.rows).find((r) => r.information.id === rel.sourceId)!;
    expect(ids(row.variations)).toContain(rel.targetId);
    // 関連する情報 (向きなし) は両方の行に出る
    const related = m.relations.find((r) => r.kind === "informationRelated");
    if (related) {
      const rows = b.frames.flatMap((f) => f.rows);
      expect(ids(rows.find((r) => r.information.id === related.sourceId)!.related)).toContain(related.targetId);
      expect(ids(rows.find((r) => r.information.id === related.targetId)!.related)).toContain(related.sourceId);
    }
    // 状態は状態グループごとにまとまる
    const states = m.elements.filter((e) => e.kind === "state");
    expect(b.frames.flatMap((f) => f.stateGroups.flatMap((g) => g.states)).length).toBe(states.length);
    for (const g of b.frames.flatMap((f) => f.stateGroups)) expect(new Set(g.states.map((s) => s.group)).size).toBe(1);
  });

  it("条件は出さない。コンテキストの無い要素・存在しないコンテキストを指す要素は「コンテキストが決まっていない」枠に出て、1 つも失われない", () => {
    let m = okModel(addElement(sample(), { kind: "information", name: "宙の情報", id: "info_float" }));
    m = okModel(addElement(m, { kind: "state", name: "宙の状態", id: "st_float" }));
    m = okModel(addElement(m, { kind: "variation", name: "宙の区分", id: "var_float" }));
    m = { ...m, elements: [...m.elements, { id: "info_ghost", kind: "information", name: "幽霊の情報", contextId: "ctx_nothing" }] };
    const b = buildInformationBoard(m);
    const none = b.frames.find((f) => f.key === "__none")!;
    expect(none.context).toBeNull();
    expect(ids(none.rows.map((r) => r.information))).toEqual(expect.arrayContaining(["info_float", "info_ghost"]));
    expect(ids(none.stateGroups.flatMap((g) => g.states))).toContain("st_float");
    expect(ids(none.unlinkedVariations)).toContain("var_float");
    const shownIds = new Set<string>(
      b.frames.flatMap((f) => [...f.rows.map((r) => r.information.id), ...f.rows.flatMap((r) => r.variations.map((v) => v.id)), ...f.stateGroups.flatMap((g) => g.states.map((x) => x.id)), ...f.unlinkedVariations.map((v) => v.id)]),
    );
    for (const e of m.elements.filter((x) => ["information", "state", "variation"].includes(x.kind))) expect(shownIds.has(e.id)).toBe(true);
    // 条件はどの枠にも出ない
    const text = JSON.stringify(b);
    for (const c of m.elements.filter((e) => e.kind === "condition")) expect(text).not.toContain(`"id":"${c.id}"`);
    // 「決まっていない」枠は、入るものが無ければ出ない
    expect(buildInformationBoard(sample()).frames.some((f) => f.key === "__none")).toBe(
      sample().elements.some((e) => ["information", "state", "variation"].includes(e.kind) && (e as { contextId: string | null }).contextId === null),
    );
  });

  it("状態と情報を直接結ぶ関係は無いので、状態は情報の行ではなく、コンテキストの枠の状態グループに出る", () => {
    const m = sample();
    const b = buildInformationBoard(m);
    expect(b.frames.every((f) => f.rows.every((r) => !("states" in r)))).toBe(true);
    const grouped = b.frames.flatMap((f) => f.stateGroups).find((g) => g.group !== undefined);
    expect(grouped).toBeDefined();
  });
});

describe("addInformationBoardElement", () => {
  it("コンテキストを足す。情報・状態はそのコンテキストの所属で足す (状態グループがあれば、その状態グループの状態)", () => {
    const ctxRes = addInformationBoardElement(sample(), "context", null);
    const m0 = okModel(ctxRes);
    const ctxId = (ctxRes as { id: string }).id;
    expect(m0.elements.find((e) => e.id === ctxId)!.kind).toBe("context");
    const infoRes = addInformationBoardElement(m0, "information", ctxId);
    const m1 = okModel(infoRes);
    expect((m1.elements.find((e) => e.id === (infoRes as { id: string }).id) as { contextId: string | null }).contextId).toBe(ctxId);
    const g = m1.elements.find((e): e is Extract<typeof e, { kind: "state" }> => e.kind === "state" && !!e.group)!;
    const stRes = addInformationBoardElement(m1, "state", g.contextId, { group: g.group });
    const st = okModel(stRes).elements.find((e) => e.id === (stRes as { id: string }).id) as { group?: string; contextId: string | null };
    expect(st.group).toBe(g.group);
    expect(st.contextId).toBe(g.contextId);
    expect(validateModel(okModel(stRes)).ok).toBe(true);
    expectFail(addInformationBoardElement(m0, "information", "nothing"), /コンテキスト/);
    expectFail(addInformationBoardElement(m0, "information", "info_reservation"), /コンテキスト/);
  });

  it("情報にバリエーションを足す (種別として結び、情報と同じコンテキストに属す)。情報以外には足せない", () => {
    const r = addInformationBoardElement(sample(), "variation", "info_reservation");
    const m = okModel(r);
    const v = m.elements.find((e) => e.id === (r as { id: string }).id) as { contextId: string | null };
    const info = m.elements.find((e) => e.id === "info_reservation") as { contextId: string | null };
    expect(v.contextId).toBe(info.contextId);
    expect(m.relations.some((x) => x.kind === "informationVariation" && x.sourceId === "info_reservation" && x.targetId === (r as { id: string }).id)).toBe(true);
    expect(validateModel(m).ok).toBe(true);
    expectFail(addInformationBoardElement(sample(), "variation", "act_hand_key"), /情報の中/);
  });
});

describe("削除の影響 (コンテキスト・状態・バリエーション・条件) は removeElement の実際の振る舞いと合っている", () => {
  const goneRelations = (m: UntieModel, id: string) => {
    const after = okModel(removeElement(m, { id }));
    return { after, gone: m.relations.filter((r) => !after.relations.some((x) => x.id === r.id)) };
  };

  it("コンテキスト: 属していた要素は消えず、コンテキストが決まっていない要素になる", () => {
    const m = sample();
    const ctx = m.elements.find((e) => e.kind === "context" && m.elements.some((x) => "contextId" in x && x.contextId === e.id && x.kind === "state"))!;
    const impact = removalImpact(m, ctx.id);
    const members = (kind: string) => m.elements.filter((e) => e.kind === kind && "contextId" in e && e.contextId === ctx.id);
    expect(count(impact, "情報")).toBe(members("information").length);
    expect(count(impact, "状態")).toBe(members("state").length);
    expect(count(impact, "バリエーション")).toBe(members("variation").length);
    expect(count(impact, "条件")).toBe(members("condition").length);
    expect(count(impact, "状態")).toBeGreaterThan(0);
    const after = okModel(removeElement(m, { id: ctx.id }));
    for (const e of [...members("state"), ...members("information")]) expect((after.elements.find((x) => x.id === e.id) as { contextId: string | null }).contextId).toBeNull();
    expect(removalImpact(okModel(addElement(m, { kind: "context", name: "空", id: "ctx_empty" })), "ctx_empty")).toEqual([]);
  });

  it("状態: 条件の状態参照・操作の前提の状態/次の状態・代替パターンのそのあとの状態を数える", () => {
    const m = sample();
    const st = m.elements.find((e) => e.kind === "state" && m.relations.some((r) => (r.kind === "usecaseState" || r.kind === "stateUsecase") && (r.sourceId === e.id || r.targetId === e.id)))!;
    const impact = removalImpact(m, st.id);
    const { gone } = goneRelations(m, st.id);
    const n = (...k: string[]) => new Set(gone.filter((r) => k.includes(r.kind)).map((r) => (r.sourceId === st.id ? r.targetId : r.sourceId))).size;
    expect(count(impact, "条件")).toBe(n("conditionState"));
    expect(count(impact, "操作")).toBe(n("stateUsecase", "usecaseState"));
    expect(count(impact, "操作")).toBeGreaterThan(0);
    // 代替パターンの「そのあとの状態」
    const alt = m.relations.find((r) => r.kind === "usecaseCondition")!;
    const withAfter = { ...m, relations: m.relations.map((r) => (r.id === alt.id ? { ...r, alternate: { when: "unmet" as const, then: "別の流れ", after: { type: "states" as const, stateIds: [st.id] } } } : r)) };
    expect(count(removalImpact(withAfter, st.id), "代替パターン")).toBe(1);
    const after = okModel(removeElement(withAfter, { id: st.id }));
    expect(after.relations.find((r) => r.id === alt.id)?.alternate?.after).toBeUndefined();
    expect(after.relations.find((r) => r.id === alt.id)?.alternate?.then).toBe("別の流れ");
  });

  it("バリエーション: 種別の情報・区分の条件を数える。情報・条件は消えない", () => {
    const m = sample();
    const v = m.elements.find((e) => e.kind === "variation" && m.relations.some((r) => r.kind === "informationVariation" && r.targetId === e.id))!;
    const impact = removalImpact(m, v.id);
    const { gone, after } = goneRelations(m, v.id);
    expect(count(impact, "情報")).toBe(new Set(gone.filter((r) => r.kind === "informationVariation").map((r) => r.sourceId)).size);
    expect(count(impact, "条件")).toBe(new Set(gone.filter((r) => r.kind === "conditionVariation").map((r) => r.sourceId)).size);
    expect(count(impact, "情報")).toBeGreaterThan(0);
    expect(after.elements.filter((e) => e.kind === "information")).toHaveLength(m.elements.filter((e) => e.kind === "information").length);
  });

  it("条件: 判断していた操作 (結び付きが外れる)・代替パターン (一緒に消える)・バリエーション・状態を数える", () => {
    const m = sample();
    const alt = m.relations.find((r) => r.kind === "usecaseCondition" && r.alternate !== undefined)!;
    const impact = removalImpact(m, alt.targetId);
    const { gone } = goneRelations(m, alt.targetId);
    expect(count(impact, "操作")).toBe(new Set(gone.filter((r) => r.kind === "usecaseCondition").map((r) => r.sourceId)).size);
    expect(count(impact, "代替パターン")).toBe(gone.filter((r) => r.kind === "usecaseCondition" && r.alternate !== undefined).length);
    expect(impact.find((i) => i.label === "代替パターン")!.effect).toBe("removed");
    expect(count(impact, "バリエーション")).toBe(new Set(gone.filter((r) => r.kind === "conditionVariation").map((r) => r.targetId)).size);
    expect(count(impact, "状態")).toBe(new Set(gone.filter((r) => r.kind === "conditionState").map((r) => r.targetId)).size);
    // 結ばれていない条件は空
    expect(removalImpact(okModel(addElement(m, { kind: "condition", name: "孤立", id: "cond_lone" })), "cond_lone")).toEqual([]);
  });

  it("情報とバリエーション・状態の関係を外すのに、確認は要らない (子を持たず、何も失われない)", () => {
    const m = sample();
    for (const kind of ["informationVariation", "conditionVariation", "conditionState", "informationRelated"]) {
      const rel = m.relations.find((r) => r.kind === kind);
      if (rel) {
        expect(relationRemovalImpact(m, rel.id)).toEqual([]);
        expect(okModel(removeRelation(m, { id: rel.id })).relations.some((r) => r.id === rel.id)).toBe(false);
      }
    }
  });
});

describe("システム操作ボードの条件", () => {
  it("操作の枠に、判断する条件が代替パターンつきで並ぶ。同じ条件を複数の操作が判断していれば、それぞれに出る。どの操作にも結ばれていない条件は別に出る", () => {
    const m = sample();
    const rels = m.relations.filter((r) => r.kind === "usecaseCondition");
    const boxes = buildOperationBoard(m).frames.flatMap((f) => f.rows.flatMap((r) => r.operations));
    for (const r of rels) {
      const box = boxes.find((b) => b.usecase.id === r.sourceId);
      if (!box) continue;
      const entry = box.conditions.find((x) => x.condition.id === r.targetId)!;
      expect(entry.alternate).toEqual(r.alternate);
    }
    expect(boxes.some((b) => b.conditions.some((x) => x.alternate !== undefined))).toBe(true);
    const lone = okModel(addElement(m, { kind: "condition", name: "宙の条件", id: "cond_float" }));
    expect(ids(buildOperationBoard(lone).unlinkedConditions.map((x) => x.condition))).toContain("cond_float");
    // 存在しない操作から結ばれた条件も失われない
    const ghost = { ...lone, relations: [...lone.relations, { id: "rel_ghost_c", kind: "usecaseCondition", sourceId: "uc_nothing", targetId: "cond_float" } as never] };
    expect(ids(buildOperationBoard(ghost).unlinkedConditions.map((x) => x.condition))).toContain("cond_float");
  });

  it("操作に条件を足す (判断する条件として結ぶ。代替パターンは付けない)。操作以外には足せない", () => {
    const r = addOperationElement(sample(), "condition", "uc_register_reservation");
    const m = okModel(r);
    const rel = m.relations.find((x) => x.kind === "usecaseCondition" && x.targetId === (r as { id: string }).id)!;
    expect(rel.sourceId).toBe("uc_register_reservation");
    expect(rel.alternate).toBeUndefined();
    expect(validateModel(m).ok).toBe(true);
    expectFail(addOperationElement(sample(), "condition", "act_hand_key"), /操作の中/);
  });
});

describe("情報と状態ボードの足し先・状態グループ名の扱い", () => {
  const ghostInfo = (m: UntieModel): UntieModel => ({ ...m, elements: [...m.elements, { id: "info_ghost", kind: "information", name: "幽霊の情報", contextId: "ctx_nothing" }] });

  it("実在しないコンテキストを指す情報にバリエーションを足せる (未分類になり、「決まっていない」枠の情報の行に出る)", () => {
    const m = ghostInfo(sample());
    const r = addInformationBoardElement(m, "variation", "info_ghost");
    const after = okModel(r);
    const v = after.elements.find((e) => e.id === (r as { id: string }).id) as { contextId: string | null };
    expect(v.contextId).toBeNull();
    const none = buildInformationBoard(after).frames.find((f) => f.key === "__none")!;
    expect(ids(none.rows.find((x) => x.information.id === "info_ghost")!.variations)).toContain((r as { id: string }).id);
  });

  it("「決まっていない」枠の「＋情報」「＋状態」は未分類で作る。システム操作ボードの「＋情報」「＋条件」は失敗しない", () => {
    const m = sample();
    const info = addInformationBoardElement(m, "information", null);
    expect((okModel(info).elements.find((e) => e.id === (info as { id: string }).id) as { contextId: string | null }).contextId).toBeNull();
    const st = addInformationBoardElement(m, "state", null);
    expect((okModel(st).elements.find((e) => e.id === (st as { id: string }).id) as { contextId: string | null }).contextId).toBeNull();
    expect(addOperationElement(ghostInfo(m), "information", "uc_register_reservation").ok).toBe(true);
    expect(addOperationElement(m, "condition", "uc_register_reservation").ok).toBe(true);
  });

  it("「決まっていない」枠の状態グループの「＋状態」で足した状態は、押した枠に出る (グループの最初の状態が別のコンテキストでも)", () => {
    let m = okModel(addElement(sample(), { kind: "state", name: "宙の状態", id: "st_float_a", init: { group: "宙のグループ" } }));
    // 同じグループの最初の状態を、存在しないコンテキストに置く (検証に通らないモデル。押した枠は「決まっていない」)
    m = { ...m, elements: [{ id: "st_ghost_first", kind: "state", name: "最初", group: "宙のグループ", contextId: "ctx_nothing" }, ...m.elements] };
    const box = buildInformationBoard(m).frames.find((f) => f.key === "__none")!.stateGroups.find((g) => g.group === "宙のグループ")!;
    expect(box.states.length).toBe(2);
    const r = addInformationBoardElement(m, "state", null, { group: "宙のグループ" });
    const after = okModel(r);
    const added = after.elements.find((e) => e.id === (r as { id: string }).id) as { group?: string; contextId: string | null };
    expect(added.group).toBe("宙のグループ");
    expect(added.contextId).toBeNull();
    const none = buildInformationBoard(after).frames.find((f) => f.key === "__none")!;
    expect(ids(none.stateGroups.find((g) => g.group === "宙のグループ")!.states)).toContain((r as { id: string }).id);
  });

  it("状態グループ名は前後の空白を除いて比べ、空はグループなしにする。名前が __nogroup でも、グループなしの箱と key が衝突しない", () => {
    let m = sample();
    const add = (id: string, group: string | undefined) => {
      m = okModel(addElement(m, { kind: "state", name: id, id, init: { contextId: null, ...(group !== undefined ? { group } : {}) } }));
    };
    add("st_a", "予約グループ ");
    add("st_b", " 予約グループ");
    add("st_c", "");
    add("st_d", "   ");
    add("st_e", undefined);
    add("st_f", "__nogroup");
    add("st_g", "none");
    const none = buildInformationBoard(m).frames.find((f) => f.key === "__none")!;
    const boxes = none.stateGroups;
    expect(new Set(boxes.map((b) => b.key)).size).toBe(boxes.length);
    expect(ids(boxes.find((b) => b.group === "予約グループ")!.states)).toEqual(["st_a", "st_b"]);
    expect(ids(boxes.find((b) => b.group === undefined)!.states)).toEqual(expect.arrayContaining(["st_c", "st_d", "st_e"]));
    expect(boxes.filter((b) => b.group === undefined)).toHaveLength(1);
    expect(ids(boxes.find((b) => b.group === "__nogroup")!.states)).toEqual(["st_f"]);
    expect(ids(boxes.find((b) => b.group === "none")!.states)).toEqual(["st_g"]);
    // 空白つきの名前で足しても、同じグループに入る
    const r = addInformationBoardElement(m, "state", null, { group: " 予約グループ " });
    expect((okModel(r).elements.find((e) => e.id === (r as { id: string }).id) as { group?: string }).group).toBe("予約グループ");
  });

  it("複数の情報に結ばれたバリエーションは、それぞれの情報の行に出る。どの情報にも結ばれていなければ出ない", () => {
    const m0 = sample();
    const rel = m0.relations.find((r) => r.kind === "informationVariation")!;
    const other = m0.elements.find((e) => e.kind === "information" && e.id !== rel.sourceId && !m0.relations.some((r) => r.kind === "informationVariation" && r.sourceId === e.id && r.targetId === rel.targetId))!;
    const m = okModel(addRelation(m0, { sourceId: other.id, targetId: rel.targetId }));
    const rows = buildInformationBoard(m).frames.flatMap((f) => f.rows);
    for (const infoId of [rel.sourceId, other.id]) expect(ids(rows.find((r) => r.information.id === infoId)!.variations)).toContain(rel.targetId);
    expect(buildInformationBoard(m).frames.flatMap((f) => f.unlinkedVariations.map((v) => v.id))).not.toContain(rel.targetId);
  });
});

describe("システム操作ボードの条件に添える区分と状態", () => {
  const entryOf = (m: UntieModel, id: string) => buildOperationBoard(m).frames.flatMap((f) => f.rows.flatMap((r) => r.operations.flatMap((o) => o.conditions))).find((x) => x.condition.id === id)!;

  it("条件が参照する区分 (conditionVariation) と状態 (conditionState) の名前が、条件の行のデータに入る。無ければ空", () => {
    const m = sample();
    const e = entryOf(m, "cond_full");
    expect(e.variations.map((v) => v.name)).toEqual(["部屋タイプ"]);
    expect(ids(e.states)).toEqual(["st_room_inuse"]);
    // 状態グループがあれば、行から分かる (group は状態に付いている)
    expect(e.states[0]!.group).toBe("部屋の状態");
    // 区分も状態も無い条件 (足したばかり) は空
    const r = addOperationElement(m, "condition", "uc_register_reservation");
    const added = entryOf(okModel(r), (r as { id: string }).id);
    expect(added.variations).toEqual([]);
    expect(added.states).toEqual([]);
  });

  it("複数の区分・状態はモデルの順に並ぶ。同じ相手に関係が重なっても 1 つ。存在しない相手を指す関係は無視する", () => {
    let m = okModel(addRelation(sample(), { sourceId: "cond_full", targetId: "st_res_confirmed" }));
    m = { ...m, relations: [...m.relations, { id: "rel_dup", kind: "conditionState", sourceId: "cond_full", targetId: "st_res_confirmed" } as never, { id: "rel_ghost_v", kind: "conditionVariation", sourceId: "cond_full", targetId: "var_nothing" } as never, { id: "rel_ghost_s", kind: "conditionState", sourceId: "cond_full", targetId: "info_reservation" } as never] };
    const e = entryOf(m, "cond_full");
    const order = m.elements.filter((x) => x.kind === "state" && ["st_room_inuse", "st_res_confirmed"].includes(x.id)).map((x) => x.id);
    expect(ids(e.states)).toEqual(order);
    expect(e.states).toHaveLength(2);
    expect(e.variations.map((v) => v.name)).toEqual(["部屋タイプ"]);
  });

  it("操作に結ばれていない条件にも、区分・状態が入る", () => {
    let m = okModel(addElement(sample(), { kind: "condition", name: "宙の条件", id: "cond_float" }));
    m = okModel(addRelation(m, { sourceId: "cond_float", targetId: "var_room_type" }));
    m = okModel(addRelation(m, { sourceId: "cond_float", targetId: "st_room_inuse" }));
    const e = buildOperationBoard(m).unlinkedConditions.find((x) => x.condition.id === "cond_float")!;
    expect(e.variations.map((v) => v.name)).toEqual(["部屋タイプ"]);
    expect(ids(e.states)).toEqual(["st_room_inuse"]);
    expect(e.alternate).toBeUndefined();
  });
});

describe("システム操作ボードの操作の前提の状態・次の状態", () => {
  const boxesOf = (m: UntieModel) => buildOperationBoard(m).frames.flatMap((f) => f.rows.flatMap((r) => r.operations));
  const boxOf = (m: UntieModel, id: string) => boxesOf(m).find((b) => b.usecase.id === id)!;

  it("前提の状態 (stateUsecase: 状態 → 操作) と次の状態 (usecaseState: 操作 → 状態) が、向きを守って操作のデータに入る。無ければ空", () => {
    const m = sample();
    const premise = m.relations.filter((r) => r.kind === "stateUsecase" && r.targetId === "uc_confirm_reservation").map((r) => r.sourceId);
    const next = m.relations.filter((r) => r.kind === "usecaseState" && r.sourceId === "uc_confirm_reservation").map((r) => r.targetId);
    expect(premise.length).toBeGreaterThan(0);
    expect(next.length).toBeGreaterThan(0);
    const box = boxOf(m, "uc_confirm_reservation");
    expect(ids(box.premiseStates)).toEqual(m.elements.filter((e) => premise.includes(e.id)).map((e) => e.id));
    expect(ids(box.nextStates)).toEqual(m.elements.filter((e) => next.includes(e.id)).map((e) => e.id));
    // 状態の関係が 1 つも無い操作は両方とも空
    const leaf = boxesOf(m).find((b) => !m.relations.some((r) => (r.kind === "stateUsecase" && r.targetId === b.usecase.id) || (r.kind === "usecaseState" && r.sourceId === b.usecase.id)));
    expect(leaf).toBeDefined();
    expect(leaf!.premiseStates).toEqual([]);
    expect(leaf!.nextStates).toEqual([]);
  });

  it("複数はモデルの順。同じ相手に関係が重なっても 1 つ。存在しない相手・種類の違う相手は無視する", () => {
    let m = sample();
    const base = boxOf(m, "uc_search_reservation");
    const before = base.premiseStates.length;
    const nextBefore = base.nextStates.length;
    const extra = m.elements.find((e) => e.kind === "state" && !base.premiseStates.some((x) => x.id === e.id))!;
    m = okModel(addRelation(m, { sourceId: extra.id, targetId: "uc_search_reservation" }));
    m = { ...m, relations: [...m.relations, { id: "rel_dup_p", kind: "stateUsecase", sourceId: extra.id, targetId: "uc_search_reservation" } as never, { id: "rel_ghost_p", kind: "stateUsecase", sourceId: "st_nothing", targetId: "uc_search_reservation" } as never, { id: "rel_wrong_n", kind: "usecaseState", sourceId: "uc_search_reservation", targetId: "info_reservation" } as never] };
    const box = boxOf(m, "uc_search_reservation");
    expect(box.premiseStates).toHaveLength(before + 1);
    const order = m.elements.map((e) => e.id);
    const idx = box.premiseStates.map((x) => order.indexOf(x.id));
    expect(idx).toEqual([...idx].sort((a, b) => a - b));
    // 種類の違う相手 (情報) への「次の状態」は無視するので、次の状態の件数は変わらない
    expect(box.nextStates).toHaveLength(nextBefore);
    expect(box.nextStates.every((x) => x.kind === "state")).toBe(true);
  });

  it("作業に結ばれていない操作にも入る。同じ操作が複数の作業の行に出るときは、どの行にも同じ状態が入る", () => {
    let m = sample();
    const st = m.elements.find((e) => e.kind === "state")!;
    m = okModel(addRelation(m, { sourceId: "uc_calc_charge", targetId: st.id }));
    const unlinked = buildOperationBoard(m).unlinkedOperations.find((b) => b.usecase.id === "uc_calc_charge")!;
    expect(ids(unlinked.nextStates)).toContain(st.id);
    const rows = boxesOf(m).filter((b) => b.usecase.id === "uc_search_reservation");
    expect(rows.length).toBeGreaterThan(1);
    for (const b of rows) expect(ids(b.premiseStates)).toEqual(ids(rows[0]!.premiseStates));
  });
});

describe("条件の行に添える代替パターンの文 (alternateText)", () => {
  const m = sample();
  const byId = new Map(m.elements.map((e) => [e.id, e]));
  const text = (a: Parameters<typeof alternateText>[0], changesState = true) => alternateText(a, byId, changesState);

  it("いつ (満たすとき・満たさないとき) → どうなるか (全文) → そのあとの状態の順。「代替パターンあり」の前置きは出さない", () => {
    const met = text({ when: "met", then: "予約を受けず、別の日か別の部屋タイプを案内する。", after: { type: "unchanged" } });
    expect(met).toBe("満たすとき: 予約を受けず、別の日か別の部屋タイプを案内する。(状態は変わらない)");
    expect(text({ when: "unmet", then: "ロビーで待ってもらう。", after: { type: "unchanged" } })).toBe("満たさないとき: ロビーで待ってもらう。(状態は変わらない)");
    expect(met).not.toContain("代替パターン");
    // 長い文も省略しない
    const long = "あ".repeat(300);
    expect(text({ when: "met", then: long, after: { type: "unchanged" } })).toContain(long);
  });

  it("そのあとの状態の各種類: ふだんと同じ・特定の状態 (状態グループつき。複数は「・」)・未定・存在しない状態だけなら未定", () => {
    expect(text({ when: "met", then: "取り消す。", after: { type: "normal" } })).toBe("満たすとき: 取り消す。(そのあとの状態: ふだんと同じ)");
    expect(text({ when: "met", then: "確定する。", after: { type: "states", stateIds: ["st_res_confirmed"] } })).toBe(`満たすとき: 確定する。(そのあとの状態: ${stateLabel(byId.get("st_res_confirmed") as never)})`);
    expect(text({ when: "met", then: "確定する。", after: { type: "states", stateIds: ["st_res_confirmed"] } })).toContain("(予約の状態)");
    expect(text({ when: "met", then: "x", after: { type: "states", stateIds: ["st_res_confirmed", "st_room_inuse"] } })).toContain("・");
    expect(text({ when: "met", then: "x" })).toBe("満たすとき: x (そのあとの状態は未定)");
    expect(text({ when: "met", then: "x", after: { type: "states", stateIds: ["st_nothing"] } })).toBe("満たすとき: x (そのあとの状態は未定)");
  });

  it("どうなるかが空なら「(どうなるかは未入力)」。エラーのときは結果の種類と、状態は変わらない旨を添える。起きる出来事があれば添える", () => {
    expect(text({ when: "met", then: "  " })).toBe("満たすとき: (どうなるかは未入力) (そのあとの状態は未定)");
    expect(text({ when: "unmet", then: "エラーにする。", error: { type: "input" } })).toBe("満たさないとき: エラーにする。(結果: 入力エラー、状態は変わらない)");
    expect(text({ when: "met", then: "x", error: { type: "server", status: 404 } })).toContain("サーバーエラー 404");
    expect(text({ when: "met", then: "通知する。", eventId: "ev_charge_calculated", after: { type: "unchanged" } })).toBe("満たすとき: 通知する。(出来事: 請求金額が計算された)(状態は変わらない)");
    // 括弧は文が句読点で終わっていればつなげ、終わっていなければ空白を 1 つ入れる
    expect(text({ when: "met", then: "案内する", after: { type: "unchanged" } })).toBe("満たすとき: 案内する (状態は変わらない)");
    // 存在しない出来事の参照は無視する
    expect(text({ when: "met", then: "x", eventId: "ev_nothing", after: { type: "unchanged" } })).toBe("満たすとき: x (状態は変わらない)");
  });

  it("操作が状態を変えない (次の状態が無い) ときは、そのあとの状態が未定でも何も添えない。変えるときは「未定」を添える。名前を引けない状態だけなら未定扱い", () => {
    expect(text({ when: "met", then: "案内する。" }, false)).toBe("満たすとき: 案内する。");
    expect(text({ when: "met", then: "案内する。" }, true)).toBe("満たすとき: 案内する。(そのあとの状態は未定)");
    expect(text({ when: "met", then: "x", after: { type: "states", stateIds: ["st_nothing"] } }, false)).toBe("満たすとき: x");
    // 決めているものは、操作が状態を変えなくても出す
    expect(text({ when: "met", then: "案内する。", after: { type: "unchanged" } }, false)).toBe("満たすとき: 案内する。(状態は変わらない)");
    // 条件のデータでは、次の状態が無い操作の代替パターンに「未定」が付かない
    const boxes = buildOperationBoard(m).frames.flatMap((f) => f.rows.flatMap((r) => r.operations));
    for (const b of boxes) for (const c of b.conditions) if (c.alternate && !c.alternate.after && !c.alternate.error && b.nextStates.length === 0) expect(c.alternateText).not.toContain("未定");
    const noNext = boxes.find((b) => b.nextStates.length === 0 && b.conditions.length === 0)!;
    const mm = { ...m, relations: m.relations.map((r) => r) };
    const cond = m.elements.find((e) => e.kind === "condition")!;
    const added = okModel(addRelation(mm, { sourceId: noNext.usecase.id, targetId: cond.id }));
    const withAlt = { ...added, relations: added.relations.map((r) => (r.kind === "usecaseCondition" && r.sourceId === noNext.usecase.id && r.targetId === cond.id ? { ...r, alternate: { when: "met" as const, then: "案内する。" } } : r)) };
    const e = buildOperationBoard(withAlt).frames.flatMap((f) => f.rows.flatMap((r) => r.operations)).find((b) => b.usecase.id === noNext.usecase.id)!.conditions.find((x) => x.condition.id === cond.id)!;
    expect(e.alternateText).toBe("満たすとき: 案内する。");
  });

  it("操作の枠の条件のデータに、文 (alternateText) が入る。代替パターンの無い条件・操作に結ばれていない条件には入らない", () => {
    const boxes = buildOperationBoard(m).frames.flatMap((f) => f.rows.flatMap((r) => r.operations));
    const entry = boxes.find((b) => b.usecase.id === "uc_register_reservation")!.conditions.find((x) => x.condition.id === "cond_full")!;
    expect(entry.alternateText).toBe("満たすとき: 予約を受けず、別の日か別の部屋タイプを案内する。(状態は変わらない)");
    const lone = okModel(addElement(m, { kind: "condition", name: "宙の条件", id: "cond_float" }));
    expect(buildOperationBoard(lone).unlinkedConditions.every((x) => x.alternateText === undefined)).toBe(true);
    const added = okModel(addOperationElement(m, "condition", "uc_register_reservation"));
    const e2 = buildOperationBoard(added).frames.flatMap((f) => f.rows.flatMap((r) => r.operations)).find((b) => b.usecase.id === "uc_register_reservation")!.conditions.find((x) => x.condition.name === "新しい条件")!;
    expect(e2.alternateText).toBeUndefined();
  });
});
