import { describe, expect, it } from "vitest";
import {
  analysisBoardId,
  ANALYSIS_KINDS,
  businessContextMatrix,
  contextCoupling,
  informationLocations,
  issueDistribution,
  pairKey,
  parseAnalysisBoardId,
  performerWorkList,
  workFlow,
} from "../analysis";
import { addElement, addRelation, removeRelation } from "../commands";
import { okModel, sample } from "./helpers";

const names = (xs: { name: string }[]) => xs.map((x) => x.name);

describe("分析ボードの id", () => {
  it("種類と相互に変換できる", () => {
    for (const k of ANALYSIS_KINDS) expect(parseAnalysisBoardId(analysisBoardId(k))).toBe(k);
    expect(parseAnalysisBoardId("fixed:activity")).toBeNull();
    expect(parseAnalysisBoardId("analysis:nope")).toBeNull();
  });
});

describe("担当別の作業一覧", () => {
  it("担い手ごとに担当する作業を業務・活動の順に並べ、担当の無い作業は最後にまとめる", () => {
    let m = sample();
    const { performers, unassigned } = performerWorkList(m);
    const front = performers.find((p) => p.performer.id === "actor_front")!;
    expect(front.sections.map((s) => [s.business?.name, s.buc?.name ?? null])).toEqual([
      ["チェックイン", null],
      ["滞在中の対応", null],
      ["滞在中の対応", "客室対応"],
      ["滞在中の対応", "飲食提供"],
      ["チェックアウト", null],
    ]);
    expect(names(performers.find((p) => p.performer.id === "sys_pms")!.sections.flatMap((s) => s.activities))).toEqual(["宿泊料金を計算する"]);
    expect(unassigned).toEqual([]);
    m = okModel(addElement(m, { kind: "activity", name: "担当なし", id: "act_x" }));
    expect(performerWorkList(m).unassigned.map((s) => names(s.activities))).toEqual([["担当なし"]]);
  });
});

describe("業務とコンテキストの結合", () => {
  it("業務ごとに、作業 → 操作 → 情報 と辿ったコンテキストの道筋を集め、列ごとにつながる行を数える", () => {
    const r = businessContextMatrix(sample(), "business");
    expect(r.rows.map((x) => x.label)).toEqual(["予約受付", "チェックイン", "滞在中の対応", "チェックアウト", "清掃・準備"]);
    expect(r.columns.map((c) => c.label)).toEqual(["予約", "顧客", "客室", "料金"]);
    const cell = r.cells.get("biz_reservation|ctx_reservation")!;
    expect(new Set(cell.map((p) => p.usecaseId)).size).toBe(5);
    expect(r.cells.has("biz_reservation|ctx_room")).toBe(false);
    expect(r.columnReach.get("ctx_reservation")).toBe(3);
  });

  it("活動ごとでは、業務に直接属する作業は業務の行 (選ぶのは業務)、活動は活動の行にする", () => {
    const r = businessContextMatrix(sample(), "buc");
    const def = r.rows.find((x) => x.label === "チェックイン")!;
    expect(def).toMatchObject({ elementId: "biz_checkin", sub: "業務 (活動なし)" });
    expect(r.rows.some((x) => x.id === "buc_dining")).toBe(true);
  });

  it("未分類の情報があれば「未分類」の列を足す", () => {
    let m = okModel(addElement(sample(), { kind: "information", name: "x", id: "info_x" }));
    m = okModel(addRelation(m, { sourceId: "uc_record_payment", targetId: "info_x" }));
    const cols = businessContextMatrix(m, "business").columns;
    expect(cols[cols.length - 1]).toEqual({ id: "__none", label: "未分類" });
  });
});

describe("コンテキストの結合", () => {
  it("所属要素どうしの関係を、同じコンテキストなら凝集、違えば結合として数える", () => {
    const r = contextCoupling(sample());
    expect(r.pairs.get(pairKey("ctx_reservation", "ctx_customer"))?.length).toBe(1);
    expect(r.pairs.get(pairKey("ctx_customer", "ctx_reservation"))?.length).toBe(1);
    const room = r.cohesion.get("ctx_room")!;
    expect(room.internal).toBeGreaterThan(room.external);
    expect(r.cohesion.get("ctx_customer")).toEqual({ internal: 0, external: 1 });
  });
});

describe("情報の所在", () => {
  it("取得元・保存先を並べ、紙だけ・保存先が複数・置き場所なしに印を付ける", () => {
    let m = sample();
    const r = informationLocations(m);
    const row = (id: string) => r.rows.find((x) => x.information.id === id)!;
    expect(row("info_reservation").places.get("sys_pms")).toEqual(["source", "store"]);
    expect(row("info_cleaning_record").flags).toEqual(["paperOnly"]);
    expect(row("info_guest").flags).toEqual(["multipleStores"]);
    m = okModel(addElement(m, { kind: "information", name: "x", id: "info_x" }));
    expect(informationLocations(m).rows.find((x) => x.information.id === "info_x")!.flags).toEqual(["noPlace"]);
  });
});

describe("作業の流れ", () => {
  it("作業ごとに担当・操作・情報・条件・状態の遷移を並べる", () => {
    const r = workFlow(sample());
    const res = r.find((x) => x.section.business?.id === "biz_reservation")!;
    const change = res.rows.find((x) => x.activity.id === "act_change_cancel")!;
    const cancel = change.usecases.find((u) => u.usecase.id === "uc_cancel_reservation")!;
    expect(names(change.performers)).toEqual(["予約担当", "宿泊客"]);
    expect(names(cancel.conditions)).toEqual(["取消料が発生する"]);
    expect(names(cancel.fromStates)).toEqual(["確定"]);
    expect(names(cancel.toStates)).toEqual(["取消"]);
  });
});

describe("課題の分布", () => {
  it("業務・その作業・作業が使う操作に付いた課題を業務ごとに重要度順に集める。どこにも辿れない課題は最後", () => {
    let m = sample();
    const r = issueDistribution(m);
    const res = r.find((x) => x.business?.id === "biz_reservation")!;
    expect(res.issues.map((i) => i.severity)).toEqual([5, 2]);
    expect(res.maxSeverity).toBe(5);
    expect(r.find((x) => x.business?.id === "biz_checkout")!.issues).toEqual([]);
    m = okModel(addElement(m, { kind: "issue", name: "宙に浮いた課題", id: "issue_x", init: { severity: 1 } }));
    const dist = issueDistribution(m);
    expect(dist[dist.length - 1]).toMatchObject({ business: null, maxSeverity: 1 });
    // 作業から操作への線を外すと、操作に付いた課題はその業務から外れる
    const rel = m.relations.find((x) => x.sourceId === "act_change_cancel" && x.targetId === "uc_cancel_reservation")!;
    m = okModel(removeRelation(m, { id: rel.id }));
    const res2 = issueDistribution(m).find((x) => x.business?.id === "biz_reservation")!;
    expect(res2.spots.some((s) => s.element.id === "uc_cancel_reservation")).toBe(false);
  });
});
