import { describe, expect, it } from "vitest";
import {
  analysisBoardId,
  ANALYSIS_KINDS,
  informationLocations,
  issueDistribution,
  parseAnalysisBoardId,
  performerWorkList,
} from "../analysis";
import { addElement, removeRelation, setIssueTargets } from "../commands";
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
    // 登場人物が対象の全体的な課題は、業務の表にも「辿れない」にも入れない
    const overall = okModel(setIssueTargets(m, { issueId: "issue_x", targetIds: ["actor_front"] }));
    expect(issueDistribution(overall).some((d) => d.issues.some((i) => i.id === "issue_x"))).toBe(false);
    // 作業から操作への線を外すと、操作に付いた課題はその業務から外れる
    const rel = m.relations.find((x) => x.sourceId === "act_change_cancel" && x.targetId === "uc_cancel_reservation")!;
    m = okModel(removeRelation(m, { id: rel.id }));
    const res2 = issueDistribution(m).find((x) => x.business?.id === "biz_reservation")!;
    expect(res2.spots.some((s) => s.element.id === "uc_cancel_reservation")).toBe(false);
  });
});
