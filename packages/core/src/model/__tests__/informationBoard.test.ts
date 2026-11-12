import { describe, expect, it } from "vitest";
import { addElement, addRelation, removeElement, removeRelation } from "../commands";
import { addInformationBoardElement, buildInformationBoard } from "../informationBoard";
import { addOperationElement, buildOperationBoard } from "../operationBoard";
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

  it("状態: 条件の状態参照・操作の実行可/次の状態・代替パターンのそのあとの状態を数える", () => {
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
    expect(ids(buildOperationBoard(lone).unlinkedConditions)).toContain("cond_float");
    // 存在しない操作から結ばれた条件も失われない
    const ghost = { ...lone, relations: [...lone.relations, { id: "rel_ghost_c", kind: "usecaseCondition", sourceId: "uc_nothing", targetId: "cond_float" } as never] };
    expect(ids(buildOperationBoard(ghost).unlinkedConditions)).toContain("cond_float");
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
