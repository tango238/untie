import { describe, expect, it } from "vitest";
import { createHotelSample, createNetshopSample, createRetailSample } from "../../sample";
import { addRelation, ensureDesign, removeRelation, setDatabaseDesign, setEventTiming, updateElement } from "../commands";
import { DEFAULT_DATABASE_ID } from "../design";
import { addScaffold } from "../designData";
import { checkReadiness, READINESS_CONDITIONS, readinessRemaining, type ReadinessConditionId } from "../readiness";
import { emptyModel, type Element, type Relation, type UntieModel } from "../types";
import { validateModel } from "../validate";
import { okModel } from "./helpers";

/** 要素を 1 つ足す (id を決めて足したいので、コマンドを通さない) */
const withElement = (m: UntieModel, element: Record<string, unknown>): UntieModel => ({ ...m, elements: [...m.elements, element as unknown as Element] });
const open = (m: UntieModel, systemId: string) => checkReadiness(m, systemId).conditions.filter((c) => !c.done).map((c) => c.id);
const messages = (m: UntieModel, systemId: string, id: ReadinessConditionId) => checkReadiness(m, systemId).conditions.find((c) => c.id === id)!.items.map((i) => i.message);
const relation = (m: UntieModel, kind: Relation["kind"], sourceId: string, targetId: string) => m.relations.find((r) => r.kind === kind && r.sourceId === sourceId && r.targetId === targetId)!;

/** 条件がすべてそろう、最小のモデル: 担当が 1 つの操作で、1 つの情報をシステムに保存する (画面は使わない) */
function minimal(): UntieModel {
  const m = emptyModel();
  m.elements = [
    { id: "ctx", kind: "context", name: "受付" },
    { id: "actor", kind: "actor", name: "受付係" },
    { id: "sys", kind: "system", name: "受付システム" },
    { id: "biz", kind: "business", name: "受付" },
    { id: "buc", kind: "buc", name: "受付", businessId: "biz", isDefault: true },
    { id: "act", kind: "activity", name: "申し込みを受ける", bucId: "buc" },
    { id: "uc", kind: "usecase", name: "申し込みを登録する" },
    { id: "info", kind: "information", name: "申し込み", contextId: "ctx" },
  ] as Element[];
  const pairs: [Relation["kind"], string, string][] = [
    ["actorBusiness", "actor", "biz"],
    ["actorActivity", "actor", "act"],
    ["activityUsecase", "act", "uc"],
    ["usecaseSystem", "uc", "sys"],
    ["usecaseInformation", "uc", "info"],
  ];
  m.relations = pairs.map(([kind, sourceId, targetId], i) => ({ id: `rel_${i}`, kind, sourceId, targetId }));
  let next = okModel(ensureDesign(m, { systemId: "sys" }));
  next = okModel(setDatabaseDesign(next, { id: DEFAULT_DATABASE_ID, dsl: 'model Application {\n  id String @id\n  name String\n  @@map("申し込み")\n}\n', tables: [{ table: "Application", informationIds: ["info"] }] }));
  return next;
}

