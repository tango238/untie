import { describe, expect, it } from "vitest";
import {
  analysisBoardId,
  ANALYSIS_KINDS,
  informationLocations,
  issueDistribution,
  parseAnalysisBoardId,
  performerWorkList,
  screenInformationTables,
} from "../analysis";
import { addElement, addRelation, removeRelation, setIssueTargets } from "../commands";
import { createNetshopSample } from "../../sample";
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
  it("担い手 (人) ごとに担当する作業を業務・活動の順に並べ、担当の無い作業は最後にまとめる", () => {
    let m = sample();
    const { performers, unassigned } = performerWorkList(m);
    const front = performers.find((p) => p.performer.id === "actor_front")!;
    expect(front.sections.map((s) => [s.business?.name, s.buc?.name ?? null])).toEqual([
      ["チェックイン", null],
      ["滞在中の対応", "客室対応"],
      ["滞在中の対応", "飲食提供"],
      ["滞在中の対応", "追加料金の対応"],
      ["チェックアウト", null],
    ]);
    // システムは作業の担当にならないので並ばない (0.2.0 から)
    expect(performers.some((p) => p.performer.kind === "system")).toBe(false);
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
    // どの作業にも使われていない操作に付いた具体的な課題は、最後の「辿れない」にまとめる
    m = okModel(addElement(m, { kind: "usecase", name: "宙に浮いた操作", id: "uc_x" }));
    m = okModel(addElement(m, { kind: "issue", name: "宙に浮いた課題", id: "issue_x", init: { severity: 1, targetIds: ["uc_x"] } }));
    const dist = issueDistribution(m);
    expect(dist[dist.length - 1]).toMatchObject({ business: null, maxSeverity: 1 });
    // 対象の無い未整理の課題は、業務の表にも「辿れない」にも入れない (別の表で出す)
    const unsorted = okModel(setIssueTargets(m, { issueId: "issue_x", targetIds: [] }));
    expect(issueDistribution(unsorted).some((d) => d.issues.some((i) => i.id === "issue_x"))).toBe(false);
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

describe("画面と情報 (システムごと)", () => {
  it("システムごとに、行は画面、列はその画面が扱う情報。画面の無いシステムは表を作らず並べる", () => {
    const m = createNetshopSample();
    const { tables, systemsWithoutScreens } = screenInformationTables(m);
    expect(tables.map((t) => t.system.name)).toEqual(["モールの管理画面", "販売管理システム", "決済サービス", "会計システム"]);
    expect(systemsWithoutScreens.map((s) => s.name)).toEqual(["自社サイトのカート"]);
    const accounting = tables.find((t) => t.system.id === "sys_accounting")!;
    expect(accounting.rows.map((r) => r.screen.name)).toEqual(["売掛金の消込画面", "月次レポート"]);
    expect(accounting.informations.map((i) => i.name)).toEqual(["売掛金", "入金", "損益計算書 (PL)", "貸借対照表 (BS)"]);
    const report = accounting.rows.find((r) => r.screen.id === "scr_monthly_report")!;
    expect([...report.cells]).toEqual([
      ["info_pl", "ok"],
      ["info_bs", "ok"],
    ]);
    // 画面を使う操作を添える
    expect(report.usecases.map((u) => u.name)).toEqual(["損益計算書を見る", "貸借対照表を見る", "月次の数字を報告する"]);
  });

  it("画面が扱う情報がそのシステムの置き場所に無ければ noPlace、情報を扱わない画面は noInformation", () => {
    let m = sample();
    m = okModel(addElement(m, { kind: "screen", name: "チェックイン画面", id: "scr_a", init: { systemId: "sys_pms" } }));
    m = okModel(addElement(m, { kind: "screen", name: "空の画面", id: "scr_b", init: { systemId: "sys_pms" } }));
    // 宿泊管理システムは予約を取得・保存する。清掃記録は清掃チェック表 (紙) にだけある
    m = okModel(addRelation(m, { sourceId: "scr_a", targetId: "info_reservation" }));
    m = okModel(addRelation(m, { sourceId: "scr_a", targetId: "info_cleaning_record" }));
    const pms = screenInformationTables(m).tables.find((t) => t.system.id === "sys_pms")!;
    const a = pms.rows.find((r) => r.screen.id === "scr_a")!;
    expect(a.cells.get("info_reservation")).toBe("ok");
    expect(a.cells.get("info_cleaning_record")).toBe("noPlace");
    expect(a.noInformation).toBe(false);
    expect(pms.rows.find((r) => r.screen.id === "scr_b")!.noInformation).toBe(true);
  });
});
