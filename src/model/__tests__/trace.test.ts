import { describe, expect, it } from "vitest";
import { addElement, addRelation, moveActivity, removeRelation } from "../commands";
import { traceToActors } from "../trace";
import { okModel, sample } from "./helpers";

describe("traceToActors", () => {
  it("サンプルはすべての要素がアクター / 外部アクターに辿り着く", () => {
    const r = traceToActors(sample());
    expect(r.problems).toEqual([]);
    expect(r.total).toBeGreaterThan(40);
  });

  it("担当も業務も無い作業は途切れ箇所。その作業だけが使う操作・情報は、その作業で途切れている", () => {
    let m = sample();
    m = okModel(addElement(m, { kind: "activity", name: "孤立した作業", id: "act_x" }));
    m = okModel(addElement(m, { kind: "usecase", name: "孤立した操作", id: "uc_x" }));
    m = okModel(addElement(m, { kind: "information", name: "孤立した情報", id: "info_x" }));
    m = okModel(addRelation(m, { sourceId: "act_x", targetId: "uc_x" }));
    m = okModel(addRelation(m, { sourceId: "uc_x", targetId: "info_x" }));
    const r = traceToActors(m);
    expect(r.problems.map((p) => [p.elementId, p.isBreak, p.breakIds])).toEqual([
      ["act_x", true, ["act_x"]],
      ["uc_x", false, ["act_x"]],
      ["info_x", false, ["act_x"]],
    ]);
    expect(r.problems[0]!.reason).toMatch(/担当のアクターがおらず/);
    expect(r.problems[1]!.reason).toMatch(/作業「孤立した作業」から先が途切れています/);
    // 作業を業務に入れると、業務の主担当を通って辿り着く
    m = okModel(moveActivity(m, { activityId: "act_x", bucId: "buc_dining" }));
    expect(traceToActors(m).problems).toEqual([]);
  });

  it("主担当のいない業務は途切れ箇所で、担当のいない作業もその業務で途切れる", () => {
    let m = sample();
    m = okModel(addElement(m, { kind: "business", name: "新業務", id: "biz_x" }));
    m = okModel(addElement(m, { kind: "buc", name: "新活動", id: "buc_x", init: { businessId: "biz_x" } }));
    m = okModel(addElement(m, { kind: "activity", name: "新作業", id: "act_x", init: { bucId: "buc_x" } }));
    const r = traceToActors(m);
    expect(r.problems.map((p) => [p.elementId, p.isBreak, p.breakIds])).toEqual([
      ["biz_x", true, ["biz_x"]],
      ["buc_x", false, ["biz_x"]],
      ["act_x", false, ["biz_x"]],
    ]);
    // 作業に担当を付ければ作業は辿り着く (業務と活動は主担当がいないので途切れたまま)
    m = okModel(addRelation(m, { sourceId: "actor_front", targetId: "act_x" }));
    expect(traceToActors(m).problems.map((p) => p.elementId)).toEqual(["biz_x", "buc_x"]);
  });

  it("コンテキスト・システム・バリエーション・状態・条件も、つながりが無ければ途切れ箇所", () => {
    let m = sample();
    for (const kind of ["context", "system", "variation", "state", "condition"] as const) {
      m = okModel(addElement(m, { kind, name: kind, id: `x_${kind}` }));
    }
    const r = traceToActors(m);
    expect(r.problems.every((p) => p.isBreak)).toBe(true);
    const reasonOf = (id: string) => r.problems.find((p) => p.elementId === id)?.reason;
    expect(reasonOf("x_context")).toBe("情報が入っていません");
    expect(reasonOf("x_system")).toBe("どの情報の取得元・保存先にもなっていません");
    expect(reasonOf("x_variation")).toBe("どの情報・条件の種別にもなっていません");
    expect(reasonOf("x_state")).toBe("どの操作・条件ともつながっていません");
    expect(reasonOf("x_condition")).toBe("どの操作の判断にも使われていません");
  });

  it("関連する情報どうしでつながっているだけなら、両方を途切れ箇所にする", () => {
    let m = sample();
    m = okModel(addElement(m, { kind: "information", name: "A", id: "info_a" }));
    m = okModel(addElement(m, { kind: "information", name: "B", id: "info_b" }));
    m = okModel(addRelation(m, { sourceId: "info_a", targetId: "info_b" }));
    const r = traceToActors(m);
    expect(r.problems.map((p) => [p.elementId, p.isBreak])).toEqual([
      ["info_a", true],
      ["info_b", true],
    ]);
    expect(r.problems[0]!.reason).toMatch(/情報「B」も辿り着けません/);
    // 片方が操作に扱われれば、関連を通ってもう片方も辿り着く
    m = okModel(addRelation(m, { sourceId: "uc_record_checkin", targetId: "info_a" }));
    expect(traceToActors(m).problems).toEqual([]);
  });

  it("操作から作業への線を外すと、その操作だけに使われていた要素が途切れる", () => {
    const m0 = sample();
    const rel = m0.relations.find((r) => r.sourceId === "act_clean" && r.kind === "activityUsecase")!;
    const m = okModel(removeRelation(m0, { id: rel.id }));
    const r = traceToActors(m);
    // 清掃状況を更新するは、清掃を指示する・部屋を点検するからも使われているので途切れない
    expect(r.problems.some((p) => p.elementId === rel.targetId)).toBe(false);
  });
});