describe("checkReadiness: 実装を始める準備", () => {
  it("条件がすべてそろえば、始められる。条件は決まった順に並ぶ", () => {
    const m = minimal();
    expect(validateModel(m).ok).toBe(true);
    const r = checkReadiness(m, "sys");
    expect(r.conditions.map((c) => c.id)).toEqual(READINESS_CONDITIONS.map((c) => c.id));
    expect(r.conditions.filter((c) => !c.done).map((c) => [c.id, c.items.map((i) => i.message)])).toEqual([]);
    expect(r).toMatchObject({ systemId: "sys", ready: true, doneCount: READINESS_CONDITIONS.length });
    expect(readinessRemaining(r)).toBe(0);
  });

  it("分析: 担い手まで辿れない要素は、途切れている箇所だけを数える", () => {
    let m = minimal();
    m = okModel(removeRelation(m, { id: relation(m, "actorActivity", "actor", "act").id }));
    m = okModel(removeRelation(m, { id: relation(m, "actorBusiness", "actor", "biz").id }));
    const r = checkReadiness(m, "sys");
    const analysis = r.conditions.find((c) => c.id === "analysis")!;
    expect(analysis.done).toBe(false);
    // 途切れているのは業務と作業。その下の操作は同じ原因なので数えない
    expect(analysis.items.map((i) => i.target)).toEqual([
      { kind: "element", id: "biz" },
      { kind: "element", id: "act" },
    ]);
    expect(r.ready).toBe(false);
  });

  it("操作: このシステムを対象にした操作が無い・操作が扱う情報が無い", () => {
    let m = minimal();
    m = okModel(removeRelation(m, { id: relation(m, "usecaseInformation", "uc", "info").id }));
    expect(messages(m, "sys", "information")).toEqual(["操作「申し込みを登録する」が扱う情報が決まっていません"]);
    m = okModel(removeRelation(m, { id: relation(m, "usecaseSystem", "uc", "sys").id }));
    expect(messages(m, "sys", "usecases")).toHaveLength(1);
    // 操作が無ければ、操作ごとの条件は数えない
    expect(messages(m, "sys", "information")).toEqual([]);
  });

  it("出どころ: 取得するだけの情報には、保存する操作が要る。きっかけの出来事には、起こす操作か、起きる時期が要る", () => {
    // 宿泊: 料金プランは読むだけで、登録する操作が無い
    const hotel = createHotelSample();
    expect(messages(hotel, "sys_pms", "origins")).toEqual(["情報「料金プラン」を保存する操作がありません (取得するだけで、どこで作られるかが決まっていない)"]);
    // ほかのシステム・帳票の操作が保存していればよい
    let m = withElement(hotel, { id: "uc_plan", kind: "usecase", name: "料金プランを登録する" });
    m = okModel(addRelation(m, { sourceId: "uc_plan", targetId: "sys_accounting" }));
    m = okModel(addRelation(m, { sourceId: "uc_plan", targetId: "info_plan", access: "write" }));
    expect(messages(m, "sys_pms", "origins")).toEqual([]);
    // 出来事
    let e = minimal();
    e = withElement(e, { id: "ev", kind: "event", name: "締め切りになった", contextId: "ctx" });
    e = okModel(addRelation(e, { sourceId: "ev", targetId: "uc" }));
    expect(messages(e, "sys", "origins")).toEqual(["出来事「締め切りになった」がいつ起きるか (起こす操作か、起きる時期) が決まっていません"]);
    expect(messages(okModel(setEventTiming(e, { id: "ev", timing: { type: "scheduled", every: "day", hour: 17, minute: 0 } })), "sys", "origins")).toEqual([]);
    expect(messages(okModel(addRelation(e, { sourceId: "sys", targetId: "ev" })), "sys", "origins")).toEqual([]);
  });

  it("条件と区分: 何で判断するかの無い条件・値の無い区分", () => {
    let m = minimal();
    m = withElement(m, { id: "cond", kind: "condition", name: "定員を超える", contextId: "ctx" });
    m = withElement(m, { id: "var", kind: "variation", name: "申し込みの種類", values: [], contextId: "ctx" });
    m = okModel(addRelation(m, { sourceId: "uc", targetId: "cond" }));
    m = okModel(addRelation(m, { sourceId: "info", targetId: "var" }));
    expect(messages(m, "sys", "rules")).toEqual(["条件「定員を超える」を何で判断するかが決まっていません (説明を書くか、区分・状態と結ぶ)", "区分「申し込みの種類」の値が決まっていません"]);
    // 条件のときにどうなるかは、業務の流れの条件
    expect(messages(m, "sys", "flow")).toHaveLength(1);
    m = okModel(updateElement(m, { id: "cond", patch: { description: "申し込みの人数が、定員の残りより多い" } }));
    m = okModel(updateElement(m, { id: "var", patch: { values: ["個人", "団体"] } }));
    expect(messages(m, "sys", "rules")).toEqual([]);
    // このシステムの操作に関わらない条件・区分は数えない
    m = withElement(m, { id: "var2", kind: "variation", name: "使っていない区分", values: [], contextId: "ctx" });
    expect(messages(m, "sys", "rules")).toEqual([]);
  });

  it("状態: 操作の前提にしている状態に、その状態になる操作が無い", () => {
    let m = createHotelSample();
    expect(messages(m, "sys_pms", "states")).toEqual([]);
    m = okModel(removeRelation(m, { id: relation(m, "usecaseState", "uc_register_reservation", "st_res_tentative").id }));
    expect(messages(m, "sys_pms", "states")).toEqual(["状態「仮予約」になる操作がありません (操作「予約を確定する」の前提)"]);
  });

  it("設計: 設計が無い・画面がサイトマップに無い・情報がテーブルに無い・テーブルがひな形のまま", () => {
    let m = createHotelSample();
    expect(open(m, "sys_pms")).toEqual(["origins", "data", "screens"]);
    expect(messages(m, "sys_pms", "data")).toEqual(["このシステムの設計がまだありません"]);
    m = okModel(ensureDesign(m, { systemId: "sys_pms" }));
    expect(messages(m, "sys_pms", "screens")).toContain("画面「予約の確定画面」がサイトマップに入っていません");
    expect(messages(m, "sys_pms", "data").every((x) => x.includes("どのテーブルにも対応していません"))).toBe(true);
    // ひな形を足しただけでは、まだそろわない (名前が仮で、列が id だけ)
    m = okModel(addScaffold(m, "sys_pms", DEFAULT_DATABASE_ID));
    const data = messages(m, "sys_pms", "data");
    expect(data.some((x) => /^テーブル Table\d+ .*名前が仮のままです$/.test(x))).toBe(true);
    expect(data.some((x) => x.endsWith("id のほかの列がありません"))).toBe(true);
    expect(data.some((x) => x.includes("どのテーブルにも対応していません"))).toBe(false);
  });

  it("設計のあるサンプル: 画面 UI の無い画面を画面ごとに数え、設計の検証の警告も条件に数える", () => {
    const r = checkReadiness(createRetailSample(), "sys_pos");
    expect(r.conditions.filter((c) => !c.done).map((c) => c.id)).toEqual(["screens", "navigation"]);
    const screens = r.conditions.find((c) => c.id === "screens")!;
    expect(screens.items.every((i) => i.message.endsWith("の画面 UI がまだありません"))).toBe(true);
    expect(screens.items.length).toBeGreaterThan(1);
    expect(r.conditions.find((c) => c.id === "navigation")!.items[0]).toMatchObject({ target: { kind: "design", problem: { type: "transitionViaUndecided" } } });
    expect(r.ready).toBe(false);
  });

  it("操作の無いシステム・無いシステムでも落ちない", () => {
    const shop = createNetshopSample();
    expect(open(shop, "sys_cart")).toContain("usecases");
    expect(checkReadiness(shop, "sys_none").ready).toBe(false);
  });
});
